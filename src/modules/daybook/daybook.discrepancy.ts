import type { getTenantModelsFor } from '../../db/tenant';
import { BadRequestError, NotFoundError } from '../../lib/errors';

type Models = Awaited<ReturnType<typeof getTenantModelsFor>>;

/**
 * Cross-source discrepancy report.
 *
 * Idris (14/05/2026): "if there's anything which is extra in SAP or extra on
 * Excel… you should check from both ways". Per day, compares what the day's
 * daybook + Z-report claim happened against what's actually in the SAP cache:
 *
 *   - SAP Invoices on the day not represented by a Z-report row or a daybook
 *     livraison → manually posted in SAP, didn't go through us
 *   - SAP IncomingPayments on the day not linked to any daybook push → same
 *   - Daybook livraisons / posExtraPayments still in `unpushed` / `auto` /
 *     `manual` state with no `sapDocEntry` → never made it to SAP
 *
 * Matching is by (CardCode, amount, day) — the same shape v1 used and the
 * same shape SAP's POS auto-post uses. Per-document-num continuity (Idris's
 * `last reconciled 10,000` → `today's 10,500` flow) is captured in the
 * returned `docNumRange` block so the UI can display "scanned DocNum 10,001
 * – 10,500".
 */
export interface DiscrepancyReport {
  date: string;
  generatedAt: Date;
  docNumRange: {
    invoices: { min: number | null; max: number | null; count: number };
    payments: { min: number | null; max: number | null; count: number };
  };
  sapInvoicesNotOnDaybook: Array<{
    DocEntry: number;
    DocNum: number;
    CardCode: string;
    CardName: string;
    DocTotal: number;
    DocDate: Date | null;
    reason: string;
  }>;
  sapPaymentsNotOnDaybook: Array<{
    DocEntry: number;
    DocNum: number;
    CardCode: string;
    CardName: string;
    DocTotal: number;
    DocDate: Date | null;
    method: 'cash' | 'card' | 'cheque' | 'bank' | 'unknown';
    reason: string;
  }>;
  daybookRowsNotInSap: Array<{
    rowKind: 'livraison' | 'posExtraPayment';
    rowIndex: number;
    codeClient: string;
    clientName: string;
    amount: number;
    method: string;
    status: string;
    reason: string;
  }>;
  summary: {
    totalSapInvoices: number;
    totalSapPayments: number;
    totalDaybookRows: number;
    totalDiscrepancies: number;
  };
}

function dayBounds(isoDate: string): { from: Date; to: Date } {
  const m = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new BadRequestError('Use YYYY-MM-DD');
  const from = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const to = new Date(from);
  to.setUTCDate(to.getUTCDate() + 1);
  return { from, to };
}

function paymentMethodOf(p: Record<string, unknown>):
  | 'cash'
  | 'card'
  | 'cheque'
  | 'bank'
  | 'unknown' {
  if (Number(p.CashSum ?? 0) > 0) return 'cash';
  if (Number(p.TransferSum ?? 0) > 0) return 'bank';
  if (Array.isArray(p.PaymentChecks) && (p.PaymentChecks as unknown[]).length > 0) {
    return 'cheque';
  }
  if (
    Array.isArray(p.PaymentCreditCards)
    && (p.PaymentCreditCards as unknown[]).length > 0
  ) {
    return 'card';
  }
  return 'unknown';
}

function approxEqual(a: number, b: number, tol = 0.01): boolean {
  return Math.abs(a - b) <= tol;
}

