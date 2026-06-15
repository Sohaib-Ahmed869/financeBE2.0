import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

const AuthSessionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    userAgent: { type: String, default: '' },
    ip: { type: String, default: '' },
    createdAt: { type: Date, default: () => new Date() },
    lastUsedAt: { type: Date, default: () => new Date() },
    expiresAt: { type: Date, required: true, index: true },
    revokedAt: { type: Date, default: null, index: true },
    revokeReason: { type: String, default: null },
  },
  { collection: 'auth_sessions' },
);

// Mongo TTL — auto-purge expired sessions one hour after expiry.
AuthSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 });

export type IAuthSession = InferSchemaType<typeof AuthSessionSchema> & {
  _id: Schema.Types.ObjectId;
};
export type AuthSessionDoc = HydratedDocument<IAuthSession>;
export const AuthSession = model<IAuthSession>('AuthSession', AuthSessionSchema);
