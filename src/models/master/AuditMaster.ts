import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

const AuditMasterSchema = new Schema(
  {
    ts: { type: Date, required: true, index: true },
    actorUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    actorEmail: { type: String, default: null },
    action: { type: String, required: true, index: true },
    subjectType: { type: String, default: null, index: true },
    subjectId: { type: String, default: null, index: true },
    companyKey: { type: String, default: null, index: true },
    ip: { type: String, default: null },
    userAgent: { type: String, default: null },
    before: { type: Schema.Types.Mixed, default: null },
    after: { type: Schema.Types.Mixed, default: null },
    reason: { type: String, default: null },
    /** sha256(prevHash || canonicalJSON(entry)) — append-only chain. */
    prevHash: { type: String, required: true },
    hash: { type: String, required: true, index: true },
  },
  { collection: 'audit_master' },
);

AuditMasterSchema.index({ ts: -1 });

export type IAuditMaster = InferSchemaType<typeof AuditMasterSchema> & {
  _id: Schema.Types.ObjectId;
};
export type AuditMasterDoc = HydratedDocument<IAuditMaster>;
export const AuditMaster = model<IAuditMaster>('AuditMaster', AuditMasterSchema);
