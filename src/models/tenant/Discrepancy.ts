import { Schema, type InferSchemaType } from 'mongoose';

/**
 * Exception queue. Anything the system can't auto-resolve confidently lands
 * here. Idris's "5–10 minutes a day" target means this queue should be small;
 * everything routine is silent.
 *
 * Comments embed because they're tied to one discrepancy and almost always
 * read with the parent.
 */

const DiscrepancyCommentSubSchema = new Schema(
  {
    authorEmail: { type: String, required: true },
    body: { type: String, required: true },
    ts: { type: Date, default: () => new Date() },
    /** @-mentions (emails) — drives notifications. */
    mentions: { type: [String], default: [] },
  },
  { _id: true },
);

const SubjectRefSubSchema = new Schema(
  {
    kind: {
      type: String,
      required: true,
      enum: [
        'payment-entry',
        'sap-payment',
        'invoice',
        'credit-note',
        'zreport',
        'bank-line',
        'import-row',
      ],
    },
    /** ObjectId for our docs, numeric DocEntry for SAP refs (stringified). */
    id: { type: String, required: true },
  },
  { _id: false },
);

export const DiscrepancyTypes = [
  'unmatched-payment',
  'unmatched-invoice',
  'amount-mismatch',
  'duplicate',
  'drawer-gap',
  'unknown-counterparty',
  'sap-push-failed',
  'manual',
] as const;

export const DiscrepancySchema = new Schema(
  {
    type: { type: String, required: true, enum: DiscrepancyTypes, index: true },

    /** Refs to whatever this discrepancy is about — usually 1–3 things. */
    subjects: { type: [SubjectRefSubSchema], default: [] },

    // Money context (denormalised for display + filtering)
    amount: Number,
    currency: { type: String, default: 'EUR' },
    cardCode: { type: String, index: true },
    cardName: String,
    occurredOn: { type: Date, index: true },

    // Workflow
    status: {
      type: String,
      enum: ['open', 'in-review', 'resolved', 'wont-fix'],
      default: 'open',
      index: true,
    },
    priority: {
      type: String,
      enum: ['low', 'medium', 'high', 'urgent'],
      default: 'medium',
      index: true,
    },

    // Assignment + SLA
    assignedToEmail: { type: String, default: null, index: true },
    assignedAt: Date,
    assignedByEmail: String,
    dueAt: Date,
    slaBreachedAt: Date,

    // Resolution (filled when status = resolved)
    resolutionId: { type: Schema.Types.ObjectId, ref: 'Resolution', default: null },
    resolvedAt: Date,
    resolvedByEmail: String,

    // Comment thread
    comments: { type: [DiscrepancyCommentSubSchema], default: [] },

    // System hints — what the matcher was thinking when it gave up
    suggestedMatches: {
      type: [
        new Schema(
          {
            invoiceDocEntry: Number,
            paymentEntryId: Schema.Types.ObjectId,
            sapPaymentDocEntry: Number,
            confidence: Number,
            reason: String,
          },
          { _id: false },
        ),
      ],
      default: [],
    },

    /** Free-form metadata (stack trace for sap-push-failed, raw row for import errors, etc.). */
    metadata: { type: Schema.Types.Mixed, default: null },
  },
  {
    timestamps: true,
    collection: 'discrepancies',
  },
);

DiscrepancySchema.index({ status: 1, priority: 1, dueAt: 1 });
DiscrepancySchema.index({ type: 1, status: 1 });
DiscrepancySchema.index({ assignedToEmail: 1, status: 1 });
DiscrepancySchema.index({ cardCode: 1, status: 1 });

export type IDiscrepancy = InferSchemaType<typeof DiscrepancySchema>;
