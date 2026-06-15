import { Types } from 'mongoose';
import { getTenantModelsFor } from '../../db/tenant';
import { audit } from '../../lib/audit';
import { BadRequestError, NotFoundError } from '../../lib/errors';
import { parseBankStatement } from './bankStatements.parser';

interface ActorMeta {
  userId: string;
  email: string;
  ip: string;
}

interface UploadFile {
  originalname: string;
  buffer: Buffer;
  size: number;
}

/** Payment methods we reconcile the bank against, derived from which SAP RCT
 *  sub-table a payment used. */
type SapMethod = 'cash' | 'cheque' | 'bank' | 'card';

const CATEGORY_BY_METHOD: Record<SapMethod, string> = {
  cash: 'cash-deposit',
  cheque: 'cheque-deposit',
  bank: 'sepa-credit',
  card: 'card-settlement',
};

const TOLERANCE = 0.01;

const dayKey = (d: Date): string => d.toISOString().slice(0, 10);

export async function uploadStatement(
  companyKey: string,
  file: UploadFile,
  meta: { bankKey: string; accountLabel?: string },
  actor: ActorMeta,
) {
  if (!file?.buffer || file.size === 0) throw new BadRequestError('Empty upload');
  if (!meta.bankKey) throw new BadRequestError('bankKey required (e.g. "bred", "lcl")');

  const parsed = parseBankStatement({
    originalname: file.originalname,
    buffer: file.buffer,
  });
  if (parsed.lines.length === 0) {
    throw new BadRequestError(
      `No usable rows found in the file. Warnings: ${parsed.warnings.join('; ') || '(none)'}`,
    );
  }

  const dates = parsed.lines.map((l) => new Date(`${l.operationDate}T00:00:00.000Z`));
  const periodStart = new Date(Math.min(...dates.map((d) => d.getTime())));
  const periodEnd = new Date(Math.max(...dates.map((d) => d.getTime())));

  const models = await getTenantModelsFor(companyKey);

  const stmt = await models.BankStatement.create({
    bankKey: meta.bankKey.toLowerCase(),
    accountLabel: meta.accountLabel ?? '',
    periodStart,
    periodEnd,
    status: 'parsed',
    linesParsedCount: parsed.lines.length,
    uploadedByEmail: actor.email,
    uploadedAt: new Date(),
    parsedAt: new Date(),
  });

  // Idempotent inserts: skip lines whose fingerprint already exists for this
  // statement. (Re-uploads of the same file just no-op.)
  let inserted = 0;
  for (const l of parsed.lines) {
    try {
      await models.BankStatementLine.create({
        statementId: stmt._id,
        operationDate: new Date(`${l.operationDate}T00:00:00.000Z`),
        valueDate: l.valueDate ? new Date(`${l.valueDate}T00:00:00.000Z`) : null,
        amount: l.amount,
        direction: l.direction,
        description: l.description,
        counterparty: l.counterparty,
        reference: l.reference,
        balanceAfter: l.balanceAfter,
        envelopeNumber: l.envelopeNumber,
        fingerprint: l.fingerprint,
        status: 'unmatched',
      });
      inserted++;
    } catch (err) {
      // Duplicate key on the unique partial index → already-imported row, fine.
      if (!String(err).includes('duplicate key')) throw err;
    }
  }

  await audit({
    action: 'bankStatement.upload',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    subjectType: 'BankStatement',
    subjectId: stmt._id.toString(),
    companyKey,
    after: {
      bank: meta.bankKey,
      lines: parsed.lines.length,
      inserted,
      periodStart: periodStart.toISOString().slice(0, 10),
      periodEnd: periodEnd.toISOString().slice(0, 10),
    },
    ip: actor.ip,
  });

  return {
    id: stmt._id.toString(),
    bankKey: stmt.bankKey,
    periodStart: stmt.periodStart,
    periodEnd: stmt.periodEnd,
    linesParsed: parsed.lines.length,
    linesInserted: inserted,
    warnings: parsed.warnings,
  };
}

