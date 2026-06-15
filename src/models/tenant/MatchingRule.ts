import { Schema, type InferSchemaType } from 'mongoose';

/**
 * Per-tenant matching configuration. The reconciliation engine evaluates
 * rules in `priority` order (lower number = applied first); the first rule
 * whose conditions match decides the outcome.
 *
 * Replaces v1's hard-coded date/amount tolerances. New banks, new customers,
 * new payment processors can be onboarded without code.
 */
export const MatchingRuleSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },

    /** Where this rule applies. */
    scope: {
      type: String,
      required: true,
      enum: ['global', 'customer', 'method', 'bank'],
      default: 'global',
      index: true,
    },
    /** When `scope = customer`. */
    customerCardCode: { type: String, default: null, index: true },
    /** When `scope = method` — values match `PaymentEntry.method`. */
    method: { type: String, default: null },
    /** When `scope = bank` — values match `BankStatement.bankKey`. */
    bankKey: { type: String, default: null },

    // Conditions
    /** ± days the payment date may differ from the invoice date. */
    dateToleranceDays: { type: Number, default: 3, min: 0 },
    /** Absolute amount tolerance (currency units). */
    amountTolerance: { type: Number, default: 0, min: 0 },
    /** Percentage amount tolerance (0–1). */
    amountTolerancePercent: { type: Number, default: 0, min: 0, max: 1 },
    /**
     * Reference patterns — substrings or `/regex/` strings — that should be
     * looked for in the payment's reference / counterparty / description.
     */
    referencePatterns: { type: [String], default: [] },

    // Outcome
    action: {
      type: String,
      enum: ['auto-match', 'suggest', 'block'],
      default: 'auto-match',
    },
    /**
     * Confidence to assign on auto-match. Below the auto-resolve threshold
     * the result becomes a Discrepancy with this rule attached as a hint.
     */
    confidenceCeiling: { type: Number, min: 0, max: 1, default: 0.95 },

    priority: { type: Number, default: 100, index: true },
    active: { type: Boolean, default: true, index: true },

    createdByEmail: String,
    lastEditedByEmail: String,
    /** How many times this rule fired — useful for tuning. */
    hitCount: { type: Number, default: 0 },
    lastHitAt: Date,
  },
  {
    timestamps: true,
    collection: 'matching_rules',
  },
);

MatchingRuleSchema.index({ scope: 1, active: 1, priority: 1 });
MatchingRuleSchema.index({ name: 1 }, { unique: true });

export type IMatchingRule = InferSchemaType<typeof MatchingRuleSchema>;
