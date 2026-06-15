import { sapGet, type SapPaginated } from '../../sap/client';
import type { getTenantModelsFor } from '../../db/tenant';
import { logger } from '../../lib/logger';
import { NotFoundError } from '../../lib/errors';

type Models = Awaited<ReturnType<typeof getTenantModelsFor>>;

/**
 * Pre-reconcile auto-sync.
 *
 * Idris's instruction from the 14/05/2026 call: "imagine somebody forgot to do
 * a sync and then started doing match and auto matching" — so before the
 * reconcile screen renders, refresh the SAP cache for *only* the customers
 * that appear on the day. Targeted fetches are seconds-fast (filtering by
 * CardCode batches), unlike a full-table re-sync.
 *
 * Pulled per card:
 *   - Open Invoices (DocumentStatus = bost_Open)
 *   - Open Credit Notes (DocumentStatus = bost_Open)
 *   - Incoming Payments in the last 30 days (so on-account payments show up)
 *   - BusinessPartner record (for the current balance)
 *
 * Returns a per-entity tally so the UI can render a "Synced N invoices,
 * M credit notes, P payments" banner before unlocking the reconcile view.
 */
export interface PreReconcileSyncResult {
  durationMs: number;
  cardCodes: string[];
  invoices: { fetched: number; upserted: number };
  creditNotes: { fetched: number; upserted: number };
  payments: { fetched: number; upserted: number };
  customers: { fetched: number; upserted: number };
  warnings: string[];
}

const CHUNK_SIZE = 10; // SAP's URL-length limit comfortably handles ~10 CardCodes per filter.
const PAYMENT_LOOKBACK_DAYS = 30;

function chunked<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function quote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

async function fetchAll<T>(
  companyKey: string,
  path: string,
): Promise<T[]> {
  const out: T[] = [];
  let next: string | undefined = path;
  while (next) {
    const data: SapPaginated<T> = await sapGet<SapPaginated<T>>(companyKey, next, {
      maxPageSize: 100,
    });
    out.push(...data.value);
    next = data['odata.nextLink'];
  }
  return out;
}

export async function preReconcileSync(
  companyKey: string,
  models: Models,
  isoDate: string,
): Promise<PreReconcileSyncResult> {
  const m = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new NotFoundError(`Bad date ${isoDate}`);
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const day = await models.DaybookDay.findOne({ date }).lean();
  if (!day) throw new NotFoundError('DaybookDay');

  const startedAt = Date.now();
  const warnings: string[] = [];

  // Collect the unique CardCodes that appear on the day. Empty / "C9999"
  // (vente comptoir) entries don't need a sync — they're either non-customers
  // or already-counted POS receipts.
  const cards = new Set<string>();
  for (const l of day.livraisons ?? []) {
    const c = (l.codeClient ?? '').trim().toUpperCase();
    if (c && c !== 'C9999') cards.add(c);
  }
  for (const p of day.posExtraPayments ?? []) {
    const c = (p.codeClient ?? '').trim().toUpperCase();
    if (c && c !== 'C9999') cards.add(c);
  }
  const cardCodes = Array.from(cards).sort();

  const result: PreReconcileSyncResult = {
    durationMs: 0,
    cardCodes,
    invoices: { fetched: 0, upserted: 0 },
    creditNotes: { fetched: 0, upserted: 0 },
    payments: { fetched: 0, upserted: 0 },
    customers: { fetched: 0, upserted: 0 },
    warnings,
  };

  if (cardCodes.length === 0) {
    result.durationMs = Date.now() - startedAt;
    return result;
  }

  const paymentSince = isoDaysAgo(PAYMENT_LOOKBACK_DAYS);

  for (const batch of chunked(cardCodes, CHUNK_SIZE)) {
    const cardFilter = `(${batch.map((c) => `CardCode eq ${quote(c)}`).join(' or ')})`;

    // Run the four pulls in parallel — they hit different SAP collections.
    const [invs, cns, pays, bps] = await Promise.all([
      fetchAll<Record<string, unknown>>(
        companyKey,
        `Invoices?$filter=${encodeURIComponent(`${cardFilter} and (DocumentStatus eq 'bost_Open' or DocumentStatus eq 'O')`)}&$orderby=DocEntry`,
      ).catch((err) => {
        warnings.push(`Invoices: ${err instanceof Error ? err.message : String(err)}`);
        return [] as Record<string, unknown>[];
      }),
      fetchAll<Record<string, unknown>>(
        companyKey,
        `CreditNotes?$filter=${encodeURIComponent(`${cardFilter} and (DocumentStatus eq 'bost_Open' or DocumentStatus eq 'O')`)}&$orderby=DocEntry`,
      ).catch((err) => {
        warnings.push(`CreditNotes: ${err instanceof Error ? err.message : String(err)}`);
        return [] as Record<string, unknown>[];
      }),
      fetchAll<Record<string, unknown>>(
        companyKey,
        `IncomingPayments?$filter=${encodeURIComponent(`${cardFilter} and DocDate ge '${paymentSince}'`)}&$orderby=DocEntry`,
      ).catch((err) => {
        warnings.push(`IncomingPayments: ${err instanceof Error ? err.message : String(err)}`);
        return [] as Record<string, unknown>[];
      }),
      fetchAll<Record<string, unknown>>(
        companyKey,
        `BusinessPartners?$filter=${encodeURIComponent(`${cardFilter} and CardType eq 'cCustomer'`)}&$orderby=CardCode`,
      ).catch((err) => {
        warnings.push(`BusinessPartners: ${err instanceof Error ? err.message : String(err)}`);
        return [] as Record<string, unknown>[];
      }),
    ]);

    result.invoices.fetched += invs.length;
    result.creditNotes.fetched += cns.length;
    result.payments.fetched += pays.length;
    result.customers.fetched += bps.length;

    // Upsert each batch into the tenant cache.
    for (const doc of invs) {
      const id = doc.DocEntry;
      if (id == null) continue;
      const r = await models.Invoice.updateOne(
        { DocEntry: id },
        { $set: { ...doc, lastSyncedAt: new Date() } },
        { upsert: true },
      );
      if (r.upsertedCount || r.modifiedCount) result.invoices.upserted++;
    }
    for (const doc of cns) {
      const id = doc.DocEntry;
      if (id == null) continue;
      const r = await models.CreditNote.updateOne(
        { DocEntry: id },
        { $set: { ...doc, lastSyncedAt: new Date() } },
        { upsert: true },
      );
      if (r.upsertedCount || r.modifiedCount) result.creditNotes.upserted++;
    }
    for (const doc of pays) {
      const id = doc.DocEntry;
      if (id == null) continue;
      const r = await models.Payment.updateOne(
        { DocEntry: id },
        { $set: { ...doc, lastSyncedAt: new Date() } },
        { upsert: true },
      );
      if (r.upsertedCount || r.modifiedCount) result.payments.upserted++;
    }
    for (const doc of bps) {
      const id = doc.CardCode;
      if (id == null) continue;
      const r = await models.Customer.updateOne(
        { CardCode: id },
        { $set: { ...doc, lastSyncedAt: new Date() } },
        { upsert: true },
      );
      if (r.upsertedCount || r.modifiedCount) result.customers.upserted++;
    }
  }

  result.durationMs = Date.now() - startedAt;
  logger.info(
    {
      companyKey,
      isoDate,
      cards: cardCodes.length,
      invoices: result.invoices.fetched,
      creditNotes: result.creditNotes.fetched,
      payments: result.payments.fetched,
      customers: result.customers.fetched,
      durationMs: result.durationMs,
    },
    'daybook.pre_reconcile_sync',
  );

  return result;
}
