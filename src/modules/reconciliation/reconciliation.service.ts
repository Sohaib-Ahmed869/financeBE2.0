import type { Model } from 'mongoose';
import { Types } from 'mongoose';
import { getTenantModelsFor } from '../../db/tenant';
import { audit } from '../../lib/audit';
import { NotFoundError } from '../../lib/errors';
import type { MatchHistoricalInput, ResolveDiscrepancyInput } from './reconciliation.validators';

interface ActorMeta {
  userId: string;
  email: string;
  ip: string;
}

function monthBounds(yearMonth: string): { from: Date; to: Date } {
  const [year, month] = yearMonth.split('-').map(Number);
  const from = new Date(Date.UTC(year, month - 1, 1));
  const to = new Date(Date.UTC(year, month, 1)); // exclusive upper bound
  return { from, to };
}

function detectMethod(raw: Record<string, unknown>): string {
  if (Number(raw.CashSum ?? 0) > 0) return 'cash';
  if (raw.CheckAccount) return 'cheque';
  if (Number(raw.TransferSum ?? 0) > 0) return 'bank';
  const cards = raw.PaymentCreditCards;
  if (Array.isArray(cards) && cards.length > 0) return 'card';
  return 'unknown';
}

/**
 * Walks all SAP Payment docs for the given month and creates PaymentMatch rows
 * (sapPaymentDocEntry side) from each Payment.PaymentInvoices entry that doesn't
 * already have one. Also creates Discrepancy records where SumApplied diverges
 * materially from the invoice's balance at the time of matching.
 *
 * Idempotent — safe to call multiple times for the same month.
 */
export async function seedSapNativeMatches(
  companyKey: string,
  yearMonth: string,
  actor: ActorMeta,
): Promise<{ created: number; existing: number; discrepanciesCreated: number }> {
  const models = await getTenantModelsFor(companyKey);
  const { from, to } = monthBounds(yearMonth);

  const payments = await (models.Payment as unknown as Model<Record<string, unknown>>)
    .find({
      DocDate: { $gte: from, $lt: to },
      Cancelled: { $ne: 'tYES' },
    })
    .lean();

  let created = 0;
  let existing = 0;
  let discrepanciesCreated = 0;

  // Build a set of invoice DocEntries we'll need to check balances for.
  const allInvoiceDocEntries = new Set<number>();
  for (const raw of payments) {
    const p = raw as Record<string, unknown>;
    const lines = (p.PaymentInvoices ?? []) as Array<Record<string, unknown>>;
    for (const ln of lines) {
      if (ln.DocEntry != null) allInvoiceDocEntries.add(Number(ln.DocEntry));
    }
  }

  const InvModel = models.Invoice as unknown as Model<Record<string, unknown>>;
  const invoiceDocs = allInvoiceDocEntries.size
    ? ((await InvModel.find(
        { DocEntry: { $in: Array.from(allInvoiceDocEntries) } },
        { DocEntry: 1, DocTotal: 1, PaidToDate: 1 },
      ).lean()) as Array<Record<string, unknown>>)
    : [];

  const invBalanceByDocEntry = new Map<number, number>();
  for (const inv of invoiceDocs) {
    const docEntry = Number(inv.DocEntry);
    const balance = +(Number(inv.DocTotal ?? 0) - Number(inv.PaidToDate ?? 0)).toFixed(2);
    invBalanceByDocEntry.set(docEntry, balance);
  }

  for (const raw of payments) {
    const p = raw as Record<string, unknown>;
    const sapDocEntry = Number(p.DocEntry);
    const lines = (p.PaymentInvoices ?? []) as Array<Record<string, unknown>>;

    for (const ln of lines) {
      const invoiceDocEntry = Number(ln.DocEntry);
      const sumApplied = Number(ln.SumApplied ?? 0);

      // Check if a non-reverted match already exists for this pair.
      const already = await models.PaymentMatch.findOne({
        sapPaymentDocEntry: sapDocEntry,
        invoiceDocEntry,
        reverted: false,
      }).lean();

      if (already) {
        existing++;
        continue;
      }

      await models.PaymentMatch.create({
        sapPaymentDocEntry: sapDocEntry,
        invoiceDocEntry,
        appliedAmount: sumApplied,
        appliedCurrency: String(p.DocCurrency ?? 'EUR'),
        confidence: 1,
        matchedBy: 'system',
        matchedVia: 'sap-native',
        matchedAt: new Date(),
      });
      created++;

      // Create a discrepancy if sumApplied diverges from the invoice balance
      // by more than 1 EUR (rounding noise).
      const balance = invBalanceByDocEntry.get(invoiceDocEntry) ?? null;
      if (balance !== null && Math.abs(sumApplied - balance) > 1) {
        const alreadyDisc = await models.Discrepancy.findOne({
          type: 'amount-mismatch',
          'subjects.id': String(sapDocEntry),
          status: { $in: ['open', 'in-review'] },
        }).lean();

        if (!alreadyDisc) {
          await models.Discrepancy.create({
            type: 'amount-mismatch',
            subjects: [
              { kind: 'sap-payment', id: String(sapDocEntry) },
              { kind: 'invoice', id: String(invoiceDocEntry) },
            ],
            amount: sumApplied,
            currency: String(p.DocCurrency ?? 'EUR'),
            cardCode: String(p.CardCode ?? ''),
            cardName: String(p.CardName ?? ''),
            occurredOn: p.DocDate instanceof Date ? p.DocDate : new Date(String(p.DocDate ?? '')),
            status: 'open',
            priority: 'medium',
            metadata: { sumApplied, invoiceBalance: balance, delta: +(sumApplied - balance).toFixed(2) },
          });
          discrepanciesCreated++;
        }
      }
    }

    // SAP payment with no invoice links at all — create an unmatched-payment discrepancy.
    if (lines.length === 0) {
      const alreadyDisc = await models.Discrepancy.findOne({
        type: 'unmatched-payment',
        'subjects.id': String(sapDocEntry),
        status: { $in: ['open', 'in-review'] },
      }).lean();

      if (!alreadyDisc) {
        await models.Discrepancy.create({
          type: 'unmatched-payment',
          subjects: [{ kind: 'sap-payment', id: String(sapDocEntry) }],
          amount: Number(p.CashSum ?? 0) || Number(p.TransferSum ?? 0),
          currency: String(p.DocCurrency ?? 'EUR'),
          cardCode: String(p.CardCode ?? ''),
          cardName: String(p.CardName ?? ''),
          occurredOn: p.DocDate instanceof Date ? p.DocDate : new Date(String(p.DocDate ?? '')),
          status: 'open',
          priority: 'medium',
        });
        discrepanciesCreated++;
      }
    }
  }

  await audit({
    action: 'reconciliation.seed',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    companyKey,
    after: { yearMonth, created, existing, discrepanciesCreated },
    ip: actor.ip,
  });

  return { created, existing, discrepanciesCreated };
}

