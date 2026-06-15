import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

const UserSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
      match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    },
    /** argon2id hash. Never returned by API. */
    passwordHash: { type: String, required: true, select: false },

    name: { type: String, required: true, trim: true },
    language: { type: String, enum: ['en', 'fr'], default: 'fr' },

    /** Bypasses per-company RBAC checks. Reserved for platform operators. */
    isSuperAdmin: { type: Boolean, default: false },
    active: { type: Boolean, default: true, index: true },

    failedLoginAttempts: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },

    lastLoginAt: { type: Date, default: null },
    passwordChangedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'users' },
);

UserSchema.index({ email: 1 }, { unique: true });

export type IUser = InferSchemaType<typeof UserSchema> & { _id: Schema.Types.ObjectId };
export type UserDoc = HydratedDocument<IUser>;
export const User = model<IUser>('User', UserSchema);
