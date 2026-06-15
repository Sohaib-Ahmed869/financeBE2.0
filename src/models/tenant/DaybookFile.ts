import { Schema, type InferSchemaType } from 'mongoose';

/**
 * One uploaded "Feuille de solde" workbook (one per month, per company).
 * Each file produces N `DaybookDay` rows — one for every parseable sheet
 * (day of the month). Re-uploading the same file replaces the prior parse;
 * uploads are deduped by sha256.
 */
export const DaybookFileSchema = new Schema(
  {
    /** Server-side filename (uuid + ext). */
    storedFilename: { type: String, required: true },
    /** Original filename as the user uploaded it. */
    originalFilename: { type: String, required: true },
    /** SHA-256 of the file bytes — used to detect re-upload of the same workbook. */
    sha256: { type: String, required: true, index: true },
    fileSize: { type: Number, required: true },

    /** Parsed from filename ("Avril 2026" → 4 / 2026). null when filename can't be parsed. */
    monthLabel: { type: String, default: null },
    year: { type: Number, default: null, index: true },
    month: { type: Number, default: null, index: true, min: 1, max: 12 },

    uploadedByUserId: { type: Schema.Types.ObjectId, required: true },
    uploadedByEmail: { type: String, required: true },

    status: {
      type: String,
      enum: ['parsed', 'partial', 'failed'],
      default: 'parsed',
      index: true,
    },
    daysParsed: { type: Number, default: 0 },
    parseErrors: { type: [String], default: [] },
  },
  { timestamps: true, collection: 'daybook_files' },
);

DaybookFileSchema.index({ year: 1, month: 1 });
DaybookFileSchema.index({ sha256: 1 });

export type IDaybookFile = InferSchemaType<typeof DaybookFileSchema>;