export async function runDiscrepancyCheck(
  models: Models,
  isoDate: string,
): Promise<DiscrepancyReport> {
  const { from, to } = dayBounds(isoDate);

  const [day, zreport, invoices, payments] = await Promise.all([
    models.DaybookDay.findOne({ date: from }).lean(),
    models.ZReport.findOne({ date: from }).lean(),
    models.Invoice.find({ DocDate: { $gte: from, $lt: to } })
      .select({
        DocEntry: 1,
        DocNum: 1,
        CardCode: 1,
        CardName: 1,
        DocTotal: 1,
        DocDate: 1,
      })
      .lean() as unknown as Promise<Array<Record<string, unknown>>>,
    models.Payment.find({ DocDate: { $gte: from, $lt: to } })
      .select({
        DocEntry: 1,
        DocNum: 1,
        CardCode: 1,
        CardName: 1,
        DocTotal: 1,
        CashSum: 1,
        TransferSum: 1,
        PaymentChecks: 1,
        PaymentCreditCards: 1,
        DocDate: 1,
      })
      .lean() as unknown as Promise<Array<Record<string, unknown>>>,
  ]);

  if (!day && !zreport && invoices.length === 0 && payments.length === 0) {
    throw new NotFoundError(`No daybook / Z-report / SAP activity on ${isoDate}`);
  }

  // Index Z-report rows by cardCode for fast lookup. The till already
  // auto-posts these as SAP Payments + Invoices, so a SAP invoice/payment
  // with a matching (cardCode, amount) on a Z-report row is considered
  // explained.
  type ZRow = { cardCode: string; amount: number; method: string };
  const zrows: ZRow[] = (zreport?.rows ?? []).map((r) => ({
    cardCode: (r.cardCode ?? '').toUpperCase(),
    amount: +(r.amount ?? 0),
    method: r.method ?? '',
  }));
  const zByCard = new Map<string, ZRow[]>();
  for (const r of zrows) {
    const list = zByCard.get(r.cardCode) ?? [];
    list.push(r);
    zByCard.set(r.cardCode, list);
  }

  // Daybook livraisons that are already pushed carry sapDocEntry — those
  // explain matching SAP payments. Daybook livraisons that aren't pushed are
  // *daybook-only* (and may also explain a SAP payment if amount/card lines up
  // with a manual posting).
  type LivraisonRow = NonNullable<typeof day>['livraisons'][number];
  const livraisonByCardAndAmount = new Map<
    string,
    Array<{ rowIndex: number; row: LivraisonRow; consumed: boolean }>
  >();
  if (day) {
    day.livraisons.forEach((row, i) => {
      const card = (row.codeClient ?? '').toUpperCase();
      const amount = Number(row.montant ?? 0)
        + Number(row.montantEspeces ?? 0)
        + Number(row.montantCBSite ?? 0)
        + Number(row.montantCBPhone ?? 0)
        + Number(row.montantVirement ?? 0);
      const key = `${card}|${amount.toFixed(2)}`;
      const list = livraisonByCardAndAmount.get(key) ?? [];
      list.push({ rowIndex: i, row, consumed: false });
      livraisonByCardAndAmount.set(key, list);
    });
  }

  // Pre-bucket Z-report rows so we don't re-scan the array per SAP doc.
  const consumedZ = new Set<ZRow>();
  function consumeZRow(card: string, amount: number): ZRow | null {
    const list = zByCard.get(card) ?? [];
    for (const r of list) {
      if (consumedZ.has(r)) continue;
      if (approxEqual(r.amount, amount)) {
        consumedZ.add(r);
        return r;
      }
    }
    return null;
  }
  function consumeLivraison(card: string, amount: number): boolean {
    const key = `${card}|${amount.toFixed(2)}`;
    const list = livraisonByCardAndAmount.get(key) ?? [];
    for (const entry of list) {
      if (entry.consumed) continue;
      entry.consumed = true;
      return true;
    }
    return false;
  }

  /* ------------------- SAP invoices not on daybook ------------------- */
  const sapInvoicesNotOnDaybook: DiscrepancyReport['sapInvoicesNotOnDaybook'] = [];
  let invoiceDocNumMin: number | null = null;
  let invoiceDocNumMax: number | null = null;
  for (const inv of invoices) {
    const dn = Number(inv.DocNum ?? 0);
    if (dn) {
      if (invoiceDocNumMin === null || dn < invoiceDocNumMin) invoiceDocNumMin = dn;
      if (invoiceDocNumMax === null || dn > invoiceDocNumMax) invoiceDocNumMax = dn;
    }
    const card = String(inv.CardCode ?? '').toUpperCase();
    const total = Number(inv.DocTotal ?? 0);
    // Z-report consumed → explained by POS auto-post.
    if (consumeZRow(card, total)) continue;
    // Driver-delivery on the daybook explains this invoice.
    if (consumeLivraison(card, total)) continue;
    sapInvoicesNotOnDaybook.push({
      DocEntry: Number(inv.DocEntry ?? 0),
      DocNum: dn,
      CardCode: card,
      CardName: String(inv.CardName ?? ''),
      DocTotal: total,
      DocDate: (inv.DocDate as Date | null) ?? null,
      reason: 'Not on Z-report or daybook livraisons',
    });
  }

  /* ------------------- SAP payments not on daybook ------------------- */
  const sapPaymentsNotOnDaybook: DiscrepancyReport['sapPaymentsNotOnDaybook'] = [];
  let paymentDocNumMin: number | null = null;
  let paymentDocNumMax: number | null = null;

  // Build set of daybook sapDocEntries already linked to a pushed row.
  const linkedPaymentEntries = new Set<number>();
  if (day) {
    for (const l of day.livraisons) {
      if (l.match?.sapDocEntry) linkedPaymentEntries.add(Number(l.match.sapDocEntry));
    }
    for (const p of day.posExtraPayments ?? []) {
      if (p.sapDocEntry) linkedPaymentEntries.add(Number(p.sapDocEntry));
    }
  }

  for (const p of payments) {
    const dn = Number(p.DocNum ?? 0);
    if (dn) {
      if (paymentDocNumMin === null || dn < paymentDocNumMin) paymentDocNumMin = dn;
      if (paymentDocNumMax === null || dn > paymentDocNumMax) paymentDocNumMax = dn;
    }
    const docEntry = Number(p.DocEntry ?? 0);
    if (docEntry && linkedPaymentEntries.has(docEntry)) continue;
    const card = String(p.CardCode ?? '').toUpperCase();
    const total = Number(
      p.DocTotal ?? p.CashSum ?? p.TransferSum ?? 0,
    );
    // Z-report consumed → explained by POS auto-post.
    if (consumeZRow(card, total)) continue;
    sapPaymentsNotOnDaybook.push({
      DocEntry: docEntry,
      DocNum: dn,
      CardCode: card,
      CardName: String(p.CardName ?? ''),
      DocTotal: total,
      DocDate: (p.DocDate as Date | null) ?? null,
      method: paymentMethodOf(p),
      reason: 'Posted in SAP without a daybook push',
    });
  }

  /* ------------------- Daybook rows not in SAP ------------------- */
  const daybookRowsNotInSap: DiscrepancyReport['daybookRowsNotInSap'] = [];
  if (day) {
    day.livraisons.forEach((row, i) => {
      if (row.nonPaye) return; // non-payés are expected to have no SAP payment
      const amount = Number(row.montant ?? 0)
        + Number(row.montantEspeces ?? 0)
        + Number(row.montantCBSite ?? 0)
        + Number(row.montantCBPhone ?? 0)
        + Number(row.montantVirement ?? 0);
      if (amount <= 0) return;
      const status = row.match?.status ?? 'unmatched';
      const pushed = status === 'pushed' || Boolean(row.match?.sapDocEntry);
      if (pushed) return;
      daybookRowsNotInSap.push({
        rowKind: 'livraison',
        rowIndex: i,
        codeClient: row.codeClient ?? '',
        clientName: row.clientName ?? '',
        amount,
        method:
          (row.montantEspeces ?? 0) > 0
            ? 'cash'
            : (row.montantCBSite ?? 0) > 0
              ? 'cb-site'
              : (row.montantCBPhone ?? 0) > 0
                ? 'cb-phone'
                : (row.montantVirement ?? 0) > 0
                  ? 'bank'
                  : 'cheque',
        status,
        reason: 'Daybook line not yet pushed to SAP',
      });
    });
    (day.posExtraPayments ?? []).forEach((p, i) => {
      if ((p.amount ?? 0) <= 0) return;
      if (p.status === 'pushed' || p.sapDocEntry) return;
      daybookRowsNotInSap.push({
        rowKind: 'posExtraPayment',
        rowIndex: i,
        codeClient: p.codeClient ?? '',
        clientName: p.clientName ?? '',
        amount: Number(p.amount ?? 0),
        method: p.method ?? 'card',
        status: p.status ?? 'unpushed',
        reason: 'POS over-payment not yet pushed to SAP',
      });
    });
  }

  return {
    date: isoDate,
    generatedAt: new Date(),
    docNumRange: {
      invoices: { min: invoiceDocNumMin, max: invoiceDocNumMax, count: invoices.length },
      payments: { min: paymentDocNumMin, max: paymentDocNumMax, count: payments.length },
    },
    sapInvoicesNotOnDaybook,
    sapPaymentsNotOnDaybook,
    daybookRowsNotInSap,
    summary: {
      totalSapInvoices: invoices.length,
      totalSapPayments: payments.length,
      totalDaybookRows: (day?.livraisons?.length ?? 0) + (day?.posExtraPayments?.length ?? 0),
      totalDiscrepancies:
        sapInvoicesNotOnDaybook.length
        + sapPaymentsNotOnDaybook.length
        + daybookRowsNotInSap.length,
    },
  };
}