export async function listStatements(companyKey: string) {
  const models = await getTenantModelsFor(companyKey);
  const items = await models.BankStatement.find({})
    .sort({ periodStart: -1 })
    .lean();
  return {
    items: items.map((s) => ({
      id: s._id.toString(),
      bankKey: s.bankKey,
      accountLabel: s.accountLabel ?? '',
      periodStart: s.periodStart,
      periodEnd: s.periodEnd,
      status: s.status,
      linesParsedCount: s.linesParsedCount,
      linesMatchedCount: s.linesMatchedCount,
      uploadedByEmail: s.uploadedByEmail,
      uploadedAt: s.createdAt,
    })),
  };
}

interface LineFilter {
  status?: 'unmatched' | 'matched' | 'tagged' | 'ignored' | 'flagged';
  direction?: 'credit' | 'debit';
}

export async function getStatement(
  companyKey: string,
  id: string,
  filter: LineFilter,
) {
  const models = await getTenantModelsFor(companyKey);
  const stmt = await models.BankStatement.findById(new Types.ObjectId(id)).lean();
  if (!stmt) throw new NotFoundError('BankStatement');
  const q: Record<string, unknown> = { statementId: stmt._id };
  if (filter.status) q.status = filter.status;
  if (filter.direction) q.direction = filter.direction;
  const lines = await models.BankStatementLine.find(q)
    .sort({ operationDate: 1 })
    .lean();
  return {
    statement: {
      id: stmt._id.toString(),
      bankKey: stmt.bankKey,
      accountLabel: stmt.accountLabel ?? '',
      periodStart: stmt.periodStart,
      periodEnd: stmt.periodEnd,
      status: stmt.status,
      linesParsedCount: stmt.linesParsedCount,
      linesMatchedCount: stmt.linesMatchedCount,
      uploadedByEmail: stmt.uploadedByEmail,
      uploadedAt: stmt.createdAt,
      reconciledAt: stmt.reconciledAt ?? null,
      methodReconciliation: (stmt.methodReconciliation ?? []).map((r) => ({
        date: r.date,
        method: r.method,
        expectedFromSap: r.expectedFromSap ?? 0,
        foundInBank: r.foundInBank ?? 0,
        status: r.status,
      })),
    },
    lines: lines.map((l) => ({
      id: l._id.toString(),
      operationDate: l.operationDate,
      valueDate: l.valueDate ?? null,
      amount: l.amount,
      direction: l.direction,
      description: l.description,
      counterparty: l.counterparty ?? '',
      reference: l.reference ?? '',
      balanceAfter: l.balanceAfter ?? null,
      envelopeNumber: l.envelopeNumber ?? null,
      category: l.category,
      status: l.status,
      tags: l.tags ?? [],
      matchedMethod: l.matchedMethod ?? null,
      matchedSettlementDate: l.matchedSettlementDate ?? null,
      matchedSapPaymentDocEntry: l.matchedSapPaymentDocEntry ?? null,
      matchedCardCode: l.matchedCardCode ?? null,
    })),
  };
}

/** Classify a cached SAP payment by which RCT sub-table it used. */
function classifySapMethod(p: {
  PaymentChecks?: unknown[];
  PaymentCreditCards?: unknown[];
  TransferSum?: number;
  TransferAccount?: string;
  CashSum?: number;
}): SapMethod | null {
  if (Array.isArray(p.PaymentChecks) && p.PaymentChecks.length > 0) return 'cheque';
  if (Array.isArray(p.PaymentCreditCards) && p.PaymentCreditCards.length > 0) return 'card';
  if ((p.TransferSum ?? 0) > 0 || p.TransferAccount) return 'bank';
  if ((p.CashSum ?? 0) > 0) return 'cash';
  return null;
}

