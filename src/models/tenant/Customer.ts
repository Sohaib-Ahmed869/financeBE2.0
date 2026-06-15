import { Schema, type InferSchemaType } from 'mongoose';

/** Simplified billing/shipping address (kept flat for fast querying). */
const AddressSubSchema = new Schema(
  {
    street: { type: String, default: '' },
    zipCode: { type: String, default: '' },
    city: { type: String, default: '' },
    country: { type: String, default: 'France' },
  },
  { _id: false },
);

/** Faithful capture of SAP's BPAddresses array entry. */
const BPAddressSubSchema = new Schema(
  {
    AddressName: String,
    AddressName2: String,
    AddressName3: String,
    Street: String,
    StreetNo: String,
    BuildingFloorRoom: String,
    Block: String,
    ZipCode: String,
    City: String,
    County: String,
    State: String,
    Country: String,
    AddressType: { type: String, enum: ['bo_BillTo', 'bo_ShipTo'] },
    RowNum: Number,
    CreateDate: Date,
    CreateTime: String,
  },
  { _id: false, strict: false },
);

/**
 * Cached SAP Business Partner (customer / lead). Read-model only — we never
 * write back. Keyed by SAP `CardCode`.
 *
 * v1 carried CRM/marketing fields (assignedTo, hubspotId, uberEatsUrl,
 * coordinates, approval workflow, allocation totals, etc.) — all stripped
 * per the v2 scope decision. Nothing here that isn't a SAP-side fact about
 * the partner.
 */
export const CustomerSchema = new Schema(
  {
    CardCode: { type: String, required: true, unique: true, index: true },
    CardName: { type: String, required: true },
    CardType: String, // 'cCustomer' | 'cLid' | 'cSupplier'
    GroupCode: Number,

    // Contact
    EmailAddress: String,
    Phone1: String,
    Phone2: String,
    Fax: String,
    Notes: String,

    // Tax / regulatory (from SAP)
    VatLiable: String,
    VatGroup: String,
    VATRegNum: String,
    FederalTaxID: String,
    SubjectToWithholdingTax: String,

    // Currency / balance (from SAP)
    Currency: String,
    CurrentAccountBalance: { type: Number, default: 0 },
    CurrentAccountBalanceFC: { type: Number, default: 0 },
    CurrentAccountBalanceSys: { type: Number, default: 0 },

    // Pricing / payment terms
    PriceListNum: Number,
    PaymentTermsGroupCode: Number,
    PaymentMethodCode: String,

    // Status
    Frozen: String, // 'tYES' | 'tNO'
    Valid: String,
    ValidFrom: Date,
    ValidTo: Date,

    // Addresses — keep both shapes:
    //   - flat `address` / `deliveryAddress` for cheap querying / display
    //   - SAP-faithful `BPAddresses[]` for completeness
    address: { type: AddressSubSchema, default: () => ({}) },
    deliveryAddress: { type: AddressSubSchema, default: () => ({}) },
    BPAddresses: [BPAddressSubSchema],

    // SAP timestamps (separate from our Mongo `createdAt`/`updatedAt`)
    sapCreationDate: Date,
    sapUpdateDate: Date,

    // Sync metadata
    lastSyncedAt: { type: Date, default: () => new Date(), index: true },
  },
  {
    timestamps: true,
    collection: 'customers',
    strict: false,
  },
);

CustomerSchema.index({ CardName: 'text', CardCode: 'text', EmailAddress: 'text' });
CustomerSchema.index({ Currency: 1 });
CustomerSchema.index({ CurrentAccountBalance: 1 });

export type ICustomer = InferSchemaType<typeof CustomerSchema>;
