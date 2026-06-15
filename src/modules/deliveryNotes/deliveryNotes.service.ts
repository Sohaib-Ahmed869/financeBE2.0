import type { Model } from 'mongoose';
import { getTenantModelsFor } from '../../db/tenant';
import { sapPost } from '../../sap/client';
import { audit } from '../../lib/audit';
import { logger } from '../../lib/logger';
import { AppError, BadRequestError, NotFoundError } from '../../lib/errors';

/**
 * Delivery Note → Invoice flow (the morning routine).
 *
 * Posts a fresh `Invoice` to SAP whose `DocumentLines[*]` carry the
 * `BaseType: 15 / BaseEntry: <DN.DocEntry> / BaseLine: <DN.LineNum>` triple
 * — SAP then auto-copies item / quantity / pricing from the source DN.
 * Mirrors the v1 reference at `D:\Calcite Codes\HalalSales` which has been
 * the production push path against this same tenant for years.
 *
 * This is a write to SAP, idempotency matters: we refuse to push a DN that
 * SAP already shows as closed (it's been invoiced) and skip any DN whose
 * cached row has been marked closed locally by a prior push.
 */

interface ActorMeta {
  userId: string;
  email: string;
  ip: string;
}

const SAP_BASE_TYPE_DELIVERY_NOTE = 15;

interface DnRow {
  DocEntry: number;
  DocNum: number;
  CardCode: string;
  CardName: string;
  DocDate: Date | null;
  DocDueDate: Date | null;
  DocTotal: number;
  DocCurrency: string;
  DocumentStatus: string;
  Comments?: string;
  DocumentLines: Array<{
    LineNum: number;
    ItemCode?: string;
    ItemDescription?: string;
    Quantity?: number;
    LineTotal?: number;
  }>;
  invoicedDocEntry?: number | null;
  invoicedAt?: Date | null;
  invoicedByEmail?: string;
  conversionError?: string;
  conversionErrorAt?: Date | null;
  conversionAttempts?: number;
}

export interface DnListItem {
  docEntry: number;
  docNum: number;
  cardCode: string;
  cardName: string;
  docDate: Date | null;
  docTotal: number;
  docCurrency: string;
  documentStatus: string;
  lineCount: number;
  invoicedDocEntry: number | null;
  invoicedAt: Date | null;
  conversionError: string | null;
}

