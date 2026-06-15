/**
 * Common fields across SAP B1 marketing documents
 * (Invoice / SalesOrder / DeliveryNote / CreditNote / Return).
 *
 * Spread into each model's schema definition. `as const` preserves the
 * literal types so Mongoose's `InferSchemaType` infers properly through
 * the spread.
 */
export const marketingDocFields = {
  // Identity
  DocEntry: { type: Number, required: true, unique: true, index: true },
  DocNum: { type: Number, index: true },
  DocType: String,
  HandWritten: String,
  Printed: String,
  DocObjectCode: String,

  // Dates
  DocDate: { type: Date, index: true },
  DocDueDate: Date,
  TaxDate: Date,
  CreationDate: Date,
  UpdateDate: Date,
  CancelDate: Date,
  ClosingDate: Date,
  VatDate: Date,
  RequriedDate: Date, // SAP's spelling
  AssetValueDate: Date,
  StartDeliveryDate: Date,
  EndDeliveryDate: Date,

  // Business Partner
  CardCode: { type: String, index: true },
  CardName: String,
  Address: String,
  Address2: String,
  NumAtCard: String,
  ShipToCode: String,
  PayToCode: String,
  ContactPersonCode: String,

  // Currency / amounts
  DocCurrency: String,
  DocRate: Number,
  DocTotal: Number,
  DocTotalFc: Number,
  DocTotalSys: Number,
  VatSum: Number,
  VatSumSys: Number,
  VatSumFc: Number,
  VatPercent: Number,
  TotalDiscount: Number,
  TotalDiscountFC: Number,
  TotalDiscountSC: Number,
  Rounding: String,
  RoundingDiffAmount: Number,
  RoundingDiffAmountFC: Number,
  RoundingDiffAmountSC: Number,
  DiscountPercent: Number,
  DownPayment: Number,
  DownPaymentAmount: Number,
  DownPaymentAmountSC: Number,
  DownPaymentAmountFC: Number,
  DownPaymentPercentage: Number,
  DownPaymentType: String,
  DownPaymentStatus: String,
  PaidToDate: Number,
  PaidToDateFC: Number,
  PaidToDateSys: Number,
  BaseAmount: Number,
  BaseAmountSC: Number,
  BaseAmountFC: Number,

  // Withholding / equalisation tax
  WTApplied: Number,
  WTAppliedFC: Number,
  WTAppliedSC: Number,
  WTAmount: Number,
  WTAmountFC: Number,
  WTAmountSC: Number,
  WTNonSubjectAmount: Number,
  WTNonSubjectAmountSC: Number,
  WTNonSubjectAmountFC: Number,
  WTExemptedAmount: Number,
  WTExemptedAmountSC: Number,
  WTExemptedAmountFC: Number,
  TotalEqualizationTax: Number,
  TotalEqualizationTaxFC: Number,
  TotalEqualizationTaxSC: Number,
  TaxExemptionLetterNum: String,

  // Status
  DocumentStatus: { type: String, index: true },
  Cancelled: String,
  CancelStatus: String,
  Confirmed: String,
  Submitted: String,
  PickStatus: String,
  Pick: String,
  AuthorizationStatus: String,
  AuthorizationCode: String,
  PartialSupply: String,
  Indicator: String,
  PaymentBlock: String,
  PaymentBlockEntry: String,
  BlockDunning: String,

  // Series / numbering
  Series: Number,
  SeriesString: String,
  SubSeriesString: String,
  SequenceCode: String,
  SequenceSerial: String,
  SequenceModel: String,
  GroupSeries: String,
  GroupNumber: String,
  GroupHandWritten: String,
  ManualNumber: String,
  FolioPrefixString: String,
  FolioNumber: String,
  FolioNumberFrom: String,
  FolioNumberTo: String,
  ExternalCorrectedDocNum: String,
  InternalCorrectedDocNum: String,
  NextCorrectingDocument: String,

  // References / comments
  Reference1: String,
  Reference2: String,
  Comments: String,
  JournalMemo: String,
  PaymentReference: String,
  TrackingNumber: String,
  PickRemark: String,
  OpeningRemarks: String,
  ClosingRemarks: String,
  RevisionPo: String,

  // Sales / payment / routing
  SalesPersonCode: Number,
  TransportationCode: Number,
  PaymentGroupCode: Number,
  AgentCode: String,
  DocTime: String,
  Project: String,
  ControlAccount: String,
  Segment: Number,
  FinancialPeriod: Number,
  TransNum: Number,
  UserSign: Number,
  PriceMode: String,
  NetProcedure: String,
  PaymentMethod: String,

  // Branch / regulatory
  BPL_IDAssignedToInvoice: String,
  BPLName: String,
  VATRegNum: String,
  FederalTaxID: String,
  DocumentTaxID: String,
  CentralBankIndicator: String,
  Reserve: String,
  ReserveInvoice: String,
  ReuseDocumentNum: String,
  ReuseNotaFiscalNum: String,

  // Chain reference (Quotation → Order → DN → Invoice)
  BaseType: Number,
  BaseEntry: String,

  // Bank for pay-to
  IsPayToBank: String,
  PayToBankCountry: String,
  PayToBankCode: String,
  PayToBankAccountNo: String,
  PayToBankBranch: String,

  // Custom UDFs (carried over from v1)
  U_Route: String,
  U_Notes: String,
  U_CCSurcharge: String,
  U_SurchargeRate: Number,
  U_PrintedDate: Date,
  U_HHEmpID: String,
  U_EPOSNo: String,
  U_B1IFDocEntry: String,
  U_U_ROUTENUMBER: String,
  U_U_ROUTEPAYMETHOD: String,
  U_U_ROUTEORDER: String,
  U_U_ROUTEPAYAMOUNT: String,

  // Our sync metadata (cache freshness)
  lastSyncedAt: { type: Date, default: () => new Date(), index: true },
} as const;
