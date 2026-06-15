import { Schema, type InferSchemaType } from 'mongoose';

/**
 * One day of the daybook (one sheet of the monthly workbook). Stores the
 * normalized blocks the team fills in by hand:
 *   - `totals`            — the EXCEL totals block (top-right)
 *   - `remiseBancaire`    — what was actually pushed to SAP that day
 *   - `caisseEspeces`     — POS cash drawer breakdown
 *   - `caisseCheques`     — POS cheques (per-client)
 *   - `caisseCB`          — POS card terminal (Till + sans-contact)
 *   - `depenses`          — expenses (gas, etc.)
 *   - `livraisons`        — delivery cheques to push to SAP (RCT2)
 *
 * One row per (company × date). Re-uploading replaces the day's contents.
 */

const MoneyRow = new Schema(
  {
    label: { type: String, default: '' },
    amount: { type: Number, default: null },
  },
  { _id: false },
);

const ChequeLine = new Schema(
  {
    client: { type: String, default: '' },
    montant: { type: Number, default: null },
  },
  { _id: false },
);

/**
 * The slim reconciliation pointer we keep on each LIVRAISONS line. The full
 * candidate list and exception detail are computed on the fly when the
 * reconciliation view is requested — what we persist here is just the chosen
 * decision plus, post-Phase-4, the SAP push outcome.
 *
 * `status` lifecycle:
 *   `unmatched` — never auto-matched / never reviewed
 *   `auto`      — system picked a high-confidence candidate
 *   `manual`    — user picked or confirmed (overrides any auto)
 *   `rejected`  — user explicitly rejected all candidates (don't auto-fill again)
 *   `pushed`    — successfully posted as an IncomingPayment in SAP
 *   `push-failed` — push attempt failed; sits in a retry queue
 */
const MatchSubSchema = new Schema(
  {
    status: {
      type: String,
      enum: ['unmatched', 'auto', 'manual', 'rejected', 'pushed', 'push-failed'],
      default: 'unmatched',
    },
    invoiceDocEntry: { type: Number, default: null },
    /** Filled at decision time so we can render without a fresh SAP cache lookup. */
    invoiceDocNum: { type: Number, default: null },
    invoiceTotal: { type: Number, default: null },
    invoiceBalance: { type: Number, default: null },
    invoiceDate: { type: Date, default: null },
    matchScore: { type: Number, default: null, min: 0, max: 1 },
    matchReason: { type: String, default: '' },
    matchedByEmail: { type: String, default: '' },
    matchedAt: { type: Date, default: null },
    notes: { type: String, default: '' },

    // SAP push outcome (only set once status flips to 'pushed' or 'push-failed').
    paymentEntryId: { type: Schema.Types.ObjectId, default: null },
    sapDocEntry: { type: Number, default: null, index: true },
    sapDocNum: { type: Number, default: null },
    pushedAt: { type: Date, default: null },
    pushAttempts: { type: Number, default: 0 },
    pushError: { type: String, default: '' },
    pushErrorAt: { type: Date, default: null },
  },
  { _id: false },
);

/**
 * Bank deposit slip — the daybook's `remiseBancaire.bankSlips` array. Captures
 * one slip envelope sent to the bank with its reference *and* its amount, so
 * the bank-statement matcher can clear deposit lines by amount + slip number.
 * Replaces the legacy `bankSlipRefs: string[]` (kept alongside for back-compat
 * during the migration; new code reads `bankSlips`).
 */
const BankSlip = new Schema(
  {
    ref: { type: String, default: '' },
    amount: { type: Number, default: null },
    /** Convenience: derived at write time so reports/exports don't recompute. */
    kind: { type: String, enum: ['cash', 'cheques', 'mixed'], default: 'cash' },
  },
  { _id: false },
);

/**
 * POS over-payment — a customer paid more at the till than the invoice total.
 * The POS terminal can only invoice (not record A/R payments), so the extra
 * sits as a card-method surplus on the Z report's `drawerDiscrepancy.card`.
 * The user adds one line per customer here so we can push the surplus to SAP
 * as a payment-on-account (RCT4 for card / RCT3 for cash). When summed across
 * the day these rows should clear the till's drawer discrepancy.
 */
const PosExtraPayment = new Schema(
  {
    codeClient: { type: String, default: '' },
    clientName: { type: String, default: '' },
    method: {
      type: String,
      enum: ['card', 'cash', 'cheque'],
      default: 'card',
    },
    amount: { type: Number, default: null },
    notes: { type: String, default: '' },

    // SAP push outcome — same shape as LivraisonLine.match minus the invoice.
    status: {
      type: String,
      enum: ['unpushed', 'pushed', 'push-failed'],
      default: 'unpushed',
    },
    paymentEntryId: { type: Schema.Types.ObjectId, default: null },
    sapDocEntry: { type: Number, default: null, index: true },
    sapDocNum: { type: Number, default: null },
    pushedAt: { type: Date, default: null },
    pushError: { type: String, default: '' },
    pushErrorAt: { type: Date, default: null },
  },
  { _id: false },
);

