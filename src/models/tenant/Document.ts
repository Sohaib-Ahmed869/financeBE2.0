import { Schema, type InferSchemaType } from 'mongoose';

/**
 * Vault entry for any uploaded file: Z-reports, bank statements, PayPal /
 * Sogecommerce exports, invoice attachments, etc. The actual bytes live in
 * object storage; this row is the metadata + processing state.
 */
export const DocumentSchema = new Schema(
  {
    kind: {
      type: String,
      required: true,
      index: true,
      enum: [
        'zreport',
        'bank-statement',
        'paypal-export',
        'sogecommerce-export',
        'invoice-attachment',
        'other',
      ],
    },

    // File identity
    originalName: { type: String, required: true },
    mimeType: String,
    size: Number,
    sha256: { type: String, index: true }, // dedupe + tamper detection

    // Storage
    storageProvider: {
      type: String,
      enum: ['s3', 'azure-blob', 'gcs', 'local'],
      default: 's3',
    },
    storageKey: { type: String, required: true },
    storageBucket: String,
    storageUrl: String, // optional CDN/signed URL cache

    // Upload metadata
    uploadedByEmail: { type: String, required: true, index: true },
    uploadedAt: { type: Date, default: () => new Date(), index: true },

    // Processing pipeline
    processingStatus: {
      type: String,
      enum: ['pending', 'processing', 'processed', 'failed', 'skipped'],
      default: 'pending',
      index: true,
    },
    processingStartedAt: Date,
    processingFinishedAt: Date,
    processingError: String,

    // Soft links back to whatever consumed this document — e.g. a ZReport,
    // BankStatement, ImportFile. We don't enforce ref'd-collection identity
    // because the same file can feed multiple downstream entities (rare but
    // possible — e.g. a CSV that's both an import AND a bank-statement view).
    relatedRefs: [
      {
        kind: {
          type: String,
          enum: ['zreport', 'bank-statement', 'import-file', 'other'],
        },
        id: { type: Schema.Types.ObjectId },
        _id: false,
      },
    ],

    // Period / classification hints (optional, set by the parser)
    periodStart: Date,
    periodEnd: Date,
    notes: String,
  },
  {
    timestamps: true,
    collection: 'documents',
  },
);

DocumentSchema.index({ kind: 1, uploadedAt: -1 });
DocumentSchema.index({ processingStatus: 1, uploadedAt: -1 });

export type IDocument = InferSchemaType<typeof DocumentSchema>;
