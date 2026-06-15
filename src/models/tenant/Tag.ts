import { Schema, type InferSchemaType } from 'mongoose';

/**
 * User-defined tag for tag-based P&L roll-up. Tags are applied to invoices,
 * payments, bank lines, etc. (the linkage lives on the source doc, not here).
 */
export const TagSchema = new Schema(
  {
    /** Stable URL/lookup key — slug-style (lowercase, hyphens). */
    key: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: /^[a-z0-9-]{2,60}$/,
      index: true,
    },
    label: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    color: {
      type: String,
      default: '#0AADA9',
      match: /^#[0-9A-Fa-f]{6}$/,
    },

    /** Where this tag is intended to be used — drives the picker in the UI. */
    scope: {
      type: String,
      enum: ['sales', 'expense', 'customer', 'account', 'channel', 'region', 'other'],
      default: 'other',
      index: true,
    },

    /** Optional hierarchy — `parentKey` references another Tag's `key`. */
    parentKey: { type: String, default: null, index: true },

    active: { type: Boolean, default: true, index: true },
    createdByEmail: String,
  },
  {
    timestamps: true,
    collection: 'tags',
  },
);

TagSchema.index({ scope: 1, label: 1 });

export type ITag = InferSchemaType<typeof TagSchema>;
