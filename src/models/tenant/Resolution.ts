import { Schema, type InferSchemaType } from 'mongoose';

/**
 * What was done to close a discrepancy. Kept as a separate collection (not
 * embedded on Discrepancy) because:
 *   1) one resolution can spawn multiple PaymentMatch rows,
 *   2) the AI suggestion engine queries resolutions independently of their
 *      parent discrepancies to learn patterns.
 */
export const ResolutionSchema = new Schema(
  {
    discrepancyId: {
      type: Schema.Types.ObjectId,
      ref: 'Discrepancy',
      required: true,
      index: true,
    },

    /** What kind of resolution was applied. */
    action: {
      type: String,
      required: true,
      enum: [
        'manual-match',
        'split-match',
        'apply-credit-note',
        'create-correction-entry',
        'override-amount',
        'mark-fraudulent',
        'mark-duplicate',
        'mark-wont-fix',
        'other',
      ],
      index: true,
    },

    /** Free-text justification — required for high-risk actions. */
    reason: String,

    /** PaymentMatch rows produced by this resolution. */
    createdMatchIds: {
      type: [{ type: Schema.Types.ObjectId, ref: 'PaymentMatch' }],
      default: [],
    },

    // Provenance
    resolvedByEmail: { type: String, required: true, index: true },
    resolvedAt: { type: Date, default: () => new Date(), index: true },

    // For maker-checker workflows (high-risk actions)
    requiresApproval: { type: Boolean, default: false },
    approvedByEmail: String,
    approvedAt: Date,

    // System self-confidence in this resolution (for auto-resolved cases)
    confidence: { type: Number, min: 0, max: 1, default: 1 },

    // Whether to feed this resolution back into the LearnedPattern model
    learn: { type: Boolean, default: true, index: true },

    /** Snapshot of the discrepancy state at resolution time — for audit. */
    snapshot: { type: Schema.Types.Mixed, default: null },
  },
  {
    timestamps: true,
    collection: 'resolutions',
  },
);

ResolutionSchema.index({ resolvedByEmail: 1, resolvedAt: -1 });
ResolutionSchema.index({ action: 1, resolvedAt: -1 });

export type IResolution = InferSchemaType<typeof ResolutionSchema>;
