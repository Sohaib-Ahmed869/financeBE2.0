import { Schema, type InferSchemaType } from 'mongoose';
import { marketingDocFields } from './_shared/marketingDoc';
import { DocumentLineSchema } from './_shared/documentLine';

/**
 * Cached SAP Sales Order. Read-model only.
 *
 * v1 added local sync flags (`SyncedWithSAP`, `SAPDocEntry`, `LocalStatus`,
 * `SyncErrors`, `LastSyncAttempt`, `SAPSyncDisabled`) and v1-payment-link
 * integration (`Payment_id`, `Link_sent`, `payment_status`) — both cut.
 */
export const SalesOrderSchema = new Schema(
  {
    ...marketingDocFields,

    // SO-specific
    OriginatingQuotation: Number,
    CancelReason: String,
    DocTotalWithVAT: Number,
    PriceList: { type: Number, default: 2 },
    InsuranceOperation347: String,
    ArchiveNonremovableSalesQuotation: String,

    // Lines
    DocumentLines: [DocumentLineSchema],

    Document_ApprovalRequests: { type: [Schema.Types.Mixed], default: undefined },
  },
  {
    timestamps: true,
    collection: 'sales_orders',
    strict: false,
  },
);

SalesOrderSchema.index({ CardCode: 1, DocDate: -1 });
SalesOrderSchema.index({ DocumentStatus: 1, DocDate: -1 });
SalesOrderSchema.index({ DocNum: 1 });

export type ISalesOrder = InferSchemaType<typeof SalesOrderSchema>;
