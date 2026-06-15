import type { Model } from 'mongoose';
import type { TenantModels } from '../../models/tenant';

/**
 * Reconciliation engine for LIVRAISONS cheques against cached SAP open
 * invoices. Pure functions — no DB writes. The service layer reads the
 * decisions returned here and persists them.
 *
 * Match scoring (0..1):
 *   1.00 — exact amount match on the open balance, single candidate
 *   0.90 — exact amount match, multiple candidates (oldest wins, others alt)
 *   0.85 — amount within 1 EUR (rounding tolerance)
 *   0.70 — amount within 5 EUR
 *   0.40 — only candidate, but amount mismatch
 *   0.00 — no candidates
 *
 * Anything ≥ 0.90 is treated as auto-match-eligible; lower needs human eyes.
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
  | 'duplicate-cheque'
  | 'amount-missing';

/**
 * What kind of SAP object this candidate represents. Idris asked for the
 * reconcile screen to surface all four sources, not just open invoices.
 *
 *   `invoice`    — open A/R Invoice. Allocate at full balance.
 *   `credit-note`— open A/R Credit Note. Reduces balance (negative side).
 *   `on-account` — existing SAP IncomingPayment that hasn't been applied to
 *                  any invoice yet. Already-cashed money sitting on the
 *                  customer's account.
 *   `balance`    — synthetic candidate representing the customer's current
 *                  account balance from SAP. Used when amount sits in the
 *                  account header rather than against a specific document.
 */
export type CandidateKind = 'invoice' | 'credit-note' | 'on-account' | 'balance';

export interface MatchCandidate {
  /** Discriminator — see `CandidateKind`. */
  kind: CandidateKind;
  /** For `invoice` / `credit-note` / `on-account`: the SAP DocEntry. Zero for `balance`. */
  invoiceDocEntry: number;
  invoiceDocNum: number;
  cardCode: string;
  cardName: string;
  docDate: Date | null;
  docTotal: number;
  paidToDate: number;
  /** Outstanding amount the candidate would absorb. */
  balance: number;
  score: number;
  reason: string;
  /** Difference (cheque amount - candidate balance). Negative = cheque short. */
  amountDelta: number;
}

export interface LivraisonInput {
  codeClient?: string;
  /** Cheque amount (the legacy single-method column). */
  montant?: number | null;
  montantEspeces?: number | null;
  montantCBSite?: number | null;
  montantCBPhone?: number | null;
  montantVirement?: number | null;
  numero?: string;
  nonPaye?: boolean;
}

export type LivraisonMethod =
  | 'cheque'
  | 'cash'
  | 'cb-site'
  | 'cb-phone'
  | 'transfer'
  | 'mixed'
  | 'none';

/**
 * The amount to reconcile for a delivery row = the total actually paid across
 * every method (cheque + cash + CB site + CB phone + transfer). A delivery is
 * usually settled by a single method, but split payments sum here. Returns
 * `null` when nothing was paid — e.g. an unpaid / non-payé row — so the matcher
 * reports a clean "amount missing" rather than guessing against the cheque
 * column alone.
 */
export function livraisonPaidAmount(l: LivraisonInput): number | null {
  const sum =
    (l.montant ?? 0) +
    (l.montantEspeces ?? 0) +
    (l.montantCBSite ?? 0) +
    (l.montantCBPhone ?? 0) +
    (l.montantVirement ?? 0);
  return sum > 0 ? +sum.toFixed(2) : null;
}

/** Which payment method a delivery row carries, for display. `mixed` when more
 * than one method column is filled, `none` when nothing was paid. */
export function livraisonMethod(l: LivraisonInput): LivraisonMethod {
  const present: LivraisonMethod[] = [];
  if ((l.montant ?? 0) > 0) present.push('cheque');
  if ((l.montantEspeces ?? 0) > 0) present.push('cash');
  if ((l.montantCBSite ?? 0) > 0) present.push('cb-site');
  if ((l.montantCBPhone ?? 0) > 0) present.push('cb-phone');
  if ((l.montantVirement ?? 0) > 0) present.push('transfer');
  if (present.length === 0) return 'none';
  if (present.length === 1) return present[0];
  return 'mixed';
}

export interface MatchDecision {
  candidates: MatchCandidate[];
  exception: MatchExceptionKind;
  /** The proposed top candidate — present when at least one candidate exists. */
  proposed: MatchCandidate | null;
  /** True when the proposed match clears the auto-match bar. */
  autoEligible: boolean;
  exceptionDetail?: string;
}

