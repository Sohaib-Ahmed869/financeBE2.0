import { Schema, type InferSchemaType } from 'mongoose';

/**
 * One row from a PayPal / Sogecommerce / similar export. After normalisation
 * + matching, becomes a `PaymentEntry`. Kept as a separate collection so we
 * can re-run the importer without losing per-row state.
 */
export const ImportRowSchema = new Schema(
  {
    importFileId: {
      type: Schema.Types.ObjectId,
      ref: 'ImportFile',
      required: true,
      index: true,
    },

    /** Provider's transaction id — drives idempotency on re-uploads. */
    transactionId: { type: String, required: true, index: true },

    // Raw row (the original CSV/JSON cell values, unparsed)
    raw: { type: Schema.Types.Mixed, default: null },

    // Normalised values (what we actually use)
    normalized: {
      date: Date,
      amount: Number,
      currency: { type: String, default: 'EUR' },
      method: String, // provider-side method ("PayPal Express", "Visa", …)
      payerName: String,
      payerEmail: String,
      cardCodeHint: String, // best-guess CardCode if we can extract it
      reference: String,
    },

    // Pipeline
    status: {
      type: String,
      enum: ['pending', 'matched', 'created-payment', 'duplicate', 'skipped', 'errored'],
      default: 'pending',
      index: true,
    },
    /** When status = 'created-payment', the resulting PaymentEntry row. */
    paymentEntryId: {
      type: Schema.Types.ObjectId,
      ref: 'PaymentEntry',
      default: null,
      index: true,
    },
    error: String,
    processedAt: Date,
  },
  {
    timestamps: true,
    collection: 'import_rows',
  },
);

// One transaction per file — re-uploading the same file shouldn't dupe rows.
ImportRowSchema.index({ importFileId: 1, transactionId: 1 }, { unique: true });
ImportRowSchema.index({ status: 1, createdAt: -1 });

export type IImportRow = InferSchemaType<typeof ImportRowSchema>;