const LivraisonLine = new Schema(
  {
    codeClient: { type: String, default: '' },
    clientName: { type: String, default: '' },
    /** Cheque amount (the legacy single-method column). */
    montant: { type: Number, default: null },
    banque: { type: String, default: '' },
    numero: { type: String, default: '' },
    remarques: { type: String, default: '' },
    /** Raw "ok"/"OK" string copied from the SAP column in the sheet — informational only. */
    sapStatusRaw: { type: String, default: '' },
    /**
     * Per-method amounts (expanded LIVRAISONS layout). One delivery can be
     * settled by multiple methods on the same day (e.g. half cheque, half
     * cash) so each method has its own column / amount slot.
     */
    montantEspeces: { type: Number, default: null },
    montantCBSite: { type: Number, default: null },
    montantCBPhone: { type: Number, default: null },
    montantVirement: { type: Number, default: null },
    /** Transfer reference for the wire-transfer column. */
    referenceVirement: { type: String, default: '' },
    /** Livraison non payée — invoice stays open, no payment row created. */
    nonPaye: { type: Boolean, default: false },

    /**
     * Sales channel for KPI reports. POS = derived from Z-report; own-company
     * = auto-classified by CardCode being in the tenant's
     * `ownCompanyCardCodes`; external-transport = explicit flag the user
     * sets; own-delivery = default (driver from our fleet).
     */
    deliveryChannel: {
      type: String,
      enum: ['pos', 'own-company', 'external-transport', 'own-delivery'],
      default: 'own-delivery',
    },

    match: { type: MatchSubSchema, default: () => ({}) },
  },
  { _id: false },
);

export const DaybookDaySchema = new Schema(
  {
    /**
     * Provenance — `'excel'` if upserted by the workbook parser, `'manual'`
     * if typed in / edited via the day editor. A day initially imported from
     * Excel flips to 'manual' as soon as someone saves an edit, so subsequent
     * file deletes don't wipe it out.
     */
    source: {
      type: String,
      enum: ['excel', 'manual'],
      default: 'excel',
      required: true,
      index: true,
    },
    /** Set when the day came from (or was originally created with) an Excel upload. */
    fileId: { type: Schema.Types.ObjectId, default: null, index: true },
    /** Inclusive day boundary. Always 00:00 UTC; uniqueness key. */
    date: { type: Date, required: true, index: true },
    /** Convenience — day of month derived from `date`. */
    dayOfMonth: { type: Number, required: true, min: 1, max: 31 },
    /** Excel sheet name when sourced from a workbook (`"1"`…`"31"`); empty for manual entries. */
    sheetName: { type: String, default: '' },

    /** Audit-friendly metadata for the most recent manual write. */
    lastEditedByUserId: { type: Schema.Types.ObjectId, default: null },
    lastEditedByEmail: { type: String, default: '' },

    totals: {
      especes: { type: Number, default: null },
      cheques: { type: Number, default: null },
      carteCredit: { type: Number, default: null },
      virement: { type: Number, default: null },
    },

    remiseBancaire: {
      especes: { type: Number, default: null },
      cheques: { type: Number, default: null },
      monnaieNonDeposee: { type: Number, default: null },
      /** Legacy — string list of slip numbers. New code writes `bankSlips`. */
      bankSlipRefs: { type: [String], default: [] },
      /** New — ref + amount + kind, for amount-based bank-statement matching. */
      bankSlips: { type: [BankSlip], default: [] },
    },

    caisseEspeces: {
      billets50: { type: Number, default: null },
      billets20: { type: Number, default: null },
      billets10: { type: Number, default: null },
      billets5: { type: Number, default: null },
      monnaie: { type: Number, default: null },
      total: { type: Number, default: null },
      fondCaisse: { type: Number, default: null },
    },

    caisseCheques: { type: [ChequeLine], default: [] },
    caisseChequesTotal: { type: Number, default: null },

    caisseCB: {
      till: { type: Number, default: null },
      sansContact: { type: Number, default: null },
      total: { type: Number, default: null },
    },

    differenceFondCaisse: { type: Number, default: null },

    depenses: { type: [MoneyRow], default: [] },
    depensesTotal: { type: Number, default: null },

    livraisons: { type: [LivraisonLine], default: [] },

    /** POS over-payments — one row per customer who paid more at the till than
     * the invoice (the till's card-method surplus). Pushed to SAP as
     * payments-on-account (RCT4 for card / RCT3 for cash / RCT2 for cheque). */
    posExtraPayments: { type: [PosExtraPayment], default: [] },

    /** Soft-warnings raised during parsing (e.g. "row 14 col 3: '12.34 €' couldn't be parsed"). */
    parseWarnings: { type: [String], default: [] },
  },
  { timestamps: true, collection: 'daybook_days' },
);

DaybookDaySchema.index({ date: 1 }, { unique: true });
DaybookDaySchema.index({ fileId: 1, dayOfMonth: 1 });

export type IDaybookDay = InferSchemaType<typeof DaybookDaySchema>;
