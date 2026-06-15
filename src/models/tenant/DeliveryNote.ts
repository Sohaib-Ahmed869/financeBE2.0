import { Schema, type InferSchemaType } from 'mongoose';
import { marketingDocFields } from './_shared/marketingDoc';
import { DocumentLineSchema } from './_shared/documentLine';

/**
 * Cached SAP Delivery Note. Read-model only.
 *
 * The morning bulk-convert flow ("drivers return → multi-select open DNs →
 * convert to invoice") drives the indexes here: we want fast `where status =
 * open and date >= today` queries.
 */
export const DeliveryNoteSchema = new Schema(
  {
    ...marketingDocFields,

    // DN-specific
    OriginatingSalesOrder: Number,
    StartDeliveryTime: String,
    EndDeliveryTime: String,
    VehiclePlate: String,
    DocumentDelivery: String,

    // Lines
    DocumentLines: [DocumentLineSchema],

    Document_ApprovalRequests: { type: [Schema.Types.Mixed], default: undefined },
  },
  {
    timestamps: true,
    collection: 'delivery_notes',
    strict: false,
  },
);

DeliveryNoteSchema.index({ CardCode: 1, DocDate: -1 });
// "Open delivery notes for today" — the headline read pattern for the
// bulk-convert screen.
DeliveryNoteSchema.index({ DocumentStatus: 1, DocDate: -1 });
DeliveryNoteSchema.index({ DocNum: 1 });
DeliveryNoteSchema.index({ OriginatingSalesOrder: 1 });

export type IDeliveryNote = InferSchemaType<typeof DeliveryNoteSchema>;
