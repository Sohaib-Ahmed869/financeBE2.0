import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

const RoleSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },

    /**
     * Scope. `null` = template (not assignable directly). Otherwise the role
     * applies only when granted on this specific company.
     */
    companyKey: { type: String, default: null, index: true },

    /** System roles (Owner, Accountant) cannot be deleted. */
    isSystemRole: { type: Boolean, default: false },

    permissionKeys: { type: [String], default: [], index: true },
  },
  { timestamps: true, collection: 'roles' },
);

RoleSchema.index({ companyKey: 1, name: 1 }, { unique: true });

export type IRole = InferSchemaType<typeof RoleSchema> & { _id: Schema.Types.ObjectId };
export type RoleDoc = HydratedDocument<IRole>;
export const Role = model<IRole>('Role', RoleSchema);
