import { Schema, type InferSchemaType } from 'mongoose';

/**
 * Header for a third-party payment-export upload (PayPal, Sogecommerce, etc.)
 * before normalisation into PaymentEntry rows. The actual transaction rows
 * live in `ImportRow`.
 */
export const ImportFileSchema = new Schema(
  {
    provider: {
      type: String,
      required: true,
      enum: ['paypal', 'sogecommerce-site', 'sogecommerce-phone', 'other'],
      index: true,
    },

    periodStart: { type: Date, index: true },
    periodEnd: Date,

    rawFileId: { type: Schema.Types.ObjectId, ref: 'Document', default: null },

    status: {
      type: String,
      enum: ['pending', 'parsed', 'imported', 'partial', 'failed'],
      default: 'pending',
      index: true,
    },

    // Counts (rolled up from rows)
    parsedRowCount: { type: Number, default: 0 },
    successRowCount: { type: Number, default: 0 },
    skippedRowCount: { type: Number, default: 0 },
    errorRowCount: { type: Number, default: 0 },

    // Money summary
    totalAmount: { type: Number, default: 0 },
    currency: { type: String, default: 'EUR' },

    uploadedByEmail: { type: String, required: true, index: true },
    uploadedAt: { type: Date, default: () => new Date() },
    parsedAt: Date,
    importedAt: Date,
    parseError: String,
  },
  {
    timestamps: true,
    collection: 'import_files',
  },
);

ImportFileSchema.index({ provider: 1, periodStart: -1 });

export type IImportFile = InferSchemaType<typeof ImportFileSchema>;
