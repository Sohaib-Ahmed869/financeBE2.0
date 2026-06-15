import { Schema, type InferSchemaType } from 'mongoose';

/**
 * The new "one sheet, every method" payment-sheet entry. The accountant types
 * here once; we push to SAP and reconcile against the customer's open
 * invoices at entry time.
 *
 * Distinct from `Payment` (the cached SAP read-model). Lifecycle:
 *
 *   draft → matched → push-pending → pushed   (happy path)
 *                  ↘
 *                    rejected (push failed; show in queue)
 *
 * Once a `PaymentEntry` is `pushed`, the matching SAP `Payment` row will land
 * on the next sync. The two are bound by `sapDocEntry`.
 */
export const PaymentMethods = [
  'POS',
  'Bank',
  'Cheque',
  'Cash',
  'CB-Site',
  'CB-Phone',
  'PayPal',
  'Account', // = "no payment, leave invoice open"
] as const;
export type PaymentMethod = (typeof PaymentMethods)[number];

/** Maps each method to the SAP RCT sub-table it writes into. */
export const SAP_TABLE_BY_METHOD: Record<PaymentMethod, 'RCT1' | 'RCT2' | 'RCT3' | 'RCT4' | 'NONE'> = {
  POS: 'RCT3', // POS posts via cash sub-table; method really comes from the till
  Bank: 'RCT1',
  Cheque: 'RCT2',
  Cash: 'RCT3',
  'CB-Site': 'RCT4',
  'CB-Phone': 'RCT4',
  PayPal: 'RCT4',
  Account: 'NONE',
};

const ChequeDetailsSubSchema = new Schema(
  {
    chequeNumber: String,
    bankCode: String,
    bankName: String,
    payerName: String,
    chequeDate: Date,
  },
  { _id: false },
);

const CardDetailsSubSchema = new Schema(
  {
    processor: { type: String, enum: ['sogecommerce-site', 'sogecommerce-phone', 'paypal'] },
    authCode: String,
    transactionId: String,
    maskedPan: String, // last 4 digits at most — never store full PAN
    cardBrand: String,
  },
  { _id: false },
);

const BankDetailsSubSchema = new Schema(
  {
    transferReference: String,
    bankAccount: String,
    counterpartyName: String,
    counterpartyIban: String,
  },
  { _id: false },
);

export const PaymentEntrySchema = new Schema(
  {
    // Identity
    cardCode: { type: String, required: true, index: true },
    cardName: String,
    date: { type: Date, required: true, index: true },

    // Money
    method: { type: String, required: true, enum: PaymentMethods, index: true },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'EUR' },

    // Method-specific subdocs — only the relevant one is set.
    cheque: { type: ChequeDetailsSubSchema, default: undefined },
    card: { type: CardDetailsSubSchema, default: undefined },
    bank: { type: BankDetailsSubSchema, default: undefined },

    // Origin — where this entry came from
    sourceType: {
      type: String,
      required: true,
      enum: [
        'manual',
        'paypal-import',
        'sogecommerce-import',
        'bank-statement',
        'z-report',
        'daybook-import',
      ],
      default: 'manual',
      index: true,
    },
    sourceFileId: { type: Schema.Types.ObjectId, ref: 'Document', default: null, index: true },
    sourceLineRef: String,

    // Pipeline status
    status: {
      type: String,
      required: true,
      enum: ['draft', 'matched', 'push-pending', 'pushed', 'failed', 'voided'],
      default: 'draft',
      index: true,
    },

    /**
     * "On-account" payment — pushed to SAP without a PaymentInvoices link.
     * The receipt goes against the customer's AR control account and can be
     * reconciled to specific invoices later (inside SAP or via a follow-up
     * Internal Reconciliation). Mutually exclusive with having an active
     * PaymentMatch row.
     */
    onAccount: { type: Boolean, default: false, index: true },

    // SAP push tracking
    sapTable: { type: String, enum: ['RCT1', 'RCT2', 'RCT3', 'RCT4', 'NONE'], default: null },
    sapDocEntry: { type: Number, default: null, index: true },
    sapDocNum: { type: Number, default: null },
    sapPushedAt: Date,
    sapPushAttempts: { type: Number, default: 0 },
    sapLastError: String,
    sapLastErrorAt: Date,

    // People
    enteredByEmail: { type: String, required: true, index: true },
    enteredAt: { type: Date, default: () => new Date() },
    confirmedByEmail: String,
    confirmedAt: Date,
    voidedByEmail: String,
    voidedAt: Date,
    voidReason: String,

    // Free notes
    notes: String,

    // Tags applied to this payment for the tag-based P&L roll-up
    tags: { type: [String], default: [] },
  },
  {
    timestamps: true,
    collection: 'payment_entries',
  },
);

PaymentEntrySchema.index({ cardCode: 1, date: -1 });
PaymentEntrySchema.index({ status: 1, date: -1 });
PaymentEntrySchema.index({ method: 1, date: -1 });
// Idempotency: a single import row should never produce two payment entries
// for the same source line.
PaymentEntrySchema.index(
  { sourceFileId: 1, sourceLineRef: 1 },
  { unique: true, partialFilterExpression: { sourceFileId: { $ne: null } } },
);

export type IPaymentEntry = InferSchemaType<typeof PaymentEntrySchema>;
