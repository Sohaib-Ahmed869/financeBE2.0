import { Schema, type InferSchemaType } from 'mongoose';

/**
 * Distilled pattern learned from prior `Resolution`s. The matcher consults
 * this collection BEFORE falling back to `MatchingRule`-based logic, so
 * "what the team did last time" wins over "what the rule book says".
 *
 * `signature` is a stable hash of the salient features of the pattern (e.g.
 * "method=Bank,counterparty=`X`,amountRange=…") so we can dedupe and bump
 * `hits` when the same pattern recurs.
 */
export const LearnedPatternSchema = new Schema(
  {
    signature: { type: String, required: true, unique: true, index: true },

    description: { type: String, required: true },

    /** Snapshot of the features that make this pattern recognisable. */
    features: { type: Schema.Types.Mixed, required: true },

    suggestedAction: {
      type: String,
      enum: [
        'auto-match',
        'apply-credit-note',
        'create-correction-entry',
        'mark-duplicate',
        'mark-wont-fix',
      ],
      required: true,
    },

    confidence: { type: Number, min: 0, max: 1, default: 0.5, index: true },

    // Telemetry
    hits: { type: Number, default: 1, index: true },
    misses: { type: Number, default: 0 },
    lastUsedAt: Date,
    createdAt: { type: Date, default: () => new Date() },

    /** Resolution rows this pattern was distilled from — for audit. */
    sourceResolutionIds: {
      type: [{ type: Schema.Types.ObjectId, ref: 'Resolution' }],
      default: [],
    },

    // Embedding vector (optional — populated when AI semantic match is on).
    // Stored as plain number array; a vector-search index is added at the DB
    // level via Atlas when we wire that.
    embedding: { type: [Number], default: undefined },
    embeddingModel: String,

    /** Pattern can be disabled without deletion (e.g. when a customer changes payment habits). */
    active: { type: Boolean, default: true, index: true },
  },
  {
    collection: 'learned_patterns',
  },
);

LearnedPatternSchema.index({ active: 1, confidence: -1 });

export type ILearnedPattern = InferSchemaType<typeof LearnedPatternSchema>;
