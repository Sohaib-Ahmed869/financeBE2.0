import { Schema, type InferSchemaType } from 'mongoose';

/**
 * One row of the verification summary: for a given settlement day + payment
 * method, what SAP says was taken vs. what actually showed up in the bank.
 * This is the whole point of bank reconciliation — confirming the money SAP
 * recorded actually landed. No invoice or SAP-push concepts live here.
 */
const MethodReconciliationSubSchema = new Schema(
  {
    date: { type: Date, required: true },
    method: { type: String, enum: ['cash', 'cheque', 'bank', 'card'], required: true },
    expectedFromSap: { type: Number, default: 0 }, // sum of SAP payments for that day+method
    foundInBank: { type: Number, default: 0 }, // sum of matched bank lines
    status: {
      type: String,
      enum: ['matched', 'partial', 'missing'],
      default: 'missing',
    },
  },
  { _id: false },
);

/**
 * Uploaded bank statement (header). Lines live in the separate
 * `BankStatementLine` collection so they can be filtered, matched, and
 * tagged independently — that's the headline read pattern for the bank-rec
 * screen.
 */
export const BankStatementSchema = new Schema(
  {
    bankKey: { type: String, required: true, index: true }, // 'sg' | 'creditmutuel' | 'bnp' …
    accountNumber: String,
    accountLabel: String,

    periodStart: { type: Date, required: true, index: true },
    periodEnd: { type: Date, required: true },

    rawFileId: { type: Schema.Types.ObjectId, ref: 'Document', default: null },

    status: {
      type: String,
      enum: ['pending', 'parsed', 'matched', 'failed'],
      default: 'pending',
      index: true,
    },

    // Parser output stats
    linesParsedCount: { type: Number, default: 0 },
    linesMatchedCount: { type: Number, default: 0 },
    openingBalance: Number,
    closingBalance: Number,
    currency: { type: String, default: 'EUR' },

    uploadedByEmail: { type: String, required: true, index: true },
    uploadedAt: { type: Date, default: () => new Date() },
    parsedAt: Date,
    parseError: String,

    /**
     * Verification result, computed by auto-match: SAP's daily per-method
     * totals lined up against what was found in the bank. Persisted so the
     * bank-rec screen can render it without recomputing the SAP aggregation.
     */
    methodReconciliation: { type: [MethodReconciliationSubSchema], default: [] },
    reconciledAt: Date,
  },
  {
    timestamps: true,
    collection: 'bank_statements',
  },
);

BankStatementSchema.index({ bankKey: 1, periodStart: -1 });

export type IBankStatement = InferSchemaType<typeof BankStatementSchema>;