function sapPaymentAmount(p: {
  DocTotal?: number;
  CashSum?: number;
  TransferSum?: number;
}): number {
  return p.DocTotal ?? p.CashSum ?? p.TransferSum ?? 0;
}

interface MethodTotal {
  date: Date;
  method: SapMethod;
  total: number;
  docEntries: number[];
}

/**
 * Aggregate the payments already reconciled into SAP into **daily totals per
 * payment method** over (period ± window). This is what the bank statement is
 * verified against — never invoices. Pure read of the SAP `Payment` cache.
 */
async function buildSapMethodTotals(
  models: Awaited<ReturnType<typeof getTenantModelsFor>>,
  periodStart: Date,
  periodEnd: Date,
  windowDays: number,
): Promise<Map<string, MethodTotal>> {
  const pad = windowDays * 24 * 3600 * 1000;
  const payments = (await models.Payment.find({
    DocDate: {
      $gte: new Date(periodStart.getTime() - pad),
      $lte: new Date(periodEnd.getTime() + pad),
    },
    Cancelled: { $ne: 'tYES' },
  })
    .select({
      DocEntry: 1,
      DocTotal: 1,
      DocDate: 1,
      CashSum: 1,
      TransferSum: 1,
      TransferAccount: 1,
      PaymentChecks: 1,
      PaymentCreditCards: 1,
    })
    .lean()) as unknown as Array<{
    DocEntry: number;
    DocTotal?: number;
    DocDate?: Date;
    CashSum?: number;
    TransferSum?: number;
    TransferAccount?: string;
    PaymentChecks?: unknown[];
    PaymentCreditCards?: unknown[];
  }>;

  const totals = new Map<string, MethodTotal>();
  for (const p of payments) {
    if (!(p.DocDate instanceof Date)) continue;
    const method = classifySapMethod(p);
    if (!method) continue;
    const amt = sapPaymentAmount(p);
    if (amt <= 0) continue;
    const key = `${dayKey(p.DocDate)}|${method}`;
    const existing = totals.get(key);
    if (existing) {
      existing.total += amt;
      existing.docEntries.push(p.DocEntry);
    } else {
      totals.set(key, {
        date: new Date(`${dayKey(p.DocDate)}T00:00:00.000Z`),
        method,
        total: amt,
        docEntries: [p.DocEntry],
      });
    }
  }
  return totals;
}

/**
 * Bank reconciliation — the **verification** half of the flow (Idris,
 * 14/05/2026: "the second part of our reconciliation").
 *
 * Entry-time reconciliation already matched payments → invoices and pushed
 * them to SAP. This step does the opposite direction of trust: it confirms the
 * money SAP recorded actually landed in the bank. Bank lines are matched
 * against the **daily total per payment method** of SAP-reconciled payments —
 * NOT against invoices — and:
 *
 *   - **Cash / cheque deposits** also match by envelope number against the
 *     day's deposit slips (the team writes the envelope id on the slip).
 *   - **Bank transfers / card settlements** match against the SAP daily method
 *     total by amount + date.
 *   - A residual line the user later identifies can be tagged with a CardCode
 *     (learned for next time); that's an annotation, not a match.
 *
 * No SAP writes of any kind. Output: per-method/day verification
 * (matched / partial / missing) plus the per-line status.
 */
