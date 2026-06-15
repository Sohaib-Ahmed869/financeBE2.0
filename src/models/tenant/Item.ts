import { Schema, type InferSchemaType } from 'mongoose';

/**
 * Cached SAP B1 Item. Read-model only — we never write back to this collection
 * from app code; the sync worker upserts it from the SAP `/Items` endpoint
 * keyed by `ItemCode`.
 *
 * Mirrors the most useful SAP fields needed for in-app invoice creation
 * (picking items, pre-filling unit price + sales VAT group, filtering active
 * items). The schema is `strict: false` so SAP can hand us any extra field
 * it has and we cache it without losing data.
 */

/** Per-price-list pricing row from SAP `ItemPrices[]`. */
const ItemPriceSubSchema = new Schema(
  {
    PriceList: Number,
    Price: Number,
    Currency: String,
    AdditionalPrice1: Number,
    AdditionalCurrency1: String,
    AdditionalPrice2: Number,
    AdditionalCurrency2: String,
    BasePriceList: Number,
    Factor: Number,
    UoMPrices: { type: [Schema.Types.Mixed], default: [] },
  },
  { _id: false, strict: false },
);

/** Per-warehouse stock row from SAP `ItemWarehouseInfoCollection[]`. */
const ItemWarehouseInfoSubSchema = new Schema(
  {
    WarehouseCode: String,
    InStock: Number,
    Committed: Number,
    Ordered: Number,
    MinimalStock: Number,
    MaximalStock: Number,
    StandardAveragePrice: Number,
  },
  { _id: false, strict: false },
);

export const ItemSchema = new Schema(
  {
    // Identity
    ItemCode: { type: String, required: true, unique: true, index: true },
    ItemName: { type: String, required: true },
    ForeignName: String,
    BarCode: String,

    // Classification
    ItemsGroupCode: Number,
    ItemType: String, // 'itItems' | 'itLabor' | 'itTravel' | 'itFixedAssets'
    Manufacturer: Number,
    DefaultWarehouse: String,

    // Flags — all "tYES" / "tNO" strings in SAP
    SalesItem: String,
    PurchaseItem: String,
    InventoryItem: String,
    Frozen: String,
    Valid: String,
    ValidFrom: Date,
    ValidTo: Date,
    FrozenFrom: Date,
    FrozenTo: Date,

    // UoM
    InventoryUOM: String,
    SalesUnit: String,
    PurchaseUnit: String,
    SalesItemsPerUnit: Number,
    PurchaseItemsPerUnit: Number,

    // Tax (drives invoice line `TaxCode` defaulting)
    VATLiable: String,
    SalesVATGroup: String,
    PurchaseVATGroup: String,
    TaxType: String,

    // Pricing — full SAP array (per price list) plus a flattened convenience.
    ItemPrices: { type: [ItemPriceSubSchema], default: [] },
    /**
     * The price from the first entry in `ItemPrices` (usually the customer-
     * facing price list). Pre-flattened so the invoice form can use it
     * without having to remember which price list to pick.
     */
    defaultUnitPrice: { type: Number, default: null, index: true },

    // Stock (informational only — invoice creation never decrements this)
    QuantityOnStock: Number,
    QuantityOrderedFromVendors: Number,
    QuantityOrderedByCustomers: Number,
    ItemWarehouseInfoCollection: { type: [ItemWarehouseInfoSubSchema], default: [] },

    // SAP timestamps
    CreateDate: Date,
    UpdateDate: Date,

    /**
     * App-managed cost history. SAP's batch-level cost data is unreliable
     * historically (per Idris 14/05/2026), so we maintain our own per-period
     * average cost overlay for KPI reports. Each entry is inclusive on both
     * ends. Lookups for a given date pick the latest entry whose [from, to]
     * range contains the date.
     *
     * SAP never writes this field — the sync uses `$set` and doesn't include
     * `costHistory` in the upsert payload, so our overlay survives every
     * refresh.
     */
    costHistory: {
      type: [
        new Schema(
          {
            from: { type: Date, required: true },
            to: { type: Date, required: true },
            avgCost: { type: Number, required: true, min: 0 },
            currency: { type: String, default: 'EUR' },
            source: { type: String, default: '' },
            uploadedAt: { type: Date, default: () => new Date() },
            uploadedByEmail: { type: String, default: '' },
            notes: { type: String, default: '' },
          },
          { _id: false },
        ),
      ],
      default: [],
    },

    // Sync metadata
    lastSyncedAt: { type: Date, default: () => new Date(), index: true },
  },
  {
    timestamps: true,
    collection: 'items',
    strict: false,
  },
);

// Search / filter indexes
ItemSchema.index({ ItemName: 'text', ItemCode: 'text', ForeignName: 'text', BarCode: 'text' });
ItemSchema.index({ ItemsGroupCode: 1 });
ItemSchema.index({ SalesItem: 1, Frozen: 1, Valid: 1 });

export type IItem = InferSchemaType<typeof ItemSchema>;
