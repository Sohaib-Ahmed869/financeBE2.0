import { Schema, type InferSchemaType } from 'mongoose';
import { marketingDocFields } from './_shared/marketingDoc';
import { DocumentLineSchema } from './_shared/documentLine';

/**
 * Cached SAP A/R Credit Note. Read-model only.
 *
 * v1 attached `allocatedToInvoices`, `remainingAmount`, `fullyAllocated`,
 * `SyncedWithSAP`, `LocalStatus` directly to the credit note. All cut.
 * Allocation in v2 lives in the dedicated `PaymentMatch` model alongside
 * cash/bank/card payments — credit notes are just another way of "applying
 * something to an invoice".
 */
export const CreditNoteSchema = new Schema(
  {
    ...marketingDocFields,

    // CN-specific
    SummeryType: String,
    IssuingReason: Number,
    OriginalRefNo: String,
    OriginalRefDate: Date,
    OriginalCreditOrDebitNo: String,
    OriginalCreditOrDebitDate: Date,
    GSTTransactionType: String,
    EDocType: String,

    // Lines
    DocumentLines: [DocumentLineSchema],

    Document_ApprovalRequests: { type: [Schema.Types.Mixed], default: undefined },
  },
  {
    timestamps: true,
    collection: 'credit_notes',
    strict: false,
  },
);

CreditNoteSchema.index({ CardCode: 1, DocDate: -1 });
CreditNoteSchema.index({ DocumentStatus: 1, DocDate: -1 });
CreditNoteSchema.index({ DocNum: 1 });
// `BaseEntry` points back to the source Invoice — useful for "show all credits
// against this invoice".
CreditNoteSchema.index({ BaseEntry: 1 });

export type ICreditNote = InferSchemaType<typeof CreditNoteSchema>;
