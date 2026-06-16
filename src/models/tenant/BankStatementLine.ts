import { Schema, type InferSchemaType } from 'mongoose';

/**
 * Individual bank-statement line. One row per transaction. Heavily indexed
 * because the bank-rec screen filters/sorts on most of these fields.
 */
export const BankStatementLineSchema = new Schema(
  {
    statementId: {
      type: Schema.Types.ObjectId,
      ref: 'BankStatement',
      required: true,
      index: true,
    },

    // Dates — operation date (when the bank executed it) and value date
    operationDate: { type: Date, required: true, index: true },
    valueDate: Date,

    // Money
    amount: { type: Number, required: true }, // signed: positive = credit, negative = debit
    currency: { type: String, default: 'EUR' },
    direction: { type: String, enum: ['credit', 'debit'], required: true, index: true },
    balanceAfter: Number,

    // Free-text fields the bank provides
    description: String,
    counterparty: String, // payer/payee if extractable
    reference: String, // bank-side ref / transaction id

    /**
     * Parsed envelope number — the cash-deposit envelope id the team writes
     * on the deposit slip. Idris's flow uses this as the join key for
     * matching cash deposits to the day's POS / cash receipts.
     */
    envelopeNumber: { type: String, default: null, index: true },

    // Auto-classification result
    category: {
      type: String,
      enum: [
        'unknown',
        'pos-deposit',
        'cash-deposit',
        'cheque-deposit',
        'card-settlement',
        'sogecommerce',
        'paypal',
        'sepa-credit',
        'sepa-debit',
        'fee',
        'expense',
        'transfer-internal',
        'other',
      ],
      default: 'unknown',
      index: true,
    },

    // Matching outcome.
    //
    // Bank reconciliation is a VERIFICATION layer, not a second push to SAP:
    // a bank line is matched against the *daily total per payment method* of
    // the payments already reconciled into SAP — never against invoices, and
    // it never writes anything back to SAP. These fields record which SAP
    // method-total / settlement day the line was confirmed against.
    matchedMethod: {
      type: String,
      enum: ['cash', 'cheque', 'bank', 'card', null],
      default: null,
      index: true,
    },
    matchedSettlementDate: { type: Date, default: null },
    /**
     * Signed bank − SAP delta when a line matched its method-total / slip
     * *outside* the exact ±0.01 band but within the discrepancy tolerance
     * (max of €5.00 or 2%). `0` (or null) means an exact match. Surfaced as a
     * "Δ" badge in the UI so the small gap is visible without blocking the
     * verification. Internal only — never written to SAP.
     */
    discrepancyAmount: { type: Number, default: null },
    /**
     * When a method-total resolves to a single SAP IncomingPayment, we keep its
     * DocEntry for traceability. Read-only reference — never written to SAP.
     */
    matchedSapPaymentDocEntry: { type: Number, default: null, index: true },
    /**
     * SAP CardCode the user (or the learned counterparty mapping) tagged this
     * line with, when a human identifies the counterparty of an otherwise
     * unexplained line. Internal annotation only.
     */
    matchedCardCode: { type: String, default: null, index: true },

    // Status / tagging / overrides
    status: {
      type: String,
      enum: ['unmatched', 'matched', 'tagged', 'ignored', 'flagged'],
      default: 'unmatched',
      index: true,
    },
    tags: { type: [String], default: [] },
    notes: String,

    // Fingerprint for de-duplication on re-upload (sha256 of normalised line).
    fingerprint: { type: String, index: true, sparse: true },
  },
  {
    timestamps: true,
    collection: 'bank_statement_lines',
  },
);

BankStatementLineSchema.index({ statementId: 1, operationDate: 1 });
BankStatementLineSchema.index({ status: 1, operationDate: -1 });
// Idempotent re-upload: same statement + fingerprint = same row.
BankStatementLineSchema.index(
  { statementId: 1, fingerprint: 1 },
  { unique: true, partialFilterExpression: { fingerprint: { $exists: true } } },
);

export type IBankStatementLine = InferSchemaType<typeof BankStatementLineSchema>;