export interface SapPaymentRecon {
  docEntry: number;
  docNum: number | null;
  docDate: string | null;
  cardCode: string;
  cardName: string;
  docCurrency: string;
  totalAmount: number;
  method: string;
  /** Invoice links as recorded in SAP's PaymentInvoices array. */
  sapLinks: Array<{
    invoiceDocEntry: number;
    invoiceDocNum: number | null;
    sumApplied: number;
    invoiceTotal: number | null;
    invoiceBalance: number | null;
    hasDiscrepancy: boolean;
  }>;
  /** Our local PaymentMatch rows for this SAP payment. */
  ourMatches: Array<{
    invoiceDocEntry: number;
    appliedAmount: number;
    matchedVia: string;
    matchedBy: string;
  }>;
  status: 'matched' | 'partial' | 'unmatched' | 'on-account';
}

export interface InvoiceRecon {
  docEntry: number;
  docNum: number | null;
  cardCode: string;
  cardName: string;
  docDate: string | null;
  docTotal: number;
  paidToDate: number;
  balance: number;
  documentStatus: string;
  unpaidFlag: boolean;
  /** SAP-side payment links (from Payment.PaymentInvoices reverse-lookup). */
  sapPayments: Array<{
    paymentDocEntry: number;
    paymentDocNum: number | null;
    sumApplied: number;
  }>;
  /** Our local PaymentMatch rows for this invoice (sap-native side). */
  ourMatches: Array<{
    paymentType: 'sap-native' | 'our-entry';
    matchedVia: string;
    appliedAmount: number;
  }>;
  status: 'paid' | 'partial' | 'open' | 'non-paye';
}

export interface MonthReconResult {
  yearMonth: string;
  seeded: boolean;
  payments: SapPaymentRecon[];
  invoices: InvoiceRecon[];
  summary: {
    totalSapPayments: number;
    matchedPayments: number;
    unmatchedPayments: number;
    onAccountPayments: number;
    totalInvoices: number;
    paidInvoices: number;
    openInvoices: number;
    amountDiscrepancies: number;
  };
}

