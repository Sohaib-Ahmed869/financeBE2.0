import { Types } from 'mongoose';
import type { TenantModels } from '../../models/tenant';
import type { IPaymentEntry } from '../../models/tenant/PaymentEntry';
import { buildIncomingPaymentBody as buildPaymentBody } from '../payments/payments.pusher';
import { sapPost } from '../../sap/client';
import { logger } from '../../lib/logger';
import { audit } from '../../lib/audit';
import { AppError } from '../../lib/errors';

/**
 * Phase 4 — push matched LIVRAISONS to SAP as IncomingPayments, ONE per
 * payment method on a row.
 *
 * A livraison can carry up to five method amounts:
 *   - `montant`          → Cheque   (RCT2)
 *   - `montantEspeces`   → Cash     (RCT3)
 *   - `montantCBSite`    → CB-Site  (RCT4)
 *   - `montantCBPhone`   → CB-Phone (RCT4)
 *   - `montantVirement`  → Bank     (RCT1)
 *
 * All postings target the same invoice; SAP clears the invoice across the
 * multiple sub-tables as the totals add up. We re-use the existing per-method
 * body builder from `payments.pusher.ts` rather than re-implementing it here.
 */

type MethodKey = 'Cheque' | 'Cash' | 'CB-Site' | 'CB-Phone' | 'Bank';

interface MethodSlot {
  method: MethodKey;
  amount: number;
  sourceLineRef: string;
}

interface PushableLine {
  index: number;
  codeClient: string;
  clientName: string;
  montant: number | null | undefined;
  banque: string;
  numero: string;
  remarques?: string;
  montantEspeces: number | null | undefined;
  montantCBSite: number | null | undefined;
  montantCBPhone: number | null | undefined;
  montantVirement: number | null | undefined;
  referenceVirement?: string;
  match: {
    status?: string;
    invoiceDocEntry?: number | null;
    invoiceDocNum?: number | null;
    sapDocEntry?: number | null;
    pushAttempts?: number;
  };
}

export interface PerMethodOutcome {
  method: MethodKey;
  amount: number;
  sapDocEntry?: number;
  sapDocNum?: number | null;
  paymentEntryId?: string;
  error?: string;
  skipped?: boolean;
  skipReason?: string;
}

export interface RowOutcome {
  index: number;
  status: 'pushed' | 'failed' | 'skipped' | 'partial';
  /** First successfully-posted method's DocEntry — informational marker on the match. */
  sapDocEntry?: number;
  sapDocNum?: number;
  paymentEntryId?: string;
  error?: string;
  reason?: string;
  perMethod: PerMethodOutcome[];
}

export interface PushSummary {
  date: string;
  pushed: number;
  failed: number;
  skipped: number;
  results: RowOutcome[];
}

function methodSlotsFor(line: PushableLine): MethodSlot[] {
  const slots: MethodSlot[] = [];
  const add = (amt: number | null | undefined, method: MethodKey) => {
    if (amt !== null && amt !== undefined && amt > 0) {
      slots.push({ method, amount: amt, sourceLineRef: `${line.index}:${method}` });
    }
  };
  add(line.montant, 'Cheque');
  add(line.montantEspeces, 'Cash');
  add(line.montantCBSite, 'CB-Site');
  add(line.montantCBPhone, 'CB-Phone');
  add(line.montantVirement, 'Bank');
  return slots;
}

interface PushOneMethodArgs {
  companyKey: string;
  isoDate: string;
  dayId: Types.ObjectId;
  models: TenantModels;
  line: PushableLine;
  slot: MethodSlot;
  invoiceDocEntry: number | null;
  actor: { userId: string; email: string };
}

