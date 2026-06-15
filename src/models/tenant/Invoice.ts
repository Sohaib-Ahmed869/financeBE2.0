import { Schema, type InferSchemaType } from 'mongoose';
import { marketingDocFields } from './_shared/marketingDoc';
import { DocumentLineSchema } from './_shared/documentLine';

/**
 * Cached SAP A/R Invoice. Read-model only.
 *
 * v1 wedged the entire reconciliation/allocation system onto this collection
 * (verified, paymentTracking, allocatedPayments, paymentBreakdown,
 *  hasCreditNotes, paymentSyncStatus, SyncedWithSAP/SAPDocEntry/LocalStatus,
 *  etc.). All cut. In v2 those concerns live in the dedicated `PaymentMatch`
 * model. The Invoice itself just mirrors SAP.
 *
 * "Is this invoice paid?" is computed from SAP's own `DocTotal` /
 * `PaidToDate` fields plus our `PaymentMatch` links — never stored here.
 */
export const InvoiceSchema = new Schema(
  {
    ...marketingDocFields,

    // Invoice-specific
    SummeryType: String,
    Form1099: String,
    Box1099: String,
    GTSChecker: String,
    GTSPayee: String,
    BillOfExchangeReserved: String,
    NumberOfInstallments: Number,
    ApplyTaxOnFirstInstallment: String,
    DeferredTax: String,
    UseShpdGoodsAct: String,

    // Linked Delivery Note (the chain we build the bulk-convert flow around)
    OriginatingDeliveryNote: Number,
    U_LocalDocNum: String,
    U_SourceDeliveryNote: String,

    // Lines
    DocumentLines: [DocumentLineSchema],

    // Approvals captured loosely (SAP shape varies)
    Document_ApprovalRequests: { type: [Schema.Types.Mixed], default: undefined },
  },
  {
    timestamps: true,
    collection: 'invoices',
    strict: false,
  },
);

InvoiceSchema.index({ CardCode: 1, DocDate: -1 });
InvoiceSchema.index({ DocumentStatus: 1, DocDate: -1 });
InvoiceSchema.index({ DocNum: 1 });
InvoiceSchema.index({ OriginatingDeliveryNote: 1 });

export type IInvoice = InferSchemaType<typeof InvoiceSchema>;