export async function getMonthRecon(
  companyKey: string,
  yearMonth: string,
): Promise<MonthReconResult> {
  const models = await getTenantModelsFor(companyKey);
  const { from, to } = monthBounds(yearMonth);

  const [sapPaymentsRaw, invoicesRaw] = await Promise.all([
    (models.Payment as unknown as Model<Record<string, unknown>>)
      .find({ DocDate: { $gte: from, $lt: to }, Cancelled: { $ne: 'tYES' } })
      .lean(),
    (models.Invoice as unknown as Model<Record<string, unknown>>)
      .find({ DocDate: { $gte: from, $lt: to } })
      .lean(),
  ]);

  const sapPayDocEntries = sapPaymentsRaw.map((p) => Number((p as Record<string, unknown>).DocEntry));
  const invDocEntries = invoicesRaw.map((i) => Number((i as Record<string, unknown>).DocEntry));

  // Load all non-reverted PaymentMatch rows for SAP payments in this month.
  const ourMatchesByPayment = new Map<number, Array<{ invoiceDocEntry: number; appliedAmount: number; matchedVia: string; matchedBy: string }>>();
  const ourMatchesByInvoice = new Map<number, Array<{ paymentType: 'sap-native' | 'our-entry'; matchedVia: string; appliedAmount: number }>>();

  if (sapPayDocEntries.length > 0 || invDocEntries.length > 0) {
    const allMatches = await models.PaymentMatch.find({
      $or: [
        { sapPaymentDocEntry: { $in: sapPayDocEntries } },
        { invoiceDocEntry: { $in: invDocEntries } },
      ],
      reverted: false,
    }).lean();

    for (const m of allMatches) {
      if (m.sapPaymentDocEntry != null) {
        const key = m.sapPaymentDocEntry;
        const list = ourMatchesByPayment.get(key) ?? [];
        list.push({
          invoiceDocEntry: m.invoiceDocEntry,
          appliedAmount: m.appliedAmount,
          matchedVia: m.matchedVia,
          matchedBy: m.matchedBy,
        });
        ourMatchesByPayment.set(key, list);
      }

      const invKey = m.invoiceDocEntry;
      const iList = ourMatchesByInvoice.get(invKey) ?? [];
      iList.push({
        paymentType: m.sapPaymentDocEntry != null ? 'sap-native' : 'our-entry',
        matchedVia: m.matchedVia,
        appliedAmount: m.appliedAmount,
      });
      ourMatchesByInvoice.set(invKey, iList);
    }
  }

  // Check whether seeding has been done (any sap-native match for this month).
  const seeded =
    (await models.PaymentMatch.countDocuments({
      sapPaymentDocEntry: { $in: sapPayDocEntries },
      matchedVia: 'sap-native',
      reverted: false,
    })) > 0;

  // Index invoices for quick lookup when building sapLinks.
  const invIndex = new Map<number, Record<string, unknown>>();
  for (const inv of invoicesRaw) {
    invIndex.set(Number((inv as Record<string, unknown>).DocEntry), inv as Record<string, unknown>);
  }

  // Also need DocNum for invoice sapLinks — load any invoices referenced by
  // PaymentInvoices that might be outside the month's date range.
  const referencedOutsideMonth = new Set<number>();
  for (const raw of sapPaymentsRaw) {
    const p = raw as Record<string, unknown>;
    const lines = (p.PaymentInvoices ?? []) as Array<Record<string, unknown>>;
    for (const ln of lines) {
      const de = Number(ln.DocEntry);
      if (!invIndex.has(de)) referencedOutsideMonth.add(de);
    }
  }
  if (referencedOutsideMonth.size > 0) {
    const extras = await (models.Invoice as unknown as Model<Record<string, unknown>>)
      .find({ DocEntry: { $in: Array.from(referencedOutsideMonth) } }, { DocEntry: 1, DocNum: 1, DocTotal: 1, PaidToDate: 1 })
      .lean();
    for (const inv of extras) {
      invIndex.set(Number((inv as Record<string, unknown>).DocEntry), inv as Record<string, unknown>);
    }
  }

  // Load open discrepancy count for amount-mismatch involving these payments.
  const discrepancySapIds = new Set(
    (
      await models.Discrepancy.find({
        type: 'amount-mismatch',
        'subjects.kind': 'sap-payment',
        'subjects.id': { $in: sapPayDocEntries.map(String) },
        status: { $in: ['open', 'in-review'] },
      })
        .select({ subjects: 1 })
        .lean()
    )
      .flatMap((d) => d.subjects)
      .filter((s) => s.kind === 'sap-payment')
      .map((s) => Number(s.id)),
  );

  // Build SAP payments view.
  const paymentsOut: SapPaymentRecon[] = sapPaymentsRaw.map((raw) => {
    const p = raw as Record<string, unknown>;
    const sapDocEntry = Number(p.DocEntry);
    const lines = (p.PaymentInvoices ?? []) as Array<Record<string, unknown>>;

    const sapLinks = lines.map((ln) => {
      const invDocEntry = Number(ln.DocEntry);
      const sumApplied = Number(ln.SumApplied ?? 0);
      const invRaw = invIndex.get(invDocEntry);
      const invTotal = invRaw ? Number(invRaw.DocTotal ?? 0) : null;
      const invBalance = invRaw
        ? +(Number(invRaw.DocTotal ?? 0) - Number(invRaw.PaidToDate ?? 0)).toFixed(2)
        : null;
      return {
        invoiceDocEntry: invDocEntry,
        invoiceDocNum: invRaw ? (Number(invRaw.DocNum ?? 0) || null) : null,
        sumApplied,
        invoiceTotal: invTotal,
        invoiceBalance: invBalance,
        hasDiscrepancy:
          invBalance !== null && Math.abs(sumApplied - invBalance) > 1,
      };
    });

    const ourMatches = ourMatchesByPayment.get(sapDocEntry) ?? [];

    let status: SapPaymentRecon['status'];
    if (sapLinks.length === 0 && ourMatches.length === 0) {
      status = 'unmatched';
    } else if (sapLinks.length === 0 && ourMatches.length > 0) {
      status = 'matched'; // matched manually via our system
    } else if (
      sapLinks.some((l) => l.hasDiscrepancy) ||
      discrepancySapIds.has(sapDocEntry)
    ) {
      status = 'partial';
    } else {
      status = 'matched';
    }

    // "On-account" = payment exists in SAP but no invoice links and it's
    // normal (e.g. advance payment). We can't reliably distinguish from
    // "unmatched" without more SAP context, so keep as unmatched.
    const docDate = p.DocDate instanceof Date
      ? (p.DocDate as Date).toISOString().slice(0, 10)
      : p.DocDate
        ? String(p.DocDate).slice(0, 10)
        : null;

    return {
      docEntry: sapDocEntry,
      docNum: p.DocNum != null ? Number(p.DocNum) : null,
      docDate,
      cardCode: String(p.CardCode ?? ''),
      cardName: String(p.CardName ?? ''),
      docCurrency: String(p.DocCurrency ?? 'EUR'),
      totalAmount:
        Number(p.CashSum ?? 0) +
        Number(p.TransferSum ?? 0) +
        (
          ((p.PaymentCreditCards as Array<Record<string, unknown>> | undefined) ?? []).reduce(
            (s, c) => s + Number(c.CreditSum ?? 0),
            0,
          )
        ),
      method: detectMethod(p),
      sapLinks,
      ourMatches,
      status,
    };
  });

  // Build invoice view.
  // Build reverse lookup: invoice DocEntry → SAP payments that hit it.
  const sapPaysByInvoice = new Map<
    number,
    Array<{ paymentDocEntry: number; paymentDocNum: number | null; sumApplied: number }>
  >();
  for (const raw of sapPaymentsRaw) {
    const p = raw as Record<string, unknown>;
    const lines = (p.PaymentInvoices ?? []) as Array<Record<string, unknown>>;
    for (const ln of lines) {
      const invDE = Number(ln.DocEntry);
      const list = sapPaysByInvoice.get(invDE) ?? [];
      list.push({
        paymentDocEntry: Number(p.DocEntry),
        paymentDocNum: p.DocNum != null ? Number(p.DocNum) : null,
        sumApplied: Number(ln.SumApplied ?? 0),
      });
      sapPaysByInvoice.set(invDE, list);
    }
  }

  const invoicesOut: InvoiceRecon[] = invoicesRaw.map((raw) => {
    const inv = raw as Record<string, unknown>;
    const docEntry = Number(inv.DocEntry);
    const docTotal = Number(inv.DocTotal ?? 0);
    const paidToDate = Number(inv.PaidToDate ?? 0);
    const balance = +(docTotal - paidToDate).toFixed(2);
    const docStatus = String(inv.DocumentStatus ?? '');
    const isClosed = docStatus === 'bost_Close' || docStatus === 'C';
    const unpaidFlag = Boolean(inv.unpaidFlag);

    let status: InvoiceRecon['status'];
    if (unpaidFlag) {
      status = 'non-paye';
    } else if (isClosed || balance <= 0.01) {
      status = 'paid';
    } else if (paidToDate > 0) {
      status = 'partial';
    } else {
      status = 'open';
    }

    const docDate = inv.DocDate instanceof Date
      ? (inv.DocDate as Date).toISOString().slice(0, 10)
      : inv.DocDate
        ? String(inv.DocDate).slice(0, 10)
        : null;

    return {
      docEntry,
      docNum: inv.DocNum != null ? Number(inv.DocNum) : null,
      cardCode: String(inv.CardCode ?? ''),
      cardName: String(inv.CardName ?? ''),
      docDate,
      docTotal,
      paidToDate,
      balance,
      documentStatus: docStatus,
      unpaidFlag,
      sapPayments: sapPaysByInvoice.get(docEntry) ?? [],
      ourMatches: ourMatchesByInvoice.get(docEntry) ?? [],
      status,
    };
  });

  // Summary.
  const summary = {
    totalSapPayments: paymentsOut.length,
    matchedPayments: paymentsOut.filter((p) => p.status === 'matched').length,
    unmatchedPayments: paymentsOut.filter((p) => p.status === 'unmatched').length,
    onAccountPayments: paymentsOut.filter((p) => p.status === 'on-account').length,
    totalInvoices: invoicesOut.length,
    paidInvoices: invoicesOut.filter((i) => i.status === 'paid').length,
    openInvoices: invoicesOut.filter((i) => i.status === 'open' || i.status === 'partial').length,
    amountDiscrepancies: paymentsOut.filter((p) =>
      p.sapLinks.some((l) => l.hasDiscrepancy),
    ).length,
  };

  return { yearMonth, seeded, payments: paymentsOut, invoices: invoicesOut, summary };
}

