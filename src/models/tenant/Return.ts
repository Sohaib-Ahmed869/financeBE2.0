import { Schema, type InferSchemaType } from 'mongoose';
import { marketingDocFields } from './_shared/marketingDoc';
import { DocumentLineSchema } from './_shared/documentLine';

/**
 * Cached SAP Goods Return. Read-model only.
 *
 * v1 had a few bespoke virtuals/methods (`totalWithVAT`, `calculateTotalVolume`,
 * `getFormattedShippingAddress`, static finders) — all dropped from the
 * persistence layer. UI-side computation belongs in services/components, not
 * on the model.
 */

const TaxExtensionSubSchema = new Schema(
  {
    StreetS: String,
    CityS: String,
    ZipCodeS: String,
    CountryS: String,
    StreetB: String,
    CityB: String,
    ZipCodeB: String,
    CountryB: String,
    ImportOrExportType: String,
  },
  { _id: false, strict: false },
);

const AddressExtensionSubSchema = new Schema(
  {
    ShipToStreet: String,
    ShipToCity: String,
    ShipToZipCode: String,
    ShipToCountry: String,
    BillToStreet: String,
    BillToCity: String,
    BillToZipCode: String,
    BillToCountry: String,
  },
  { _id: false, strict: false },
);

export const ReturnSchema = new Schema(
  {
    ...marketingDocFields,

    // Return-specific
    OriginatingDeliveryNote: Number,
    TaxExtension: { type: TaxExtensionSubSchema, default: undefined },
    AddressExtension: { type: AddressExtensionSubSchema, default: undefined },

    DocumentLines: [DocumentLineSchema],
  },
  {
    timestamps: true,
    collection: 'returns',
    strict: false,
  },
);

ReturnSchema.index({ CardCode: 1, DocDate: -1 });
ReturnSchema.index({ DocumentStatus: 1, DocDate: -1 });
ReturnSchema.index({ DocNum: 1 });
ReturnSchema.index({ BaseEntry: 1 });

export type IReturn = InferSchemaType<typeof ReturnSchema>;
