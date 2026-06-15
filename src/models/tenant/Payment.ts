import { Schema, type InferSchemaType } from 'mongoose';

/**
 * Cached SAP Incoming Payment (ORCT + RCT1/2/3/4). Read-model only.
 *
 * Important: this is the SAP-side payment cache. Our **own** payment-sheet
 * entries (the new "one sheet, every method" flow) live in a separate
 * `PaymentEntry` model. The split is deliberate:
 *
 *   - `Payment`       = mirror of what's in SAP. Source of truth.
 *   - `PaymentEntry`  = what the accountant typed into our sheet, awaiting
 *                       push to SAP. Once pushed and confirmed, the matching
 *                       `Payment` row will appear here on the next sync.
 *
 * `PaymentInvoices` is the SAP-side application array (which invoices a
 * single payment was applied to inside SAP). Our cross-cutting reconciliation
 * links live in `PaymentMatch`, not here.
 */
const PaymentInvoiceLineSubSchema = new Schema(
  {
    LineNum: Number,
    DocEntry: Number,
    SumApplied: Number,
    AppliedFC: Number,
    AppliedSys: Number,
    DocRate: Number,
    DocLine: Number,
    InvoiceType: String,
    DiscountPercent: Number,
    PaidSum: Number,
    InstallmentId: Number,
    WitholdingTaxApplied: Number,
    WitholdingTaxAppliedFC: Number,
    WitholdingTaxAppliedSC: Number,
    LinkDate: Date,
    TotalDiscount: Number,
    TotalDiscountFC: Number,
    TotalDiscountSC: Number,
  },
  { _id: false, strict: false },
);

export const PaymentSchema = new Schema(
  {
    // Identity
    DocEntry: { type: Number, required: true, unique: true, index: true },
    DocNum: { type: Number, index: true },
    DocType: String,
    HandWritten: String,
    Printed: String,
    DocObjectCode: String,
    Series: Number,

    // Dates
    DocDate: { type: Date, index: true },
    DueDate: Date,
    TaxDate: Date,
    VatDate: Date,
    TransferDate: Date,

    // Business Partner
    CardCode: { type: String, index: true },
    CardName: String,
    Address: String,

    // Payment routing — these are the "method" indicators that tell us which
    // RCT sub-table SAP wrote into.
    CashAccount: String,
    CashSum: Number,
    CashSumFC: Number,
    CashSumSys: Number,

    CheckAccount: String,

    TransferAccount: String,
    TransferSum: Number,
    TransferReference: String,

    // Currency / rates
    DocCurrency: String,
    LocalCurrency: String,
    DocRate: Number,

    // Discounts / bank charges
    DiscountPercent: Number,
    BankChargeAmount: Number,
    BankChargeAmountInFC: Number,
    BankChargeAmountInSC: Number,

    // Reference / memo
    Reference1: String,
    Reference2: String,
    CounterReference: String,
    Remarks: String,
    JournalRemarks: String,

    // Bank pay-to
    PayToBankCode: String,
    PayToBankBranch: String,
    PayToBankAccountNo: String,
    PayToCode: String,
    PayToBankCountry: String,
    IsPayToBank: String,

    // Status / authorisation
    Cancelled: String,
    AuthorizationStatus: String,
    PaymentPriority: String,

    // Tax / VAT
    ApplyVAT: String,
    WTAmount: Number,
    WTAmountFC: Number,
    WTAmountSC: Number,
    WTAccount: String,
    WTTaxableAmount: Number,

    // Misc
    ControlAccount: String,
    JournalMemo: String,
    Project: String,
    Indicator: String,
    BPLId: Number,
    BPLName: String,
    VATRegNum: String,

    // Custom UDFs from v1
    U_BP_Confd: String,
    U_BP_DocNr: String,
    U_BP_Seque: String,

    // SAP application sub-tables (which invoices THIS SAP payment hit)
    PaymentInvoices: { type: [PaymentInvoiceLineSubSchema], default: [] },
    // The four RCT sub-tables — captured loosely; shapes vary by method.
    PaymentChecks: { type: [Schema.Types.Mixed], default: undefined },
    PaymentCreditCards: { type: [Schema.Types.Mixed], default: undefined },
    PaymentAccounts: { type: [Schema.Types.Mixed], default: undefined },

    // Sync metadata
    sapCreationDate: Date,
    sapUpdateDate: Date,
    lastSyncedAt: { type: Date, default: () => new Date(), index: true },
  },
  {
    timestamps: true,
    collection: 'payments',
    strict: false,
  },
);

PaymentSchema.index({ CardCode: 1, DocDate: -1 });
PaymentSchema.index({ DocDate: -1 });
PaymentSchema.index({ DocNum: 1 });
// Useful for the future POS verification flow:
PaymentSchema.index({ 'PaymentInvoices.DocEntry': 1 });

export type IPayment = InferSchemaType<typeof PaymentSchema>;