/**
 * Manually link a SAP payment to an invoice. Creates a PaymentMatch
 * (sapPaymentDocEntry side). Reverts any prior active manual match for this
 * SAP payment before creating the new one so there's at most one live manual
 * link at a time (sap-native links from seeding are left intact).
 */
export async function reconcileHistoricalPayment(
  companyKey: string,
  sapDocEntry: number,
  input: MatchHistoricalInput,
  actor: ActorMeta,
) {
  const models = await getTenantModelsFor(companyKey);

  // Verify the SAP payment exists.
  const payment = await (models.Payment as unknown as Model<Record<string, unknown>>)
    .findOne({ DocEntry: sapDocEntry })
    .lean();
  if (!payment) throw new NotFoundError('SAP Payment');

  // Revert prior manual matches only (leave sap-native seeded links alone).
  await models.PaymentMatch.updateMany(
    {
      sapPaymentDocEntry: sapDocEntry,
      matchedVia: 'manual',
      reverted: false,
    },
    {
      $set: {
        reverted: true,
        revertedAt: new Date(),
        revertedByEmail: actor.email,
        revertReason: 'replaced',
      },
    },
  );

  const match = await models.PaymentMatch.create({
    sapPaymentDocEntry: sapDocEntry,
    invoiceDocEntry: input.invoiceDocEntry,
    appliedAmount: input.appliedAmount ?? 0,
    appliedCurrency: 'EUR',
    confidence: 1,
    matchedBy: 'user',
    matchedVia: 'manual',
    matchedByUserEmail: actor.email,
    matchedAt: new Date(),
  });

  await audit({
    action: 'reconciliation.historical.match',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    subjectType: 'SapPayment',
    subjectId: String(sapDocEntry),
    companyKey,
    after: {
      sapDocEntry,
      invoiceDocEntry: input.invoiceDocEntry,
      appliedAmount: input.appliedAmount,
    },
    ip: actor.ip,
  });

  return match.toObject();
}

export async function resolveDiscrepancy(
  companyKey: string,
  discrepancyId: string,
  input: ResolveDiscrepancyInput,
  actor: ActorMeta,
) {
  const models = await getTenantModelsFor(companyKey);
  const disc = await models.Discrepancy.findById(new Types.ObjectId(discrepancyId));
  if (!disc) throw new NotFoundError('Discrepancy');

  const resolution = await models.Resolution.create({
    discrepancyId: disc._id,
    action: input.action,
    reason: input.reason ?? '',
    createdMatchIds: [],
    resolvedByEmail: actor.email,
    resolvedAt: new Date(),
    confidence: 1,
  });

  disc.status = input.wontFix ? 'wont-fix' : 'resolved';
  disc.resolutionId = resolution._id as Types.ObjectId;
  disc.resolvedAt = new Date();
  disc.resolvedByEmail = actor.email;
  await disc.save();

  await audit({
    action: 'reconciliation.discrepancy.resolve',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    subjectType: 'Discrepancy',
    subjectId: discrepancyId,
    companyKey,
    after: { action: input.action, wontFix: input.wontFix },
    ip: actor.ip,
  });

  return { discrepancy: disc.toObject(), resolution: resolution.toObject() };
}
