import { Schema } from 'mongoose';

/**
 * SAP B1 marketing-document line. A superset of the line shapes used across
 * Invoice / SalesOrder / DeliveryNote / CreditNote / Return.
 *
 * The schema intentionally has `strict: false` so any extra SAP field that
 * arrives (a new UDF, a region-specific tax field, etc.) is captured
 * losslessly. We define the high-value fields explicitly so they're typed
 * and indexable.
 */
export const DocumentLineSchema = new Schema(
  {
    LineNum: Number,
    ItemCode: String,
    ItemDescription: String,
    Quantity: Number,
    ShipDate: Date,
    Price: Number,
    PriceAfterVAT: Number,
    Currency: String,
    Rate: Number,
    DiscountPercent: Number,
    WarehouseCode: String,
    AccountCode: String,
    VatGroup: String,

    // Tax
    TaxCode: String,
    TaxType: String,
    TaxLiable: String,
    TaxPercentagePerRow: Number,
    TaxTotal: Number,
    AppliedTax: Number,
    AppliedTaxFC: Number,
    AppliedTaxSC: Number,
    NetTaxAmount: Number,
    NetTaxAmountFC: Number,
    NetTaxAmountSC: Number,

    // Totals
    LineTotal: Number,
    LineTotalWithVAT: Number,
    RowTotalFC: Number,
    RowTotalSC: Number,
    GrossPrice: Number,
    GrossTotal: Number,
    GrossTotalFC: Number,
    GrossTotalSC: Number,
    GrossBuyPrice: Number,
    GrossBase: Number,
    GrossProfit: Number,
    GrossProfitFC: Number,
    GrossProfitSC: Number,
    GrossProfitTotalBasePrice: Number,
    UnitPrice: Number,

    // Units / catalog
    UoMCode: String,
    UoMEntry: Number,
    PriceList: { type: Number, default: 2 },
    SalesPersonCode: Number,
    CommisionPercent: Number,
    SerialNum: String,
    CostingCode: String,
    CostingCode2: String,
    CostingCode3: String,
    CostingCode4: String,
    CostingCode5: String,
    ProjectCode: String,
    BarCode: String,
    SupplierCatNum: String,
    OriginalItem: String,

    // Document chain reference (Quotation → Order → DN → Invoice)
    BaseType: Number,
    BaseEntry: Number,
    BaseLine: Number,
    ActualBaseEntry: Number,
    ActualBaseLine: Number,

    // Status / open quantities
    LineStatus: String,
    PickStatus: String,
    PickStatusEx: String,
    PickQuantity: Number,
    PickListIdNumber: Number,
    BackOrder: String,
    OpenAmount: Number,
    OpenAmountFC: Number,
    OpenAmountSC: Number,
    BaseOpenQuantity: Number,
    RemainingOpenQuantity: Number,
    RemainingOpenInventoryQuantity: Number,
    InventoryQuantity: Number,
    PackageQuantity: Number,

    // Free text / display
    FreeText: String,
    Text: String,
    LineType: String,
    VisualOrder: Number,
    ItemDetails: String,
    ItemType: String,
    Address: String,
    LocationCode: String,
    ShipToCode: String,
    ShipToDescription: String,
    OwnerCode: String,
    ActualDeliveryDate: Date,
    RequiredDate: Date,
    RequiredQuantity: Number,

    // Physical dimensions
    Height1: Number,
    Hight1Unit: Number,
    Height2: Number,
    Height2Unit: Number,
    Lengh1: Number,
    Lengh1Unit: Number,
    Lengh2: Number,
    Lengh2Unit: Number,
    Width1: Number,
    Width1Unit: Number,
    Width2: Number,
    Width2Unit: Number,
    Weight1: Number,
    Weight1Unit: Number,
    Weight2: Number,
    Weight2Unit: Number,
    Volume: Number,
    VolumeUnit: Number,
    Factor1: Number,
    Factor2: Number,
    Factor3: Number,
    Factor4: Number,

    // Custom UDFs we know about
    U_PromotionName: String,
    U_PromotionExpiry: Date,
    U_FreeStock: String,
    U_CATEID: String,

    // Loose sub-arrays — captured but not modelled in detail; SAP shape varies.
    LineTaxJurisdictions: { type: [Schema.Types.Mixed], default: undefined },
    DocumentLineAdditionalExpenses: { type: [Schema.Types.Mixed], default: undefined },
    WithholdingTaxLines: { type: [Schema.Types.Mixed], default: undefined },
    SerialNumbers: { type: [Schema.Types.Mixed], default: undefined },
    BatchNumbers: { type: [Schema.Types.Mixed], default: undefined },
    DocumentLinesBinAllocations: { type: [Schema.Types.Mixed], default: undefined },
  },
  { _id: false, strict: false },
);