export async function autoMatchStatement(
  companyKey: string,
  id: string,
  actor: ActorMeta,
) {
  const models = await getTenantModelsFor(companyKey);
  const stmtId = new Types.ObjectId(id);
  const stmt = await models.BankStatement.findById(stmtId).lean();
  if (!stmt) throw new NotFoundError('BankStatement');

  const lines = await models.BankStatementLine.find({ statementId: stmtId }).lean();

  // -------- Cash/cheque deposit slips (envelope + amount) --------
  const slipDays = await models.DaybookDay.find({
    date: { $gte: stmt.periodStart, $lte: stmt.periodEnd },
    $or: [
      { 'remiseBancaire.bankSlipRefs.0': { $exists: true } },
      { 'remiseBancaire.bankSlips.0': { $exists: true } },
    ],
  })
    .select({ date: 1, remiseBancaire: 1 })
    .lean();
  const slipByRef = new Map<string, { date: Date; amount: number | null; kind: string }>();
  for (const d of slipDays) {
    for (const slip of d.remiseBancaire?.bankSlips ?? []) {
      slipByRef.set(slip.ref.toLowerCase().replace(/\s+/g, ''), {
        date: d.date,
        amount: slip.amount ?? null,
        kind: slip.kind ?? 'cash',
      });
    }
    for (const ref of d.remiseBancaire?.bankSlipRefs ?? []) {
      const key = String(ref).toLowerCase().replace(/\s+/g, '');
      if (!slipByRef.has(key)) {
        slipByRef.set(key, { date: d.date, amount: null, kind: 'cash' });
      }
    }
  }

  // -------- SAP daily method totals (the thing we reconcile against) --------
  const methodTotals = await buildSapMethodTotals(
    models,
    stmt.periodStart,
    stmt.periodEnd,
    3,
  );

  // -------- Learned counterparty → CardCode (annotation only) --------
  const learnedRows = (await models.LearnedPattern.find({
    signature: { $regex: /^bank-counterparty\|/ },
    active: true,
  })
    .select({ signature: 1, features: 1 })
    .lean()) as unknown as Array<{
    signature: string;
    features: { counterpartyKey?: string; cardCode?: string };
  }>;
  const learnedByCounterparty = new Map<string, string>();
  for (const lp of learnedRows) {
    const key = lp.features?.counterpartyKey ?? '';
    const cc = lp.features?.cardCode ?? '';
    if (key && cc) learnedByCounterparty.set(key, cc);
  }
  const counterpartyKeyOf = (line: {
    counterparty?: string | null;
    description?: string | null;
  }): string =>
    (line.counterparty || line.description || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);

  const sameDay = (a: Date | null | undefined, b: Date, daysAround = 3): boolean => {
    if (!a) return false;
    return Math.abs(a.getTime() - b.getTime()) <= daysAround * 24 * 3600 * 1000;
  };

  // Bank-side sum found against each SAP method-total, keyed `day|method`.
  const foundByKey = new Map<string, number>();
  const addFound = (method: SapMethod, settlement: Date, amount: number): void => {
    const key = `${dayKey(settlement)}|${method}`;
    foundByKey.set(key, (foundByKey.get(key) ?? 0) + amount);
  };

  let matched = 0;
  let envelopeMatched = 0;
  let methodMatched = 0;
  let learnedTagged = 0;
  let categorized = 0;

  for (const l of lines) {
    const updates: Record<string, unknown> = {};
    let resolved = false;

    // 1. Cash/cheque deposit slip — by envelope ref (+ amount when present).
    if (!resolved && l.envelopeNumber) {
      const key = l.envelopeNumber.toLowerCase().replace(/\s+/g, '');
      const slip = slipByRef.get(key);
      if (slip && (slip.amount === null || Math.abs(slip.amount - l.amount) <= TOLERANCE)) {
        const method: SapMethod = slip.kind === 'cheques' ? 'cheque' : 'cash';
        updates.category = CATEGORY_BY_METHOD[method];
        updates.matchedMethod = method;
        updates.matchedSettlementDate = slip.date;
        updates.status = 'matched';
        addFound(method, slip.date, l.amount);
        envelopeMatched++;
        matched++;
        resolved = true;
      }
    }
    // Cash deposit that lost its envelope ref — match by amount + near date.
    if (!resolved && l.direction === 'credit') {
      for (const [ref, slip] of slipByRef) {
        if (slip.amount === null) continue;
        if (Math.abs(slip.amount - l.amount) > TOLERANCE) continue;
        if (!sameDay(slip.date, l.operationDate, 3)) continue;
        const method: SapMethod = slip.kind === 'cheques' ? 'cheque' : 'cash';
        updates.category = CATEGORY_BY_METHOD[method];
        updates.matchedMethod = method;
        updates.matchedSettlementDate = slip.date;
        updates.reference = l.reference || `slip:${ref}`;
        updates.status = 'matched';
        addFound(method, slip.date, l.amount);
        envelopeMatched++;
        matched++;
        resolved = true;
        break;
      }
    }

    // 2. SAP daily method total — by amount + near date. This is the core of
    //    the verification: does a bank credit line up with what SAP says was
    //    taken that day for that method?
    if (!resolved && l.direction === 'credit') {
      for (const mt of methodTotals.values()) {
        if (Math.abs(mt.total - l.amount) > TOLERANCE) continue;
        if (!sameDay(mt.date, l.operationDate, 3)) continue;
        updates.category = CATEGORY_BY_METHOD[mt.method];
        updates.matchedMethod = mt.method;
        updates.matchedSettlementDate = mt.date;
        if (mt.docEntries.length === 1) {
          updates.matchedSapPaymentDocEntry = mt.docEntries[0];
        }
        updates.status = 'matched';
        addFound(mt.method, mt.date, l.amount);
        methodMatched++;
        matched++;
        resolved = true;
        break;
      }
    }

    // 3. Learned counterparty → CardCode. Annotation only; the line stays
    //    unverified (status 'tagged') until a SAP figure backs it.
    if (!resolved) {
      const cc = learnedByCounterparty.get(counterpartyKeyOf(l));
      if (cc) {
        updates.matchedCardCode = cc;
        updates.status = 'tagged';
        learnedTagged++;
        resolved = true;
      }
    }

    // 4. Loose category fallback for anything still unmatched. Reads the BRED/SG
    //    "Type de l'opération" label (folded into the description by the XLS/OFX
    //    parsers) as well as free-text memos.
    if (!resolved) {
      const d = (l.description ?? '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '');
      // Card settlements (Sogecommerce CB via Transactis) — "REMISE CARTE BANCAIRE".
      if (/sogecommerce|transactis|remise\s*(carte|cb)|remise\s*c\.?b/.test(d))
        updates.category = 'card-settlement';
      else if (/paypal/.test(d)) updates.category = 'paypal';
      // Cash deposits — "VERSEMENT D'ESPECE".
      else if (/versement.*espece|remise.*espece|depot.*espece/.test(d))
        updates.category = 'cash-deposit';
      // Cheque deposits — "REMISE CHEQUE(S)".
      else if (/remise.*cheque|remise.*chq/.test(d)) updates.category = 'cheque-deposit';
      // Fees / commissions / charges — "COMMISSION …", "FRAIS …", "COTISATION".
      else if (/frais|fee|cotisation|commission|interets?\b/.test(d)) updates.category = 'fee';
      // Incoming transfers — "VIREMENT … RECU".
      else if (/(virement|vir)\b.*(recu|received)|sepa\s*credit/.test(d))
        updates.category = 'sepa-credit';
      // Outgoing transfers / direct debits — "VIREMENT … EMIS", "PRELEVEMENT SEPA".
      else if (/(virement|vir)\b.*(emis|emi)|prelevement|sepa\s*debit/.test(d))
        updates.category = 'sepa-debit';
      else if (/virement|\bvir\b/.test(d))
        updates.category = l.direction === 'credit' ? 'sepa-credit' : 'sepa-debit';
      else if (l.direction === 'debit') updates.category = 'expense';
      if (Object.keys(updates).length > 0) categorized++;
    }

    if (Object.keys(updates).length > 0) {
      await models.BankStatementLine.updateOne({ _id: l._id }, { $set: updates });
    }
  }

  // -------- Verification summary: SAP expectation vs. what the bank showed --
  const methodReconciliation = [...methodTotals.values()]
    .filter((mt) => mt.date >= stmt.periodStart && mt.date <= stmt.periodEnd)
    .map((mt) => {
      const found = foundByKey.get(`${dayKey(mt.date)}|${mt.method}`) ?? 0;
      const status: 'matched' | 'partial' | 'missing' =
        Math.abs(found - mt.total) <= TOLERANCE
          ? 'matched'
          : found > 0
            ? 'partial'
            : 'missing';
      return {
        date: mt.date,
        method: mt.method,
        expectedFromSap: Math.round(mt.total * 100) / 100,
        foundInBank: Math.round(found * 100) / 100,
        status,
      };
    })
    .sort((a, b) => a.date.getTime() - b.date.getTime() || a.method.localeCompare(b.method));

  await models.BankStatement.updateOne(
    { _id: stmtId },
    {
      $set: {
        status: 'matched',
        linesMatchedCount: matched,
        methodReconciliation,
        reconciledAt: new Date(),
      },
    },
  );

  await audit({
    action: 'bankStatement.autoMatch',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    subjectType: 'BankStatement',
    subjectId: id,
    companyKey,
    after: {
      matched,
      envelopeMatched,
      methodMatched,
      learnedTagged,
      categorized,
      total: lines.length,
      methodsReconciled: methodReconciliation.length,
      missing: methodReconciliation.filter((r) => r.status !== 'matched').length,
    },
    ip: actor.ip,
  });

  return getStatement(companyKey, id, {});
}

export async function tagLine(
  companyKey: string,
  lineId: string,
  patch: {
    status?: string;
    tags?: string[];
    notes?: string;
    category?: string;
    /** SAP CardCode this bank line belongs to. Persists a counterparty → CardCode
     *  mapping in LearnedPattern so the next upload auto-fills lines with the
     *  same counterparty/description. Idris's "the system should remember that
     *  for the next time" — 14/05/2026 call. */
    matchedCardCode?: string;
  },
  actor: ActorMeta,
) {
  const models = await getTenantModelsFor(companyKey);
  const line = await models.BankStatementLine.findById(new Types.ObjectId(lineId));
  if (!line) throw new NotFoundError('BankStatementLine');
  if (patch.status) line.status = patch.status as never;
  if (patch.tags) line.tags = patch.tags;
  if (patch.notes !== undefined) line.notes = patch.notes;
  if (patch.category) line.category = patch.category as never;
  if (patch.matchedCardCode !== undefined) {
    line.matchedCardCode = patch.matchedCardCode || null;
  }
  await line.save();

  // Learn the mapping when the user assigns a CardCode to a previously
  // unidentified line. Counterparty key is preferred (cleaner); falls back to
  // a truncated description so we still learn something on banks that don't
  // populate a counterparty column.
  if (patch.matchedCardCode) {
    const counterpartyKey = (line.counterparty || line.description || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
    if (counterpartyKey) {
      const signature = `bank-counterparty|${counterpartyKey}`;
      await models.LearnedPattern.updateOne(
        { signature },
        {
          $set: {
            description: `Bank line "${counterpartyKey}" → ${patch.matchedCardCode}`,
            features: {
              counterpartyKey,
              cardCode: patch.matchedCardCode,
              source: 'bank-statement-tag',
            },
            suggestedAction: 'auto-match',
            confidence: 0.9,
            lastUsedAt: new Date(),
          },
          $inc: { hits: 1 },
          $setOnInsert: { createdAt: new Date(), active: true },
        },
        { upsert: true },
      );
    }
  }

  await audit({
    action: 'bankStatement.tagLine',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    subjectType: 'BankStatementLine',
    subjectId: lineId,
    companyKey,
    after: patch,
    ip: actor.ip,
  });
  return line.toObject();
}
