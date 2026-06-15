import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

const SapSubSchema = new Schema(
  {
    baseUrl: { type: String, default: '' },
    companyDB: { type: String, default: '' },
    username: { type: String, default: '' },
    /** AES-256-GCM encrypted (base64). Decrypt only at point of SAP call. */
    password: { type: String, default: '' },
  },
  { _id: false },
);

const CompanySchema = new Schema(
  {
    /** Stable URL/header key — paris | bordeaux | lyon */
    key: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: /^[a-z0-9-]{2,40}$/,
    },
    name: { type: String, required: true, trim: true },

    /** AES-256-GCM encrypted (base64). NEVER store plaintext. */
    mongoUri: { type: String, required: true },

    sap: { type: SapSubSchema, required: true, default: () => ({}) },

    /** SAP UDF field name used to mark POS payments (per-tenant configurable). */
    posUdfFieldName: { type: String, default: 'U_POS_Source' },

    /**
     * SAP CardCodes that represent sibling HFS branches. Used by the
     * delivery-channel tagger: a payment whose CardCode is in this list is
     * classified as `own-company` (inter-company) for KPI reports.
     * Configured per-tenant — e.g. when active company is Paris, this would
     * list the Bordeaux + Lyon partner card codes.
     */
    ownCompanyCardCodes: { type: [String], default: [] },

    currency: { type: String, default: 'EUR' },
    timezone: { type: String, default: 'Europe/Paris' },
    locale: { type: String, default: 'fr-FR' },

    active: { type: Boolean, default: true, index: true },
  },
  { timestamps: true, collection: 'companies' },
);

CompanySchema.index({ key: 1 }, { unique: true });

export type ICompany = InferSchemaType<typeof CompanySchema> & { _id: Schema.Types.ObjectId };
export type CompanyDoc = HydratedDocument<ICompany>;
export const Company = model<ICompany>('Company', CompanySchema);