async function pushOneMethod({
  companyKey,
  isoDate,
  dayId,
  models,
  line,
  slot,
  invoiceDocEntry,
  actor,
}: PushOneMethodArgs): Promise<PerMethodOutcome> {
  // Pull the write-through PaymentEntry for this (day, line, method). It was
  // created by `writeThroughPaymentEntries` when the day was saved.
  const paymentEntry = await models.PaymentEntry.findOne({
    sourceFileId: dayId,
    sourceLineRef: slot.sourceLineRef,
    sourceType: 'daybook-import',
  });
  if (!paymentEntry) {
    return {
      method: slot.method,
      amount: slot.amount,
      skipped: true,
      skipReason: 'no-payment-entry',
    };
  }

  // Idempotency — if this method already landed in SAP, don't double-post.
  if (paymentEntry.status === 'pushed' && paymentEntry.sapDocEntry) {
    return {
      method: slot.method,
      amount: slot.amount,
      sapDocEntry: paymentEntry.sapDocEntry,
      sapDocNum: paymentEntry.sapDocNum ?? null,
      paymentEntryId: paymentEntry._id.toString(),
      skipped: true,
      skipReason: 'already-pushed',
    };
  }

  // Refresh from the latest daybook state (in case the line was edited after
  // the day was saved but before push).
  paymentEntry.cardCode = line.codeClient.toUpperCase();
  paymentEntry.cardName = line.clientName ?? '';
  paymentEntry.amount = slot.amount;
  if (slot.method === 'Cheque') {
    paymentEntry.cheque = {
      chequeNumber: line.numero ?? '',
      bankCode: line.banque ?? '',
    } as IPaymentEntry['cheque'];
  } else if (slot.method === 'Bank') {
    paymentEntry.bank = {
      transferReference: line.referenceVirement ?? '',
    } as IPaymentEntry['bank'];
  }

  const remarksPrefix = `Daybook ${isoDate} livraison #${line.index + 1}`;
  const body = buildPaymentBody({
    entry: paymentEntry.toObject(),
    invoiceDocEntry,
    appliedAmount: slot.amount,
    ctx: { isoDate, remarksPrefix },
  });

  try {
    const response = await sapPost<{ DocEntry?: number; DocNum?: number }>(
      companyKey,
      '/IncomingPayments',
      body,
    );
    const sapDocEntry = response?.DocEntry;
    const sapDocNum = response?.DocNum ?? null;
    if (!sapDocEntry) {
      throw new AppError(
        'SAP returned 200 but no DocEntry — refusing to claim a successful push',
        502,
        'SAP_NO_DOCENTRY',
        response,
      );
    }

    paymentEntry.status = 'pushed';
    paymentEntry.sapDocEntry = sapDocEntry;
    paymentEntry.sapDocNum = sapDocNum;
    paymentEntry.sapPushedAt = new Date();
    paymentEntry.sapPushAttempts = (paymentEntry.sapPushAttempts ?? 0) + 1;
    paymentEntry.confirmedByEmail = actor.email;
    paymentEntry.confirmedAt = new Date();
    paymentEntry.sapLastError = '';
    paymentEntry.sapLastErrorAt = undefined as unknown as Date;
    await paymentEntry.save();

    const match = await models.PaymentMatch.create({
      paymentEntryId: paymentEntry._id,
      invoiceDocEntry,
      appliedAmount: slot.amount,
      appliedCurrency: 'EUR',
      confidence: 1,
      matchedBy: 'user',
      matchedVia: 'manual',
      matchedByUserEmail: actor.email,
    });
    await models.PaymentMatch.updateOne(
      { _id: match._id },
      { $set: { sapPaymentDocEntry: sapDocEntry } },
    );

    logger.info(
      `daybook.push ok ${isoDate} #${line.index} method=${slot.method} → SAP DocEntry=${sapDocEntry}`,
    );

    return {
      method: slot.method,
      amount: slot.amount,
      sapDocEntry,
      sapDocNum,
      paymentEntryId: paymentEntry._id.toString(),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { err, companyKey, isoDate, lineIndex: line.index, method: slot.method },
      'daybook.push.failed',
    );
    paymentEntry.status = 'failed';
    paymentEntry.sapPushAttempts = (paymentEntry.sapPushAttempts ?? 0) + 1;
    paymentEntry.sapLastError = message;
    paymentEntry.sapLastErrorAt = new Date();
    try {
      await paymentEntry.save();
    } catch (saveErr) {
      logger.error({ err: saveErr }, 'daybook.push.save_failed');
    }
    return { method: slot.method, amount: slot.amount, error: message };
  }
}

interface PushDayArgs {
  companyKey: string;
  isoDate: string;
  models: TenantModels;
  actor: { userId: string; email: string; ip: string };
  /**
   * Optional restriction — when present, only these line indexes are pushed.
   * Otherwise every eligible row in the day is pushed in declaration order.
   */
  onlyIndexes?: number[];
}

