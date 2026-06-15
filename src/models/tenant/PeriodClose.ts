import { Schema, type InferSchemaType } from 'mongoose';

/**
 * Month locks. One document per `yearMonth` ('2026-02', '2026-03', ...).
 * A locked period blocks edits to source data dated within it; only
 * correcting journal entries are allowed afterwards.
 */
export const PeriodCloseSchema = new Schema(
  {
    yearMonth: {
      type: String,
      required: true,
      unique: true,
      match: /^\d{4}-(0[1-9]|1[0-2])$/,
      index: true,
    },

    locked: { type: Boolean, default: false, index: true },
    lockedAt: Date,
    lockedByEmail: String,
    lockReason: String,

    // Reopen tracking — kept as an array so we keep the full reopen history.
    reopens: [
      {
        reopenedAt: Date,
        reopenedByEmail: String,
        reason: String,
        relockedAt: Date,
        relockedByEmail: String,
      },
    ],

    // Snapshot at the time of locking — useful for "what did the books look
    // like when we signed off"?
    snapshot: {
      invoicesTotal: Number,
      paymentsTotal: Number,
      creditNotesTotal: Number,
      openInvoicesCount: Number,
      capturedAt: Date,
    },
  },
  {
    timestamps: true,
    collection: 'period_close',
  },
);

export type IPeriodClose = InferSchemaType<typeof PeriodCloseSchema>;