interface OpenDocument {
  kind: CandidateKind;
  DocEntry: number;
  DocNum: number;
  CardCode: string;
  CardName: string;
  DocDate: Date | null;
  DocTotal: number;
  PaidToDate: number;
  /** Outstanding amount (always positive on the candidate). */
  outstanding: number;
}

export interface ReconciliationContext {
  /** All allocation candidates per card — invoices, credit notes, on-account payments. */
  candidatesByCard: Map<string, OpenDocument[]>;
  /**
   * Customer balance per card (signed — negative means customer is in credit).
   * Lets the matcher surface "balance" as a fallback target when no document
   * candidate fits.
   */
  balanceByCard: Map<string, { balance: number; cardName: string }>;
  /** Lower-cased cheque numbers seen across the day's livraisons — to flag dupes. */
  chequeNumberCounts: Map<string, number>;
  /** Upper-cased card codes that exist in the cached customer list. */
  knownCardCodes: Set<string>;
  /** True when the customer cache itself is empty (no Customer sync has run). */
  customerCacheEmpty: boolean;
}

/**
 * Loads a reconciliation context for one day. Reads from the local SAP cache,
 * never hits the SAP Service Layer — that's the whole point of having the cache.
 */
export async function buildContext(
  models: TenantModels,
  livraisons: LivraisonInput[],
): Promise<ReconciliationContext> {
  const cardCodes = Array.from(
    new Set(
      livraisons
        .map((l) => (l.codeClient ?? '').trim())
        .filter((c) => c.length > 0),
    ),
  );

  // Case-insensitive lookups: SAP CardCode casing is occasionally inconsistent
  // and the Excel sheet routinely lower-cases everything.
  const cardCodesUpper = cardCodes.map((c) => c.toUpperCase());

  const invoiceModel = models.Invoice as unknown as Model<Record<string, unknown>>;
  const creditNoteModel = models.CreditNote as unknown as Model<Record<string, unknown>>;
  const paymentModel = models.Payment as unknown as Model<Record<string, unknown>>;
  const customerModel = models.Customer as unknown as Model<Record<string, unknown>>;

  const candidatesByCard = new Map<string, OpenDocument[]>();
  const push = (cardCode: string, doc: OpenDocument) => {
    const list = candidatesByCard.get(cardCode) ?? [];
    list.push(doc);
    candidatesByCard.set(cardCode, list);
  };

  // Open A/R invoices — SAP's `bost_Open` is canonical; older records use 'O'.
  const invoiceDocs = (await invoiceModel
    .find({
      CardCode: { $in: cardCodesUpper },
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
    })
    .lean()) as unknown as Array<Record<string, unknown>>;
  for (const raw of invoiceDocs) {
    const cardCode = String(raw.CardCode ?? '').toUpperCase();
    const docTotal = Number(raw.DocTotal ?? 0);
    const paidToDate = Number(raw.PaidToDate ?? 0);
    const outstanding = +(docTotal - paidToDate).toFixed(2);
    if (outstanding <= AMOUNT_EXACT_TOLERANCE) continue; // effectively settled
    push(cardCode, {
      kind: 'invoice',
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
      outstanding,
    });
  }

  // Open credit notes — reduce the customer's balance. Surface them as
  // negative-side candidates: outstanding = unallocated CN amount.
  const creditNoteDocs = (await creditNoteModel
    .find({
      CardCode: { $in: cardCodesUpper },
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
    })
    .lean()) as unknown as Array<Record<string, unknown>>;
  for (const raw of creditNoteDocs) {
    const cardCode = String(raw.CardCode ?? '').toUpperCase();
    const docTotal = Number(raw.DocTotal ?? 0);
    const paidToDate = Number(raw.PaidToDate ?? 0);
    const outstanding = +(docTotal - paidToDate).toFixed(2);
    if (outstanding <= AMOUNT_EXACT_TOLERANCE) continue;
    push(cardCode, {
      kind: 'credit-note',
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
      outstanding,
    });
  }

  // On-account payments — SAP IncomingPayments with no PaymentInvoices entries
  // are sitting on the customer's account. They look like "the customer has
  // already paid this much but it hasn't been allocated to an invoice yet".
  const paymentDocs = (await paymentModel
    .find({
      CardCode: { $in: cardCodesUpper },
      $or: [
        { PaymentInvoices: { $exists: false } },
        { PaymentInvoices: { $size: 0 } },
      ],
    })
    .select({
      DocEntry: 1,
      DocNum: 1,
      CardCode: 1,
      CardName: 1,
      DocDate: 1,
      DocTotal: 1,
      CashSum: 1,
      TransferSum: 1,
    })
    .lean()) as unknown as Array<Record<string, unknown>>;
  for (const raw of paymentDocs) {
    const cardCode = String(raw.CardCode ?? '').toUpperCase();
    const docTotal = Number(
      raw.DocTotal ?? raw.CashSum ?? raw.TransferSum ?? 0,
    );
    if (docTotal <= AMOUNT_EXACT_TOLERANCE) continue;
    push(cardCode, {
      kind: 'on-account',
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
      PaidToDate: 0,
      outstanding: docTotal,
    });
  }

  // Sort each bucket: invoices first (oldest-first FIFO), then credit notes,
  // then on-account payments — the order the team allocates against.
  const rank = { invoice: 0, 'credit-note': 1, 'on-account': 2, balance: 3 } as const;
  for (const list of candidatesByCard.values()) {
    list.sort((a, b) => {
      if (a.kind !== b.kind) return rank[a.kind] - rank[b.kind];
      const at = a.DocDate?.getTime() ?? Number.MAX_SAFE_INTEGER;
      const bt = b.DocDate?.getTime() ?? Number.MAX_SAFE_INTEGER;
      if (at !== bt) return at - bt;
      return a.DocEntry - b.DocEntry;
    });
  }

  // Cheque-# duplicates
  const chequeNumberCounts = new Map<string, number>();
  for (const l of livraisons) {
    const n = (l.numero ?? '').trim().toLowerCase();
    if (!n) continue;
    chequeNumberCounts.set(n, (chequeNumberCounts.get(n) ?? 0) + 1);
  }

  // Customer balances + known-cards check share the same pull.
  const customers = (await customerModel
    .find({ CardCode: { $in: cardCodesUpper } })
    .select({ CardCode: 1, CardName: 1, CurrentAccountBalance: 1 })
    .lean()) as unknown as Array<Record<string, unknown>>;
  const knownCardCodes = new Set<string>();
  const balanceByCard = new Map<string, { balance: number; cardName: string }>();
  for (const c of customers) {
    const cardCode = String(c.CardCode ?? '').toUpperCase();
    if (!cardCode) continue;
    knownCardCodes.add(cardCode);
    balanceByCard.set(cardCode, {
      balance: Number(c.CurrentAccountBalance ?? 0),
      cardName: String(c.CardName ?? ''),
    });
  }

  // If the customer collection is completely empty, that means the customer
  // sync hasn't been run yet — flagging every row as "card not in cache" is
  // misleading.
  const customerCount = await customerModel.estimatedDocumentCount();
  const customerCacheEmpty = customerCount === 0;

  return {
    candidatesByCard,
    balanceByCard,
    chequeNumberCounts,
    knownCardCodes,
    customerCacheEmpty,
  };
}

