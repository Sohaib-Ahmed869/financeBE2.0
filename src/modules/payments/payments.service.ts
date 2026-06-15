import { Types } from 'mongoose';
import { getTenantModelsFor } from '../../db/tenant';
import { audit } from '../../lib/audit';
import { logger } from '../../lib/logger';
import { AppError, BadRequestError, ConflictError, NotFoundError } from '../../lib/errors';
import {
  PaymentMethods,
  SAP_TABLE_BY_METHOD,
  type IPaymentEntry,
  type PaymentMethod,
} from '../../models/tenant/PaymentEntry';
import {
  buildContext,
  decideMatch,
  AUTO_MATCH_THRESHOLD,
  type MatchDecision,
  type PaymentInput,
} from './payments.matcher';
import { pushPaymentToSap } from './payments.pusher';
import type {
  CreatePaymentInput,
  ListPaymentsQuery,
  ReconcileInput,
  UpdatePaymentInput,
} from './payments.validators';

interface ActorMeta {
  userId: string;
  email: string;
  ip: string;
}

const PAGE_DEFAULT = 100;
const PAGE_MAX = 500;

function dateRangeOf(date?: string): { from: Date; to: Date } | null {
  if (!date) return null;
  const from = new Date(`${date}T00:00:00.000Z`);
  const to = new Date(`${date}T23:59:59.999Z`);
  return { from, to };
}

function buildFilter(opts: ListPaymentsQuery): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  if (opts.date) {
    const range = dateRangeOf(opts.date)!;
    filter.date = { $gte: range.from, $lte: range.to };
  } else if (opts.from || opts.to) {
    const range: Record<string, Date> = {};
    if (opts.from) range.$gte = new Date(`${opts.from}T00:00:00.000Z`);
    if (opts.to) range.$lte = new Date(`${opts.to}T23:59:59.999Z`);
    filter.date = range;
  }
  if (opts.cardCode) filter.cardCode = opts.cardCode.toUpperCase();
  if (opts.method) filter.method = opts.method;
  if (opts.status) filter.status = opts.status;
  return filter;
}

