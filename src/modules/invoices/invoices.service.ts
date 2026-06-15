import type { Model } from 'mongoose';
import { getTenantModelsFor } from '../../db/tenant';
import { sapPost } from '../../sap/client';
import { audit } from '../../lib/audit';
import { logger } from '../../lib/logger';
import { AppError, BadRequestError, NotFoundError } from '../../lib/errors';
import type {
  CreateInvoiceInput,
  ListInvoicesQuery,
  MarkUnpaidInput,
} from './invoices.validators';

interface ActorMeta {
  userId: string;
  email: string;
  ip: string;
}

const PAGE_DEFAULT = 100;
const PAGE_MAX = 500;

function invModel(models: Awaited<ReturnType<typeof getTenantModelsFor>>) {
  return models.Invoice as unknown as Model<Record<string, unknown>>;
}

function dateRangeOf(date?: string) {
  if (!date) return null;
  return {
    from: new Date(`${date}T00:00:00.000Z`),
    to: new Date(`${date}T23:59:59.999Z`),
  };
}

function buildFilter(opts: ListInvoicesQuery): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  if (opts.date) {
    const range = dateRangeOf(opts.date)!;
    filter.DocDate = { $gte: range.from, $lte: range.to };
  } else if (opts.from || opts.to) {
    const range: Record<string, Date> = {};
    if (opts.from) range.$gte = new Date(`${opts.from}T00:00:00.000Z`);
    if (opts.to) range.$lte = new Date(`${opts.to}T23:59:59.999Z`);
    filter.DocDate = range;
  }
  if (opts.cardCode) filter.CardCode = opts.cardCode.toUpperCase();
  if (opts.status === 'open') filter.DocumentStatus = { $in: ['bost_Open', 'O'] };
  else if (opts.status === 'closed') filter.DocumentStatus = { $in: ['bost_Close', 'C'] };
  if (opts.unpaidFlag !== undefined) filter.unpaidFlag = opts.unpaidFlag;
  return filter;
}