const CANDIDATE_LIMIT = 5;

function scoreOne(amount: number, balance: number): { score: number; reason: string } {
  const diff = Math.abs(amount - balance);
  if (diff <= AMOUNT_EXACT_TOLERANCE) return { score: 1, reason: 'exact-amount' };
  if (diff <= AMOUNT_NEAR_TOLERANCE) return { score: 0.85, reason: 'amount-within-1eur' };
  if (diff <= AMOUNT_LOOSE_TOLERANCE) return { score: 0.7, reason: 'amount-within-5eur' };
  return { score: 0.4, reason: 'amount-mismatch' };
}

/**
 * Decide a match for one cheque row given the prepared context.
 */
export function decideMatch(
  livraison: LivraisonInput,
  ctx: ReconciliationContext,
): MatchDecision {
  const cardCode = (livraison.codeClient ?? '').trim().toUpperCase();
  // Match against the total the customer actually paid for this delivery —
  // cash, CB and transfer count too, not just the cheque column. (This is what
  // made cash-only deliveries report a bogus "cheque amount missing".)
  const amount = livraisonPaidAmount(livraison);

  // Duplicate cheque flag is independent of the rest — surface it first.
  const numero = (livraison.numero ?? '').trim().toLowerCase();
  const dupe = numero && (ctx.chequeNumberCounts.get(numero) ?? 0) > 1;

  if (!cardCode) {
    return {
      candidates: [],
      proposed: null,
      autoEligible: false,
      exception: 'no-card',
    };
  }
  // Only flag "card not in cache" when we actually have a customer list to
  // compare against. An empty cache means the user hasn't run the customer
  // sync yet — silence the flag and let the open-invoice check speak.
  if (!ctx.customerCacheEmpty && !ctx.knownCardCodes.has(cardCode)) {
    return {
      candidates: [],
      proposed: null,
      autoEligible: false,
      exception: 'no-card',
      exceptionDetail: `Card "${livraison.codeClient}" isn't in the synced customer list.`,
    };
  }
  const open = ctx.candidatesByCard.get(cardCode);
  const customerBalance = ctx.balanceByCard.get(cardCode);
  if (!open || open.length === 0) {
    // Fall back to the customer balance as a synthetic candidate when the
    // customer has open A/R but no per-document candidate. Lets the user
    // allocate against the account header without leaving the screen.
    if (customerBalance && customerBalance.balance > AMOUNT_EXACT_TOLERANCE && amount != null) {
      const { score, reason } = scoreOne(amount, customerBalance.balance);
      return {
        candidates: [
          {
            kind: 'balance',
            invoiceDocEntry: 0,
            invoiceDocNum: 0,
            cardCode,
            cardName: customerBalance.cardName,
            docDate: null,
            docTotal: customerBalance.balance,
            paidToDate: 0,
            balance: customerBalance.balance,
            score: Math.min(score, 0.7), // bare balance is never auto-eligible
            reason: `balance (${reason})`,
            amountDelta: +(amount - customerBalance.balance).toFixed(2),
          },
        ],
        proposed: null,
        autoEligible: false,
        exception: 'no-open-invoices',
      };
    }
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

  // Score every candidate against the cheque amount. Two-key sort:
  //   1) higher score first (closer match on amount)
  //   2) within same score: rank by kind (invoice > credit-note > on-account)
  //      then oldest-first (FIFO) — how the team allocates manually.
  const rank = { invoice: 0, 'credit-note': 1, 'on-account': 2, balance: 3 } as const;
  const scored: MatchCandidate[] = open
    .map((doc) => {
      const { score, reason } = scoreOne(amount, doc.outstanding);
      return {
        kind: doc.kind,
        invoiceDocEntry: doc.DocEntry,
        invoiceDocNum: doc.DocNum,
        cardCode: doc.CardCode,
        cardName: doc.CardName,
        docDate: doc.DocDate,
        docTotal: doc.DocTotal,
        paidToDate: doc.PaidToDate,
        balance: doc.outstanding,
        score,
        reason,
        amountDelta: +(amount - doc.outstanding).toFixed(2),
      };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.kind !== b.kind) return rank[a.kind] - rank[b.kind];
      const at = a.docDate?.getTime() ?? Number.MAX_SAFE_INTEGER;
      const bt = b.docDate?.getTime() ?? Number.MAX_SAFE_INTEGER;
      return at - bt;
    });

  const top = scored[0];
  // When several invoices score 1.00 (rare, but possible for repeat customers
  // with identical recurring totals), demote the auto-eligibility — we want
  // the user to pick.
  const exactCount = scored.filter((c) => c.reason === 'exact-amount').length;
  let proposed = top;
  let autoEligible = top.score >= AUTO_MATCH_THRESHOLD;
  if (top.reason === 'exact-amount' && exactCount > 1) {
    autoEligible = false;
    // Still propose oldest, but flag in reason.
    proposed = { ...top, reason: 'multiple-exact', score: 0.9 };
  }

  let exception: MatchExceptionKind = null;
  let exceptionDetail: string | undefined;
  if (top.reason === 'amount-mismatch') {
    exception = 'amount-mismatch';
    exceptionDetail = `Paid ${amount.toFixed(2)} vs balance ${top.balance.toFixed(2)} (Δ ${proposed.amountDelta.toFixed(2)})`;
  }
  if (dupe) {
    // Duplicate cheque doesn't void candidates, but auto-match is unsafe.
    autoEligible = false;
    exception = exception ?? 'duplicate-cheque';
    exceptionDetail =
      exceptionDetail ??
      `Cheque #${livraison.numero} appears ${ctx.chequeNumberCounts.get(numero)} times today.`;
  }

  return {
    candidates: scored.slice(0, CANDIDATE_LIMIT),
    proposed,
    autoEligible,
    exception,
    exceptionDetail,
  };
}
