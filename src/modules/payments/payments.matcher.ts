import type { Model } from 'mongoose';
import type { TenantModels } from '../../models/tenant';
import type { PaymentMethod } from '../../models/tenant/PaymentEntry';

/**
 * Method-agnostic reconciliation engine.
 *
 * Generalised from the cheque-only version that lived in `daybook.matcher`:
 * the same scoring works for any payment method because the inputs are just
 * (cardCode, amount). Method-specific concerns — duplicate cheque #, duplicate
 * transfer ref, etc. — are still surfaced via `extraExceptions`.
 *
 * Pure functions, no DB writes. Service layer reads decisions and persists.
 *
 * Match scoring (0..1):
 *   1.00 — exact amount on the open balance, single candidate
 *   0.90 — exact amount, multiple candidates (oldest wins, demoted to manual)
 *   0.85 — within 1 EUR (rounding)
 *   0.70 — within 5 EUR
 *   0.40 — only candidate, but amount mismatch
 *   0.00 — no candidates
 */

export const AUTO_MATCH_THRESHOLD = 0.9;
export const AMOUNT_EXACT_TOLERANCE = 0.01;
export const AMOUNT_NEAR_TOLERANCE = 1.0;
export const AMOUNT_LOOSE_TOLERANCE = 5.0;

export type MatchExceptionKind =
  | null
  | 'no-card'
  | 'no-open-invoices'
  | 'amount-mismatch'
  | 'amount-missing'
  | 'duplicate-reference'
  | 'method-not-pushable';

export interface MatchCandidate {
  invoiceDocEntry: number;
  invoiceDocNum: number;
  cardCode: string;
  cardName: string;
  docDate: Date | null;
  docTotal: number;
  paidToDate: number;
  balance: number;
  score: number;
  reason: string;
  /** payment amount minus invoice balance — negative = payment short. */
  amountDelta: number;
}

export interface PaymentInput {
  cardCode?: string;
  amount?: number | null;
  method: PaymentMethod;
  /**
   * Method-specific reference used for duplicate detection.
   * - Cheque: cheque number
   * - Bank: transfer reference
   * - CB-Site, CB-Phone, PayPal: transaction id
   * Falsy values disable duplicate detection for that row.
   */
  reference?: string | null;
}

export interface MatchDecision {
  candidates: MatchCandidate[];
  proposed: MatchCandidate | null;
  autoEligible: boolean;
  exception: MatchExceptionKind;
  exceptionDetail?: string;
}

interface OpenInvoice {
  DocEntry: number;
  DocNum: number;
  CardCode: string;
  CardName: string;
  DocDate: Date | null;
  DocTotal: number;
  PaidToDate: number;
  DocumentStatus: string;
}

export interface ReconciliationContext {
  openInvoicesByCard: Map<string, OpenInvoice[]>;
  /** Lower-cased reference counts across the day's payments — flags dupes. */
  referenceCounts: Map<string, number>;
  /** Upper-cased card codes that exist in the cached customer list. */
  knownCardCodes: Set<string>;
  /** True when the customer cache is empty (no Customer sync has run). */
  customerCacheEmpty: boolean;
}

export async function buildContext(
  models: TenantModels,
  payments: PaymentInput[],
): Promise<ReconciliationContext> {
  const cardCodes = Array.from(
    new Set(
      payments
        .map((p) => (p.cardCode ?? '').trim())
        .filter((c) => c.length > 0)
        .map((c) => c.toUpperCase()),
    ),
  );

  const invoiceModel = models.Invoice as unknown as Model<Record<string, unknown>>;
  const customerModel = models.Customer as unknown as Model<Record<string, unknown>>;

  const invoiceDocs = (await invoiceModel
    .find({
      CardCode: { $in: cardCodes },
      DocumentStatus: { $in: ['bost_Open', 'O'] },
    })
    .select({
      DocEntry: 1,
      DocNum: 1,
      CardCode: 1,
      CardName: 1,
      DocDate: 1,
      DocTotal: 1,
      PaidToDate: 1,
      DocumentStatus: 1,
    })
    .lean()) as unknown as Array<Record<string, unknown>>;

  const openInvoicesByCard = new Map<string, OpenInvoice[]>();
  for (const raw of invoiceDocs) {
    const cardCode = String(raw.CardCode ?? '').toUpperCase();
    const docTotal = Number(raw.DocTotal ?? 0);
    const paidToDate = Number(raw.PaidToDate ?? 0);
    const balance = +(docTotal - paidToDate).toFixed(2);
    if (balance <= AMOUNT_EXACT_TOLERANCE) continue;

    const list = openInvoicesByCard.get(cardCode) ?? [];
    list.push({
      DocEntry: Number(raw.DocEntry),
      DocNum: Number(raw.DocNum ?? 0),
      CardCode: cardCode,
      CardName: String(raw.CardName ?? ''),
      DocDate:
        raw.DocDate instanceof Date
          ? raw.DocDate
          : raw.DocDate
            ? new Date(String(raw.DocDate))
            : null,
      DocTotal: docTotal,
      PaidToDate: paidToDate,
      DocumentStatus: String(raw.DocumentStatus ?? ''),
    });
    openInvoicesByCard.set(cardCode, list);
  }

  // FIFO: oldest first.
  for (const list of openInvoicesByCard.values()) {
    list.sort((a, b) => {
      const at = a.DocDate?.getTime() ?? Number.MAX_SAFE_INTEGER;
      const bt = b.DocDate?.getTime() ?? Number.MAX_SAFE_INTEGER;
      if (at !== bt) return at - bt;
      return a.DocEntry - b.DocEntry;
    });
  }

  const referenceCounts = new Map<string, number>();
  for (const p of payments) {
    const ref = (p.reference ?? '').trim().toLowerCase();
    if (!ref) continue;
    // Scope dupe detection per-method so a cheque #123 and a transfer ref "123"
    // don't collide.
    const key = `${p.method}|${ref}`;
    referenceCounts.set(key, (referenceCounts.get(key) ?? 0) + 1);
  }

  const customers = (await customerModel
    .find({ CardCode: { $in: cardCodes } })
    .select({ CardCode: 1 })
    .lean()) as unknown as Array<{ CardCode?: unknown }>;
  const knownCardCodes = new Set<string>(
    customers
      .map((c) => String(c.CardCode ?? ''))
      .filter(Boolean)
      .map((s) => s.toUpperCase()),
  );

  const customerCount = await customerModel.estimatedDocumentCount();
  const customerCacheEmpty = customerCount === 0;

  return { openInvoicesByCard, referenceCounts, knownCardCodes, customerCacheEmpty };
}