export async function listInvoices(companyKey: string, opts: ListInvoicesQuery) {
  const models = await getTenantModelsFor(companyKey);
  const Inv = invModel(models);
  const filter = buildFilter(opts);
  const limit = Math.min(Math.max(opts.limit ?? PAGE_DEFAULT, 1), PAGE_MAX);
  const page = Math.max(opts.page ?? 1, 1);

  const projection = {
    DocEntry: 1,
    DocNum: 1,
    CardCode: 1,
    CardName: 1,
    DocDate: 1,
    DocDueDate: 1,
    DocTotal: 1,
    PaidToDate: 1,
    DocumentStatus: 1,
    DocCurrency: 1,
    Comments: 1,
    OriginatingDeliveryNote: 1,
    unpaidFlag: 1,
    unpaidFlagReason: 1,
    unpaidFlaggedByEmail: 1,
    unpaidFlaggedAt: 1,
  };

  const [items, total] = await Promise.all([
    Inv.find(filter, projection)
      .sort({ DocDate: -1, DocEntry: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Inv.countDocuments(filter),
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
 * Day-view: invoices for one date PLUS:
 *   - active PaymentMatch rows (our local reconciliations)
 *   - SAP payment links (which ORCT payments hit this invoice via RCT2)
 *
 * The SAP links come from the cached `Payment.PaymentInvoices[]` array — the
 * Service Layer ships that inline on every `IncomingPayments` GET, and our
 * Payment sync persists it. The Mongo index on `PaymentInvoices.DocEntry`
 * makes the reverse lookup cheap.
 */
export async function getDay(companyKey: string, date: string) {
  const models = await getTenantModelsFor(companyKey);
  const Inv = invModel(models);
  const range = dateRangeOf(date)!;

  const invoices = await Inv.find(
    { DocDate: { $gte: range.from, $lte: range.to } },
    {
      DocEntry: 1,
      DocNum: 1,
      CardCode: 1,
      CardName: 1,
      DocDate: 1,
      DocDueDate: 1,
      DocTotal: 1,
      PaidToDate: 1,
      DocumentStatus: 1,
      DocCurrency: 1,
      Comments: 1,
      OriginatingDeliveryNote: 1,
      unpaidFlag: 1,
      unpaidFlagReason: 1,
      unpaidFlaggedByEmail: 1,
      unpaidFlaggedAt: 1,
    },
  )
    .sort({ DocEntry: 1 })
    .lean();

  const docEntries = invoices.map((i) => i.DocEntry as number);

  const matches = docEntries.length
    ? await models.PaymentMatch.find({
        invoiceDocEntry: { $in: docEntries },
        reverted: false,
      }).lean()
    : [];

  const sapPayments = docEntries.length
    ? await models.Payment.find({
        'PaymentInvoices.DocEntry': { $in: docEntries },
        Cancelled: { $ne: 'tYES' },
      })
        .select({
          DocEntry: 1,
          DocNum: 1,
          DocDate: 1,
          CardCode: 1,
          CardName: 1,
          DocCurrency: 1,
          PaymentInvoices: 1,
        })
        .lean()
    : [];

  const matchesByInvoice = new Map<number, (typeof matches)[number][]>();
  for (const m of matches) {
    const list = matchesByInvoice.get(m.invoiceDocEntry) ?? [];
    list.push(m);
    matchesByInvoice.set(m.invoiceDocEntry, list);
  }

  // Reverse the SAP application array: per invoice, build the list of SAP
  // payments that touched it with their SumApplied slice.
  interface SapPaymentLink {
    paymentDocEntry: number;
    paymentDocNum: number | null;
    paymentDate: Date | null;
    cardCode: string;
    cardName: string;
    sumApplied: number;
    currency: string;
  }
  const sapByInvoice = new Map<number, SapPaymentLink[]>();
  const targetSet = new Set(docEntries);
  for (const raw of sapPayments) {
    const p = raw as unknown as Record<string, unknown>;
    const lines = (p.PaymentInvoices ?? []) as Array<Record<string, unknown>>;
    for (const ln of lines) {
      const invDocEntry = Number(ln.DocEntry);
      if (!targetSet.has(invDocEntry)) continue;
      const list = sapByInvoice.get(invDocEntry) ?? [];
      list.push({
        paymentDocEntry: Number(p.DocEntry),
        paymentDocNum: p.DocNum != null ? Number(p.DocNum) : null,
        paymentDate:
          p.DocDate instanceof Date
            ? (p.DocDate as Date)
            : p.DocDate
              ? new Date(String(p.DocDate))
              : null,
        cardCode: String(p.CardCode ?? ''),
        cardName: String(p.CardName ?? ''),
        sumApplied: Number(ln.SumApplied ?? 0),
        currency: String(p.DocCurrency ?? 'EUR'),
      });
      sapByInvoice.set(invDocEntry, list);
    }
  }

  return {
    date,
    items: invoices.map((inv) => ({
      ...inv,
      matches: matchesByInvoice.get(inv.DocEntry as number) ?? [],
      sapPayments: sapByInvoice.get(inv.DocEntry as number) ?? [],
    })),
  };
}

export async function getInvoice(companyKey: string, docEntry: number) {
  const models = await getTenantModelsFor(companyKey);
  const inv = await invModel(models).findOne({ DocEntry: docEntry }).lean();
  if (!inv) throw new NotFoundError('Invoice');
  const matches = await models.PaymentMatch.find({
    invoiceDocEntry: docEntry,
  }).lean();
  return { ...inv, matches };
}

/**
 * Manual invoice creation — for invoices NOT coming from a delivery note.
 * Idris's call: "they will not be doing that in SAP anymore. They will only
 * be doing in your sheet." So we POST to SAP /Invoices, then cache the
 * snapshot locally with the returned DocEntry/DocNum.
 */
export async function createManualInvoice(
  companyKey: string,
  input: CreateInvoiceInput,
  actor: ActorMeta,
) {
  const models = await getTenantModelsFor(companyKey);
  const Inv = invModel(models);

  const body = {
    CardCode: input.cardCode.toUpperCase(),
    DocDate: input.date,
    DocDueDate: input.docDueDate ?? input.date,
    DocCurrency: input.docCurrency,
    Comments: input.comments ?? 'Manual invoice (no source DN)',
    DocumentLines: input.lines.map((l) => ({
      ItemCode: l.ItemCode,
      Quantity: l.Quantity,
      ...(l.UnitPrice !== undefined ? { UnitPrice: l.UnitPrice } : {}),
      ...(l.LineTotal !== undefined ? { LineTotal: l.LineTotal } : {}),
      ...(l.TaxCode ? { TaxCode: l.TaxCode } : {}),
      ...(l.ItemDescription ? { ItemDescription: l.ItemDescription } : {}),
    })),
  };

  const response = await sapPost<Record<string, unknown>>(
    companyKey,
    '/Invoices',
    body,
  );

  const docEntry = response?.DocEntry as number | undefined;
  const docNum = response?.DocNum as number | undefined;
  if (!docEntry) {
    throw new AppError(
      'SAP returned 200 but no DocEntry — refusing to claim a successful push',
      502,
      'SAP_NO_DOCENTRY',
      response,
    );
  }

  // Cache the SAP response locally. The next SAP sync will overwrite/upsert.
  await Inv.updateOne(
    { DocEntry: docEntry },
    {
      $set: {
        ...response,
        // Tag local provenance so we can tell manual-created from synced.
        createdSource: 'manual',
        createdByEmail: actor.email,
        manualCreatedAt: new Date(),
      },
    },
    { upsert: true },
  );

  await audit({
    action: 'invoices.create',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    subjectType: 'Invoice',
    subjectId: String(docEntry),
    companyKey,
    after: {
      docEntry,
      docNum: docNum ?? null,
      cardCode: body.CardCode,
      docTotal: response?.DocTotal,
      lineCount: input.lines.length,
    },
    ip: actor.ip,
  });

  logger.info(
    `invoices.create ok cardCode=${body.CardCode} → SAP DocEntry=${docEntry} DocNum=${docNum ?? '?'}`,
  );

  return await invModel(models).findOne({ DocEntry: docEntry }).lean();
}

/**
 * Mark / unmark an invoice as a non-paid delivery (livraison non payée).
 * This is a local annotation only — SAP keeps the invoice open with normal
 * PaidToDate semantics. The flag drives the "outstanding receivables"
 * section on the daily invoices screen.
 */
export async function setUnpaidFlag(
  companyKey: string,
  docEntry: number,
  input: MarkUnpaidInput,
  actor: ActorMeta,
) {
  const models = await getTenantModelsFor(companyKey);
  const Inv = invModel(models);
  const inv = await Inv.findOne({ DocEntry: docEntry }).lean();
  if (!inv) throw new NotFoundError('Invoice');

  if (input.unpaidFlag === false) {
    await Inv.updateOne(
      { DocEntry: docEntry },
      {
        $set: {
          unpaidFlag: false,
          unpaidFlagReason: null,
          unpaidFlaggedAt: null,
          unpaidFlaggedByEmail: null,
        },
      },
    );
  } else {
    if (inv.DocumentStatus === 'bost_Close' || inv.DocumentStatus === 'C') {
      throw new BadRequestError(
        'Cannot flag a closed invoice as non payé — invoice is already settled in SAP',
      );
    }
    await Inv.updateOne(
      { DocEntry: docEntry },
      {
        $set: {
          unpaidFlag: true,
          unpaidFlagReason: input.reason ?? '',
          unpaidFlaggedAt: new Date(),
          unpaidFlaggedByEmail: actor.email,
        },
      },
    );
  }

  await audit({
    action: input.unpaidFlag ? 'invoices.markUnpaid' : 'invoices.clearUnpaid',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    subjectType: 'Invoice',
    subjectId: String(docEntry),
    companyKey,
    after: { unpaidFlag: input.unpaidFlag, reason: input.reason },
    ip: actor.ip,
  });

  return await Inv.findOne({ DocEntry: docEntry }).lean();
}
