import { Schema, type InferSchemaType } from 'mongoose';

/**
 * One line of "this payment is applied to this invoice for this amount".
 *
 * Replaces all the v1 allocation glue (`paymentTracking`, `allocatedPayments`,
 * `paymentBreakdown`, `allocatedToInvoices`, `paymentNotAllocated`, etc.). The
 * Invoice and Payment models stay clean SAP read-models; this collection is
 * the only place where reconciliation links live.
 *
 * Polymorphic on the payment side:
 *   - one of `paymentEntryId` or `sapPaymentDocEntry` is set (not both).
 *
 * Always `invoiceDocEntry` (a SAP DocEntry number) on the invoice side —
 * we don't ObjectId-ref Invoice because the SAP DocEntry is the stable join key.
 *
 * Multiple matches per (payment, invoice) are allowed in principle (e.g. a
 * partial settlement followed by a top-up) — we don't enforce uniqueness on
 * that pair, only on the individual rows.
 */
export const PaymentMatchSchema = new Schema(
  {
    // Payment side (exactly one set)
    paymentEntryId: {
      type: Schema.Types.ObjectId,
      ref: 'PaymentEntry',
      default: null,
      index: true,
    },
    sapPaymentDocEntry: { type: Number, default: null, index: true },

    // Credit-note side (alternative to a payment — credit notes also "apply" to invoices)
    creditNoteDocEntry: { type: Number, default: null, index: true },

    // Invoice side
    invoiceDocEntry: { type: Number, required: true, index: true },

    // Money
    appliedAmount: { type: Number, required: true, min: 0 },
    appliedCurrency: { type: String, default: 'EUR' },

    // How the match was determined
    confidence: { type: Number, min: 0, max: 1, default: 1 },
    matchedBy: {
      type: String,
      required: true,
      enum: ['system', 'user'],
      index: true,
    },
    matchedVia: {
      type: String,
      required: true,
      enum: ['rule', 'embedding', 'manual', 'sap-native', 'envelope-match', 'learned'],
      index: true,
    },
    matchedByUserEmail: String,
    matchedAt: { type: Date, default: () => new Date(), index: true },

    // Provenance — which rule / pattern produced this match (if any)
    ruleId: { type: Schema.Types.ObjectId, ref: 'MatchingRule', default: null },
    learnedPatternId: { type: Schema.Types.ObjectId, ref: 'LearnedPattern', default: null },

    // Reversal
    reverted: { type: Boolean, default: false, index: true },
    revertedAt: Date,
    revertedByEmail: String,
    revertReason: String,
    /** When a match is reverted, point at the row that replaces it (if any). */
    replacedByMatchId: { type: Schema.Types.ObjectId, ref: 'PaymentMatch', default: null },
  },
  {
    timestamps: true,
    collection: 'payment_matches',
  },
);

// Hot read paths
PaymentMatchSchema.index({ paymentEntryId: 1, invoiceDocEntry: 1 });
PaymentMatchSchema.index({ sapPaymentDocEntry: 1, invoiceDocEntry: 1 });
PaymentMatchSchema.index({ creditNoteDocEntry: 1, invoiceDocEntry: 1 });
PaymentMatchSchema.index({ invoiceDocEntry: 1, reverted: 1, matchedAt: -1 });

// Sanity guard: exactly one of the three "left-side" refs must be set.
PaymentMatchSchema.pre('validate', function (next) {
  const set = [this.paymentEntryId, this.sapPaymentDocEntry, this.creditNoteDocEntry].filter(
    (v) => v !== null && v !== undefined,
  );
  if (set.length !== 1) {
    return next(
      new Error(
        'PaymentMatch must have exactly one of: paymentEntryId, sapPaymentDocEntry, creditNoteDocEntry',
      ),
    );
  }
  next();
});

export type IPaymentMatch = InferSchemaType<typeof PaymentMatchSchema>;
