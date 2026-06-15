import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

const PermissionSchema = new Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    domain: { type: String, required: true, index: true },
    action: { type: String, required: true },
    description: { type: String, required: true },
    riskLevel: { type: String, enum: ['low', 'medium', 'high'], default: 'low' },
  },
  { timestamps: true, collection: 'permissions' },
);

PermissionSchema.index({ key: 1 }, { unique: true });

export type IPermission = InferSchemaType<typeof PermissionSchema> & {
  _id: Schema.Types.ObjectId;
};
export type PermissionDoc = HydratedDocument<IPermission>;
export const Permission = model<IPermission>('Permission', PermissionSchema);