interface ListOptions {
  status?: 'open' | 'closed' | 'all';
  cardCode?: string;
  from?: string; // YYYY-MM-DD
  to?: string;   // YYYY-MM-DD
  limit?: number;
  page?: number;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function dnModelOf(models: Awaited<ReturnType<typeof getTenantModelsFor>>) {
  return models.DeliveryNote as unknown as Model<Record<string, unknown>>;
}

function isoDateAt(date: Date | string | null | undefined): string {
  if (!date) return new Date().toISOString().slice(0, 10);
  const d = date instanceof Date ? date : new Date(date);
  return d.toISOString().slice(0, 10);
}

export async function listDeliveryNotes(companyKey: string, opts: ListOptions) {
  const models = await getTenantModelsFor(companyKey);
  const Dn = dnModelOf(models);

  const filter: Record<string, unknown> = {};
  if (opts.status === 'open' || opts.status === undefined) {
    // Default view: only DNs that haven't been invoiced. SAP marks DNs as
    // closed (`bost_Close`) once they've been pulled into an invoice.
    filter.DocumentStatus = { $in: ['bost_Open', 'O'] };
    // ...and we haven't just pushed locally either.
    filter.invoicedDocEntry = { $in: [null, undefined] };
  } else if (opts.status === 'closed') {
    filter.DocumentStatus = { $in: ['bost_Close', 'C'] };
  }
  if (opts.cardCode) filter.CardCode = opts.cardCode.toUpperCase();
  if (opts.from || opts.to) {
    const range: Record<string, Date> = {};
    if (opts.from) range.$gte = new Date(`${opts.from}T00:00:00.000Z`);
    if (opts.to) range.$lte = new Date(`${opts.to}T23:59:59.999Z`);
    filter.DocDate = range;
  }

  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const page = Math.max(opts.page ?? 1, 1);
  const total = await Dn.countDocuments(filter);
  const docs = (await Dn.find(filter)
    .sort({ DocDate: -1, DocEntry: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .lean()) as unknown as DnRow[];

  const items: DnListItem[] = docs.map((d) => ({
    docEntry: d.DocEntry,
    docNum: d.DocNum,
    cardCode: d.CardCode,
    cardName: d.CardName,
    docDate: d.DocDate,
    docTotal: d.DocTotal,
    docCurrency: d.DocCurrency,
    documentStatus: d.DocumentStatus,
    lineCount: d.DocumentLines?.length ?? 0,
    invoicedDocEntry: d.invoicedDocEntry ?? null,
    invoicedAt: d.invoicedAt ?? null,
    conversionError: d.conversionError ?? null,
  }));

  return {
    items,
    total,
    page,
    limit,
    pages: Math.max(1, Math.ceil(total / limit)),
  };
}

export interface ConvertOutcome {
  docEntry: number;
  docNum: number;
  status: 'pushed' | 'skipped' | 'failed';
  invoiceDocEntry?: number;
  invoiceDocNum?: number;
  reason?: string;
  error?: string;
}

export interface ConvertSummary {
  pushed: number;
  skipped: number;
  failed: number;
  results: ConvertOutcome[];
}

/**
 * Build the SAP `Invoice` body for one DeliveryNote.
 *
 * Per the v1 working pattern: only the BaseType/BaseEntry/BaseLine triple
 * is required on each line — SAP B1 copies item/quantity/pricing from the
 * source. CardCode + DocDate are top-level so the invoice gets a current
 * date even when the DN is from yesterday's run.
 */
export function buildInvoiceBodyFromDn(dn: DnRow) {
  const today = isoDateAt(new Date());
  return {
    CardCode: dn.CardCode,
    DocDate: today,
    DocDueDate: today,
    DocCurrency: dn.DocCurrency || 'EUR',
    Comments: dn.Comments || `Auto-invoice from DN #${dn.DocNum}`,
    DocumentLines: dn.DocumentLines.map((line) => ({
      BaseType: SAP_BASE_TYPE_DELIVERY_NOTE,
      BaseEntry: dn.DocEntry,
      BaseLine: line.LineNum,
    })),
  };
}

async function convertOne(
  companyKey: string,
  models: Awaited<ReturnType<typeof getTenantModelsFor>>,
  docEntry: number,
  actor: ActorMeta,
): Promise<ConvertOutcome> {
  const Dn = dnModelOf(models);
  const dn = (await Dn.findOne({ DocEntry: docEntry }).lean()) as unknown as
    | DnRow
    | null;
  if (!dn) {
    return {
      docEntry,
      docNum: 0,
      status: 'skipped',
      reason: 'not-found',
    };
  }

  // Idempotent: don't re-push something already invoiced.
  if (dn.invoicedDocEntry) {
    return {
      docEntry,
      docNum: dn.DocNum,
      status: 'skipped',
      reason: 'already-invoiced',
      invoiceDocEntry: dn.invoicedDocEntry,
    };
  }
  // SAP-side closure (someone invoiced it directly in SAP between syncs).
  if (dn.DocumentStatus === 'bost_Close' || dn.DocumentStatus === 'C') {
    return {
      docEntry,
      docNum: dn.DocNum,
      status: 'skipped',
      reason: 'closed-in-sap',
    };
  }
  if (!dn.DocumentLines || dn.DocumentLines.length === 0) {
    return {
      docEntry,
      docNum: dn.DocNum,
      status: 'skipped',
      reason: 'no-lines',
    };
  }

  const body = buildInvoiceBodyFromDn(dn);
  try {
    const response = await sapPost<{ DocEntry?: number; DocNum?: number }>(
      companyKey,
      '/Invoices',
      body,
    );
    const invoiceDocEntry = response?.DocEntry;
    const invoiceDocNum = response?.DocNum;
    if (!invoiceDocEntry) {
      throw new AppError(
        'SAP returned a 200 but no Invoice DocEntry — refusing to claim a successful push',
        502,
        'SAP_NO_DOCENTRY',
        response,
      );
    }

    // Mark the DN locally as invoiced so the next list refresh hides it.
    // The next SAP DeliveryNote sync will also flip DocumentStatus to closed.
    await Dn.updateOne(
      { DocEntry: dn.DocEntry },
      {
        $set: {
          invoicedDocEntry: invoiceDocEntry,
          invoicedAt: new Date(),
          invoicedByEmail: actor.email,
          DocumentStatus: 'bost_Close',
          conversionError: '',
          conversionErrorAt: null,
        },
        $inc: { conversionAttempts: 1 },
      },
    );

    logger.info(
      `dn.convert ok #${dn.DocNum} → Invoice DocEntry=${invoiceDocEntry} DocNum=${invoiceDocNum ?? '?'}`,
    );

    return {
      docEntry: dn.DocEntry,
      docNum: dn.DocNum,
      status: 'pushed',
      invoiceDocEntry,
      invoiceDocNum,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, docEntry, companyKey }, 'dn.convert.failed');
    await Dn.updateOne(
      { DocEntry: dn.DocEntry },
      {
        $set: { conversionError: message, conversionErrorAt: new Date() },
        $inc: { conversionAttempts: 1 },
      },
    );
    return {
      docEntry: dn.DocEntry,
      docNum: dn.DocNum,
      status: 'failed',
      error: message,
    };
  }
}

export async function bulkConvert(
  companyKey: string,
  docEntries: number[],
  actor: ActorMeta,
): Promise<ConvertSummary> {
  if (!Array.isArray(docEntries) || docEntries.length === 0) {
    throw new BadRequestError('Provide at least one DN docEntry');
  }
  const models = await getTenantModelsFor(companyKey);

  const summary: ConvertSummary = { pushed: 0, skipped: 0, failed: 0, results: [] };
  // Sequential — SAP B1 SL writes serialize cleanly per session and we
  // don't want to flood the cookie pool.
  for (const de of docEntries) {
    const out = await convertOne(companyKey, models, de, actor);
    summary.results.push(out);
    if (out.status === 'pushed') summary.pushed++;
    else if (out.status === 'failed') summary.failed++;
    else summary.skipped++;
  }

  await audit({
    action: 'deliveryNotes.bulkConvert',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    subjectType: 'DeliveryNoteBulk',
    subjectId: docEntries.join(','),
    companyKey,
    after: {
      pushed: summary.pushed,
      skipped: summary.skipped,
      failed: summary.failed,
      count: docEntries.length,
    },
    ip: actor.ip,
  });

  return summary;
}

export async function getOne(companyKey: string, docEntry: number) {
  const models = await getTenantModelsFor(companyKey);
  const dn = await dnModelOf(models).findOne({ DocEntry: docEntry }).lean();
  if (!dn) throw new NotFoundError('DeliveryNote');
  return dn;
}
