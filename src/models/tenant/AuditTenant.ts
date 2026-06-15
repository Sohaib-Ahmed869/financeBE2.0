import { Schema, type InferSchemaType } from 'mongoose';

/**
 * Per-tenant operational audit log. Append-only, hash-chained.
 *
 * Differs from the master `AuditMaster` collection (which lives in the master
 * DB and tracks security/admin actions: login, role change, company
 * config). This per-company chain captures the day-to-day finance actions:
 * payment created, discrepancy resolved, period closed, match overridden,
 * tag applied, document uploaded, etc.
 *
 * Hash = sha256(prevHash || canonicalJSON(entry)) — same shape as master.
 */
export const AuditTenantSchema = new Schema(
  {
    ts: { type: Date, required: true, index: true },
    actorUserId: { type: String, default: null, index: true },
    actorEmail: { type: String, default: null, index: true },

    action: { type: String, required: true, index: true },
    subjectType: { type: String, default: null, index: true },
    subjectId: { type: String, default: null, index: true },

    ip: String,
    userAgent: String,

    before: { type: Schema.Types.Mixed, default: null },
    after: { type: Schema.Types.Mixed, default: null },
    reason: String,

    prevHash: { type: String, required: true },
    hash: { type: String, required: true, index: true },
  },
  {
    collection: 'audit_tenant',
  },
);

AuditTenantSchema.index({ ts: -1 });
AuditTenantSchema.index({ subjectType: 1, subjectId: 1, ts: -1 });

export type IAuditTenant = InferSchemaType<typeof AuditTenantSchema>;