const CANDIDATE_LIMIT = 5;

function scoreOne(amount: number, balance: number): { score: number; reason: string } {
  const diff = Math.abs(amount - balance);
  if (diff <= AMOUNT_EXACT_TOLERANCE) return { score: 1, reason: 'exact-amount' };
  if (diff <= AMOUNT_NEAR_TOLERANCE) return { score: 0.85, reason: 'amount-within-1eur' };
  if (diff <= AMOUNT_LOOSE_TOLERANCE) return { score: 0.7, reason: 'amount-within-5eur' };
  return { score: 0.4, reason: 'amount-mismatch' };
}

export function decideMatch(
  payment: PaymentInput,
  ctx: ReconciliationContext,
): MatchDecision {
  // Account method = "leave invoice open". No reconciliation, no SAP push.
  if (payment.method === 'Account') {
    return {
      candidates: [],
      proposed: null,
      autoEligible: false,
      exception: 'method-not-pushable',
      exceptionDetail: 'Non payé — invoice stays open',
    };
  }

  const cardCode = (payment.cardCode ?? '').trim().toUpperCase();
  const amount = payment.amount;

  const ref = (payment.reference ?? '').trim().toLowerCase();
  const refKey = ref ? `${payment.method}|${ref}` : '';
  const dupe = refKey && (ctx.referenceCounts.get(refKey) ?? 0) > 1;

  if (!cardCode) {
    return {
      candidates: [],
      proposed: null,
      autoEligible: false,
      exception: 'no-card',
    };
  }
  if (!ctx.customerCacheEmpty && !ctx.knownCardCodes.has(cardCode)) {
    return {
      candidates: [],
      proposed: null,
      autoEligible: false,
      exception: 'no-card',
      exceptionDetail: `Card "${payment.cardCode}" isn't in the synced customer list.`,
    };
  }
  const open = ctx.openInvoicesByCard.get(cardCode);
  if (!open || open.length === 0) {
    return {
      candidates: [],
      proposed: null,
      autoEligible: false,
      exception: 'no-open-invoices',
    };
  }
  if (amount === null || amount === undefined) {
    return {
      candidates: [],
      proposed: null,
      autoEligible: false,
      exception: 'amount-missing',
    };
  }

  const scored: MatchCandidate[] = open
    .map((inv) => {
      const balance = +(inv.DocTotal - inv.PaidToDate).toFixed(2);
      const { score, reason } = scoreOne(amount, balance);
      return {
        invoiceDocEntry: inv.DocEntry,
        invoiceDocNum: inv.DocNum,
        cardCode: inv.CardCode,
        cardName: inv.CardName,
        docDate: inv.DocDate,
        docTotal: inv.DocTotal,
        paidToDate: inv.PaidToDate,
        balance,
        score,
        reason,
        amountDelta: +(amount - balance).toFixed(2),
      };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const at = a.docDate?.getTime() ?? Number.MAX_SAFE_INTEGER;
      const bt = b.docDate?.getTime() ?? Number.MAX_SAFE_INTEGER;
      return at - bt;
    });

  const top = scored[0];
  const exactCount = scored.filter((c) => c.reason === 'exact-amount').length;
  let proposed = top;
  let autoEligible = top.score >= AUTO_MATCH_THRESHOLD;
  if (top.reason === 'exact-amount' && exactCount > 1) {
    autoEligible = false;
    proposed = { ...top, reason: 'multiple-exact', score: 0.9 };
  }

  let exception: MatchExceptionKind = null;
  let exceptionDetail: string | undefined;
  if (top.reason === 'amount-mismatch') {
    exception = 'amount-mismatch';
    exceptionDetail = `Payment ${amount.toFixed(2)} vs balance ${top.balance.toFixed(2)} (Δ ${proposed.amountDelta.toFixed(2)})`;
  }
  if (dupe) {
    autoEligible = false;
    exception = exception ?? 'duplicate-reference';
    exceptionDetail =
      exceptionDetail ??
      `${payment.method} reference "${payment.reference}" appears ${ctx.referenceCounts.get(refKey)} times today.`;
  }

  return {
    candidates: scored.slice(0, CANDIDATE_LIMIT),
    proposed,
    autoEligible,
    exception,
    exceptionDetail,
  };
}
