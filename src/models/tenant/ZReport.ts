import { Schema, type InferSchemaType } from 'mongoose';

/**
 * Daily POS Z-export. The till already pushes per-receipt POS payments to
 * SAP automatically; our job is to **verify** the day matches and surface the
 * cash-drawer gap (counted vs expected).
 *
 * Receipt rows are embedded — they belong to exactly one Z-report and are
 * almost always read together with their parent. Embedded keeps the model
 * simple and the queries cheap.
 */
const ZReportRowSubSchema = new Schema(
  {
    /** Stable identity within the report — usually the till's receipt number. */
    receiptRef: { type: String, required: true },
    time: String,

    // Customer & line
    cardCode: String,
    cardName: String,

    // Method (per-receipt — totals are also rolled up at the parent level)
    method: { type: String, enum: ['cash', 'cheque', 'card', 'other'] },
    amount: Number,
    currency: { type: String, default: 'EUR' },

    // Linkage to SAP (filled by the verification job)
    matchedSapPaymentDocEntry: { type: Number, default: null },
    matched: { type: Boolean, default: false },

    raw: Schema.Types.Mixed, // anything from the till export we didn't model
  },
  { _id: false },
);

export const ZReportSchema = new Schema(
  {
    // Identity
    branch: { type: String, required: true, index: true }, // = companyKey for now (1 branch / co)
    date: { type: Date, required: true, index: true },

    // Source file (the raw CSV/PDF the till produced)
    rawFileId: { type: Schema.Types.ObjectId, ref: 'Document', default: null },

    // Method totals — rolled up from rows or read from the export's summary block
    totals: {
      cash: { type: Number, default: 0 },
      cheque: { type: Number, default: 0 },
      card: { type: Number, default: 0 },
      other: { type: Number, default: 0 },
    },

    // Cash drawer
    /** Float — opening cash placed in the drawer at start of day. */
    float: Number,
    /** Cash receipts during the day (= totals.cash + sales-cash from rows). */
    expectedCash: Number,
    /** Counted by the user OR (when the till vendor adds the field) by the export. */
    countedCash: { type: Number, default: null },
    /** countedCash - expectedCash. Negative = drawer short, positive = over. */
    drawerGap: { type: Number, default: null },

    /**
     * Per-method "In Audit" — the till's authoritative number for what was
     * received by each method. Identical to `totals.*` when sourced from the
     * Z Summary block.
     */
    drawerAudit: {
      cash: { type: Number, default: null },
      card: { type: Number, default: null },
      cheque: { type: Number, default: null },
    },
    /** Per-method "In Drawer" — what was physically counted in the till. */
    drawerCounted: {
      cash: { type: Number, default: null },
      card: { type: Number, default: null },
      cheque: { type: Number, default: null },
    },
    /** counted − audit per method. Negative = short, positive = over. */
    drawerDiscrepancy: {
      cash: { type: Number, default: null },
      card: { type: Number, default: null },
      cheque: { type: Number, default: null },
    },
    /** Net (signed) discrepancy across all methods. */
    netDiscrepancy: { type: Number, default: null },

    /**
     * Receipts whose total was partly posted to the customer's SAP A/R account
     * (the till's ACCOUNT column). The card surplus Idris flagged in the
     * meeting lives here: each entry surfaces a customer who paid more than
     * the invoice and needs the extra posted as payment-on-account.
     */
    accountReceipts: {
      type: [
        new Schema(
          {
            receiptRef: String,
            cardCode: String,
            cardName: String,
            amount: Number,
          },
          { _id: false },
        ),
      ],
      default: [],
    },

    // Expenses paid out of the drawer (deducted from expected before reconciling)
    expenses: { type: Number, default: 0 },
    expenseBreakdown: { type: [Schema.Types.Mixed], default: undefined },

    // Status pipeline
    status: {
      type: String,
      enum: ['pending-counted', 'matched', 'discrepant', 'verified'],
      default: 'pending-counted',
      index: true,
    },

    // Verification trail
    matchedSapPaymentIds: { type: [Number], default: [] },
    verifiedAt: Date,
    verifiedByEmail: String,
    notes: String,

    // The receipts themselves
    rows: { type: [ZReportRowSubSchema], default: [] },
  },
  {
    timestamps: true,
    collection: 'zreports',
  },
);

ZReportSchema.index({ branch: 1, date: -1 }, { unique: true }); // one report per branch / day
ZReportSchema.index({ status: 1, date: -1 });

export type IZReport = InferSchemaType<typeof ZReportSchema>;
