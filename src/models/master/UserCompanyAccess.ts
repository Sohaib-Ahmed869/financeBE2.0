import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

const UserCompanyAccessSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    companyKey: { type: String, required: true, index: true },
    roleIds: { type: [Schema.Types.ObjectId], ref: 'Role', default: [] },

    active: { type: Boolean, default: true, index: true },

    grantedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    grantedAt: { type: Date, default: () => new Date() },
    revokedAt: { type: Date, default: null },
    revokeReason: { type: String, default: null },
  },
  { timestamps: true, collection: 'user_company_access' },
);

UserCompanyAccessSchema.index({ userId: 1, companyKey: 1 }, { unique: true });

export type IUserCompanyAccess = InferSchemaType<typeof UserCompanyAccessSchema> & {
  _id: Schema.Types.ObjectId;
};
export type UserCompanyAccessDoc = HydratedDocument<IUserCompanyAccess>;
export const UserCompanyAccess = model<IUserCompanyAccess>(
  'UserCompanyAccess',
  UserCompanyAccessSchema,
);