export async function pushMatchedLivraisons({
  companyKey,
  isoDate,
  models,
  actor,
  onlyIndexes,
}: PushDayArgs): Promise<PushSummary> {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  const day = await models.DaybookDay.findOne({ date });
  if (!day) {
    throw new AppError(`No daybook day for ${isoDate}`, 404, 'NOT_FOUND');
  }

  const indexFilter = onlyIndexes ? new Set(onlyIndexes) : null;
  const summary: PushSummary = {
    date: isoDate,
    pushed: 0,
    failed: 0,
    skipped: 0,
    results: [],
  };

  // Sequential — SAP B1 SL doesn't love concurrent writes against the same
  // company DB and we want a deterministic ordering in the result table.
  for (let i = 0; i < day.livraisons.length; i++) {
    if (indexFilter && !indexFilter.has(i)) continue;
    const l = day.livraisons[i];
    const m = (l.match ?? {}) as PushableLine['match'];
    const line: PushableLine = {
      index: i,
      codeClient: l.codeClient,
      clientName: l.clientName,
      montant: l.montant,
      banque: l.banque,
      numero: l.numero,
      remarques: l.remarques,
      montantEspeces: l.montantEspeces,
      montantCBSite: l.montantCBSite,
      montantCBPhone: l.montantCBPhone,
      montantVirement: l.montantVirement,
      referenceVirement: l.referenceVirement,
      match: m,
    };

    if (m.status !== 'manual' && m.status !== 'auto' && m.status !== 'push-failed' && m.status !== 'on-account') {
      summary.results.push({
        index: i,
        status: 'skipped',
        reason: 'not-matched',
        perMethod: [],
      });
      summary.skipped++;
      continue;
    }
    const isOnAccount = m.status === 'on-account';
    if (!m.invoiceDocEntry && !isOnAccount) {
      summary.results.push({
        index: i,
        status: 'skipped',
        reason: 'no-invoice',
        perMethod: [],
      });
      summary.skipped++;
      continue;
    }

    const slots = methodSlotsFor(line);
    if (slots.length === 0) {
      summary.results.push({
        index: i,
        status: 'skipped',
        reason: 'no-amount',
        perMethod: [],
      });
      summary.skipped++;
      continue;
    }

    const perMethod: PerMethodOutcome[] = [];
    let postedAny = false;
    let failedAny = false;
    let firstSuccess: PerMethodOutcome | null = null;

    for (const slot of slots) {
      const outcome = await pushOneMethod({
        companyKey,
        isoDate,
        dayId: day._id as Types.ObjectId,
        models,
        line,
        slot,
        invoiceDocEntry: isOnAccount ? null : (m.invoiceDocEntry ?? null),
        actor,
      });
      perMethod.push(outcome);
      if (outcome.error) failedAny = true;
      if (outcome.sapDocEntry && !outcome.skipped) {
        postedAny = true;
        if (!firstSuccess) firstSuccess = outcome;
      }
      if (outcome.skipped && outcome.sapDocEntry && !firstSuccess) {
        // Already-pushed counts as a known posting for the informational
        // marker on the match row, even though we didn't post it this round.
        firstSuccess = outcome;
      }
    }

    const rowStatus: RowOutcome['status'] = postedAny
      ? failedAny
        ? 'partial'
        : 'pushed'
      : failedAny
        ? 'failed'
        : 'skipped';

    const row: RowOutcome = {
      index: i,
      status: rowStatus,
      perMethod,
      ...(firstSuccess && firstSuccess.sapDocEntry
        ? {
            sapDocEntry: firstSuccess.sapDocEntry,
            sapDocNum: firstSuccess.sapDocNum ?? undefined,
            paymentEntryId: firstSuccess.paymentEntryId,
          }
        : {}),
      ...(rowStatus === 'failed' && perMethod[0]?.error
        ? { error: perMethod[0].error }
        : {}),
      ...(rowStatus === 'skipped' ? { reason: 'no-postable-method' } : {}),
    };
    summary.results.push(row);

    const priorAttempts = (l.match as { pushAttempts?: number })?.pushAttempts ?? 0;
    if (postedAny) {
      day.livraisons[i].match = {
        ...(day.livraisons[i].match ?? {}),
        status: 'pushed',
        sapDocEntry: firstSuccess?.sapDocEntry ?? null,
        sapDocNum: firstSuccess?.sapDocNum ?? null,
        paymentEntryId: firstSuccess?.paymentEntryId
          ? new Types.ObjectId(firstSuccess.paymentEntryId)
          : null,
        pushedAt: new Date(),
        pushAttempts: priorAttempts + 1,
        pushError: failedAny
          ? perMethod.filter((p) => p.error).map((p) => `${p.method}: ${p.error}`).join('; ')
          : '',
        pushErrorAt: failedAny ? new Date() : null,
      } as never;
      if (rowStatus === 'pushed') summary.pushed++;
      else {
        // partial — count as failed at the aggregate level so the UI surfaces
        // the per-method error block without claiming a clean push.
        summary.failed++;
      }
    } else if (failedAny) {
      day.livraisons[i].match = {
        ...(day.livraisons[i].match ?? {}),
        status: 'push-failed',
        pushAttempts: priorAttempts + 1,
        pushError: perMethod
          .filter((p) => p.error)
          .map((p) => `${p.method}: ${p.error}`)
          .join('; '),
        pushErrorAt: new Date(),
      } as never;
      summary.failed++;
    } else {
      summary.skipped++;
    }
  }

  await day.save();

  await audit({
    action: 'daybook.push',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    subjectType: 'DaybookDay',
    subjectId: isoDate,
    companyKey,
    after: {
      pushed: summary.pushed,
      failed: summary.failed,
      skipped: summary.skipped,
    },
    ip: actor.ip,
  });

  return summary;
}