export async function listPayments(companyKey: string, opts: ListPaymentsQuery) {
  const models = await getTenantModelsFor(companyKey);
  const filter = buildFilter(opts);
  const limit = Math.min(Math.max(opts.limit ?? PAGE_DEFAULT, 1), PAGE_MAX);
  const page = Math.max(opts.page ?? 1, 1);

  const [items, total] = await Promise.all([
    models.PaymentEntry.find(filter)
      .sort({ date: -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    models.PaymentEntry.countDocuments(filter),
  ]);

  return {
    items,
    total,
    page,
    limit,
    pages: Math.max(1, Math.ceil(total / limit)),
  };
}

/**
 * Fetch a single day's payments + the live PaymentMatch links so the UI can
 * render reconciliation state in one round trip.
 */
export async function getDay(companyKey: string, date: string) {
  const models = await getTenantModelsFor(companyKey);
  const range = dateRangeOf(date)!;
  const payments = await models.PaymentEntry.find({
    date: { $gte: range.from, $lte: range.to },
  })
    .sort({ createdAt: 1 })
    .lean();

  const ids = payments.map((p) => p._id);
  const matches = ids.length
    ? await models.PaymentMatch.find({
        paymentEntryId: { $in: ids },
        reverted: false,
      }).lean()
    : [];

  const matchesByEntry = new Map<string, (typeof matches)[number][]>();
  for (const m of matches) {
    const key = String(m.paymentEntryId);
    const list = matchesByEntry.get(key) ?? [];
    list.push(m);
    matchesByEntry.set(key, list);
  }

  return {
    date,
    items: payments.map((p) => ({
      ...p,
      matches: matchesByEntry.get(String(p._id)) ?? [],
    })),
  };
}

function methodDetailsFor(input: CreatePaymentInput | UpdatePaymentInput) {
  const out: {
    cheque?: unknown;
    card?: unknown;
    bank?: unknown;
  } = {};
  if (input.method === 'Cheque' && input.cheque) out.cheque = input.cheque;
  if (input.method === 'Bank' && input.bank) out.bank = input.bank;
  if (
    (input.method === 'CB-Site' ||
      input.method === 'CB-Phone' ||
      input.method === 'PayPal') &&
    input.card
  ) {
    out.card = input.card;
  }
  return out;
}

export async function createPayment(
  companyKey: string,
  input: CreatePaymentInput,
  actor: ActorMeta,
) {
  const models = await getTenantModelsFor(companyKey);

  const sapTable = SAP_TABLE_BY_METHOD[input.method];
  const entry = await models.PaymentEntry.create({
    cardCode: input.cardCode.toUpperCase(),
    cardName: input.cardName ?? '',
    date: new Date(`${input.date}T00:00:00.000Z`),
    method: input.method,
    amount: input.amount,
    currency: input.currency,
    ...methodDetailsFor(input),
    sourceType: input.sourceType,
    sourceLineRef: input.sourceLineRef,
    status: 'draft',
    sapTable,
    enteredByEmail: actor.email,
    enteredAt: new Date(),
    notes: input.notes,
    tags: input.tags ?? [],
  });

  await audit({
    action: 'payments.create',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    subjectType: 'PaymentEntry',
    subjectId: entry._id.toString(),
    companyKey,
    after: {
      cardCode: entry.cardCode,
      method: entry.method,
      amount: entry.amount,
      date: input.date,
    },
    ip: actor.ip,
  });

  return entry.toObject();
}

export async function updatePayment(
  companyKey: string,
  id: string,
  input: UpdatePaymentInput,
  actor: ActorMeta,
) {
  const models = await getTenantModelsFor(companyKey);
  const entry = await models.PaymentEntry.findById(id);
  if (!entry) throw new NotFoundError('Payment');
  if (entry.status === 'pushed' || entry.status === 'voided') {
    throw new ConflictError(`Cannot edit a ${entry.status} payment`);
  }

  const before = entry.toObject();
  if (input.cardCode !== undefined) entry.cardCode = input.cardCode.toUpperCase();
  if (input.cardName !== undefined) entry.cardName = input.cardName;
  if (input.date !== undefined) entry.date = new Date(`${input.date}T00:00:00.000Z`);
  if (input.method !== undefined) {
    entry.method = input.method;
    entry.sapTable = SAP_TABLE_BY_METHOD[input.method];
  }
  if (input.amount !== undefined) entry.amount = input.amount;
  if (input.currency !== undefined) entry.currency = input.currency;
  if (input.notes !== undefined) entry.notes = input.notes;
  if (input.tags !== undefined) entry.tags = input.tags;
  // Method-specific subdocs — overwrite cleanly.
  const det = methodDetailsFor(input);
  if (det.cheque !== undefined) entry.cheque = det.cheque as IPaymentEntry['cheque'];
  if (det.card !== undefined) entry.card = det.card as IPaymentEntry['card'];
  if (det.bank !== undefined) entry.bank = det.bank as IPaymentEntry['bank'];

  await entry.save();

  await audit({
    action: 'payments.update',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    subjectType: 'PaymentEntry',
    subjectId: entry._id.toString(),
    companyKey,
    before: { cardCode: before.cardCode, method: before.method, amount: before.amount },
    after: { cardCode: entry.cardCode, method: entry.method, amount: entry.amount },
    ip: actor.ip,
  });

  return entry.toObject();
}

export async function getReconciliationForDay(companyKey: string, date: string) {
  const models = await getTenantModelsFor(companyKey);
  const range = dateRangeOf(date)!;

  const entries = await models.PaymentEntry.find({
    date: { $gte: range.from, $lte: range.to },
    status: { $in: ['draft', 'matched', 'failed'] },
  })
    .sort({ createdAt: 1 })
    .lean();

  const inputs: PaymentInput[] = entries.map((e) => ({
    cardCode: e.cardCode,
    amount: e.amount,
    method: e.method as PaymentMethod,
    reference:
      e.method === 'Cheque'
        ? e.cheque?.chequeNumber
        : e.method === 'Bank'
          ? e.bank?.transferReference
          : e.card?.transactionId,
  }));

  const ctx = await buildContext(models, inputs);
  const decisions = inputs.map((p, i) => ({
    paymentEntryId: String(entries[i]._id),
    decision: decideMatch(p, ctx),
  }));

  return { date, decisions };
}

interface AutoMatchSummary {
  date: string;
  matched: number;
  skipped: number;
  results: Array<{
    paymentEntryId: string;
    status: 'matched' | 'skipped';
    reason?: string;
    invoiceDocEntry?: number;
    score?: number;
  }>;
}

export async function autoMatchDay(
  companyKey: string,
  date: string,
  actor: ActorMeta,
): Promise<AutoMatchSummary> {
  const models = await getTenantModelsFor(companyKey);
  const range = dateRangeOf(date)!;

  const entries = await models.PaymentEntry.find({
    date: { $gte: range.from, $lte: range.to },
    status: { $in: ['draft', 'failed'] }, // never re-touch already-matched/pushed
  });

  const inputs: PaymentInput[] = entries.map((e) => ({
    cardCode: e.cardCode,
    amount: e.amount,
    method: e.method as PaymentMethod,
    reference:
      e.method === 'Cheque'
        ? e.cheque?.chequeNumber
        : e.method === 'Bank'
          ? e.bank?.transferReference
          : e.card?.transactionId,
  }));

  const ctx = await buildContext(models, inputs);
  const summary: AutoMatchSummary = { date, matched: 0, skipped: 0, results: [] };

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const decision = decideMatch(inputs[i], ctx);

    if (!decision.proposed || !decision.autoEligible) {
      summary.skipped++;
      summary.results.push({
        paymentEntryId: String(entry._id),
        status: 'skipped',
        reason: decision.exception ?? 'low-confidence',
        score: decision.proposed?.score,
      });
      continue;
    }

    await models.PaymentMatch.create({
      paymentEntryId: entry._id,
      invoiceDocEntry: decision.proposed.invoiceDocEntry,
      appliedAmount: entry.amount,
      appliedCurrency: entry.currency || 'EUR',
      confidence: decision.proposed.score,
      matchedBy: 'system',
      matchedVia: 'rule',
      matchedByUserEmail: actor.email,
    });

    entry.status = 'matched';
    await entry.save();

    summary.matched++;
    summary.results.push({
      paymentEntryId: String(entry._id),
      status: 'matched',
      invoiceDocEntry: decision.proposed.invoiceDocEntry,
      score: decision.proposed.score,
    });
  }

  await audit({
    action: 'payments.autoMatch',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    subjectType: 'PaymentEntryDay',
    subjectId: date,
    companyKey,
    after: { matched: summary.matched, skipped: summary.skipped, threshold: AUTO_MATCH_THRESHOLD },
    ip: actor.ip,
  });

  return summary;
}

export async function reconcilePayment(
  companyKey: string,
  id: string,
  input: ReconcileInput,
  actor: ActorMeta,
) {
  const models = await getTenantModelsFor(companyKey);
  const entry = await models.PaymentEntry.findById(id);
  if (!entry) throw new NotFoundError('Payment');
  if (entry.status === 'pushed' || entry.status === 'voided') {
    throw new ConflictError(`Cannot reconcile a ${entry.status} payment`);
  }

  // Revert any prior live match on this entry — one active match at a time.
  await models.PaymentMatch.updateMany(
    { paymentEntryId: entry._id, reverted: false },
    {
      $set: {
        reverted: true,
        revertedAt: new Date(),
        revertedByEmail: actor.email,
        revertReason: 'replaced',
      },
    },
  );

  // On-account: no invoice link; payment will hit SAP without PaymentInvoices
  // and post against the BP's AR control account.
  if (input.onAccount) {
    entry.onAccount = true;
    entry.status = 'matched';
    await entry.save();
    await audit({
      action: 'payments.reconcile.onAccount',
      actorUserId: actor.userId,
      actorEmail: actor.email,
      subjectType: 'PaymentEntry',
      subjectId: entry._id.toString(),
      companyKey,
      after: { onAccount: true, amount: entry.amount },
      ip: actor.ip,
    });
    return { entry: entry.toObject(), match: null };
  }

  // Clear match (both invoice link and on-account state).
  if (input.invoiceDocEntry === null) {
    entry.onAccount = false;
    entry.status = 'draft';
    await entry.save();
    await audit({
      action: 'payments.unmatch',
      actorUserId: actor.userId,
      actorEmail: actor.email,
      subjectType: 'PaymentEntry',
      subjectId: entry._id.toString(),
      companyKey,
      ip: actor.ip,
    });
    return { entry: entry.toObject(), match: null };
  }

  // Reconcile against a specific invoice.
  const match = await models.PaymentMatch.create({
    paymentEntryId: entry._id,
    invoiceDocEntry: input.invoiceDocEntry,
    appliedAmount: input.appliedAmount ?? entry.amount,
    appliedCurrency: entry.currency || 'EUR',
    confidence: 1,
    matchedBy: 'user',
    matchedVia: input.matchedVia,
    matchedByUserEmail: actor.email,
  });

  entry.onAccount = false;
  entry.status = 'matched';
  await entry.save();

  await audit({
    action: 'payments.reconcile',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    subjectType: 'PaymentEntry',
    subjectId: entry._id.toString(),
    companyKey,
    after: { invoiceDocEntry: input.invoiceDocEntry, amount: match.appliedAmount },
    ip: actor.ip,
  });

  return { entry: entry.toObject(), match: match.toObject() };
}

export async function pushPayment(
  companyKey: string,
  id: string,
  invoiceDocEntryOverride: number | undefined,
  actor: ActorMeta,
) {
  const models = await getTenantModelsFor(companyKey);
  const entry = await models.PaymentEntry.findById(id);
  if (!entry) throw new NotFoundError('Payment');

  if (entry.status === 'pushed' && entry.sapDocEntry) {
    return {
      status: 'skipped' as const,
      reason: 'already-pushed',
      sapDocEntry: entry.sapDocEntry,
    };
  }
  if (entry.status === 'voided') {
    throw new ConflictError('Voided payment cannot be pushed');
  }
  if (entry.method === 'Account') {
    throw new BadRequestError('Non-payé invoices are not pushed to SAP');
  }

  // Determine target invoice — explicit override > active PaymentMatch.
  // On-account payments push without an invoice link (SAP applies them to
  // the customer's AR control account).
  let invoiceDocEntry: number | null = invoiceDocEntryOverride ?? null;
  if (!invoiceDocEntry && !entry.onAccount) {
    const activeMatch = await models.PaymentMatch.findOne({
      paymentEntryId: entry._id,
      reverted: false,
    }).lean();
    invoiceDocEntry = (activeMatch?.invoiceDocEntry as number | undefined) ?? null;
  }
  if (!invoiceDocEntry && !entry.onAccount) {
    throw new BadRequestError(
      'Reconcile to an invoice (or mark on-account) before pushing',
    );
  }
  if (!entry.amount || entry.amount <= 0) {
    throw new BadRequestError('Payment amount must be > 0');
  }

  entry.status = 'push-pending';
  entry.sapPushAttempts = (entry.sapPushAttempts ?? 0) + 1;
  await entry.save();

  try {
    const result = await pushPaymentToSap({
      companyKey,
      entry,
      invoiceDocEntry,
      appliedAmount: entry.amount,
    });

    entry.status = 'pushed';
    entry.sapDocEntry = result.sapDocEntry;
    entry.sapDocNum = result.sapDocNum;
    entry.sapTable = result.sapTable;
    entry.sapPushedAt = new Date();
    entry.sapLastError = '';
    entry.sapLastErrorAt = undefined;
    entry.confirmedByEmail = actor.email;
    entry.confirmedAt = new Date();
    await entry.save();

    // Bind the active PaymentMatch (if any) to the SAP DocEntry.
    await models.PaymentMatch.updateMany(
      { paymentEntryId: entry._id, reverted: false },
      { $set: { sapPaymentDocEntry: result.sapDocEntry } },
    );

    await audit({
      action: 'payments.push',
      actorUserId: actor.userId,
      actorEmail: actor.email,
      subjectType: 'PaymentEntry',
      subjectId: entry._id.toString(),
      companyKey,
      after: {
        sapDocEntry: result.sapDocEntry,
        sapTable: result.sapTable,
        method: entry.method,
        amount: entry.amount,
      },
      ip: actor.ip,
    });

    return {
      status: 'pushed' as const,
      sapDocEntry: result.sapDocEntry,
      sapDocNum: result.sapDocNum,
      sapTable: result.sapTable,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    entry.status = 'failed';
    entry.sapLastError = message;
    entry.sapLastErrorAt = new Date();
    await entry.save();

    logger.error({ err, paymentEntryId: id, companyKey }, 'payments.push.failed');

    await audit({
      action: 'payments.push.failed',
      actorUserId: actor.userId,
      actorEmail: actor.email,
      subjectType: 'PaymentEntry',
      subjectId: entry._id.toString(),
      companyKey,
      after: { error: message },
      ip: actor.ip,
    });

    throw err instanceof AppError
      ? err
      : new AppError(message, 502, 'SAP_REQUEST_FAILED');
  }
}

export async function voidPayment(
  companyKey: string,
  id: string,
  reason: string,
  actor: ActorMeta,
) {
  const models = await getTenantModelsFor(companyKey);
  const entry = await models.PaymentEntry.findById(id);
  if (!entry) throw new NotFoundError('Payment');
  if (entry.status === 'pushed') {
    throw new ConflictError('Pushed payments cannot be voided here — reverse in SAP');
  }
  if (entry.status === 'voided') {
    return entry.toObject();
  }

  await models.PaymentMatch.updateMany(
    { paymentEntryId: entry._id, reverted: false },
    {
      $set: {
        reverted: true,
        revertedAt: new Date(),
        revertedByEmail: actor.email,
        revertReason: 'voided',
      },
    },
  );

  entry.status = 'voided';
  entry.voidedByEmail = actor.email;
  entry.voidedAt = new Date();
  entry.voidReason = reason;
  await entry.save();

  await audit({
    action: 'payments.void',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    subjectType: 'PaymentEntry',
    subjectId: entry._id.toString(),
    companyKey,
    after: { reason },
    ip: actor.ip,
  });

  return entry.toObject();
}

export async function getPaymentById(companyKey: string, id: string) {
  const models = await getTenantModelsFor(companyKey);
  if (!Types.ObjectId.isValid(id)) throw new BadRequestError('Invalid id');
  const entry = await models.PaymentEntry.findById(id).lean();
  if (!entry) throw new NotFoundError('Payment');
  const matches = await models.PaymentMatch.find({
    paymentEntryId: entry._id,
  }).lean();
  return { ...entry, matches };
}

export const SUPPORTED_METHODS = PaymentMethods.slice();
