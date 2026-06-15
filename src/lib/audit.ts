import { sha256 } from './crypto';
import { AuditMaster } from '../models/master/AuditMaster';
import { logger } from './logger';

export interface AuditEntryInput {
  actorUserId?: string;
  actorEmail?: string;
  action: string;
  subjectType?: string;
  subjectId?: string;
  companyKey?: string;
  ip?: string;
  userAgent?: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  reason?: string;
}

interface CanonicalInput extends AuditEntryInput {
  ts: Date;
}

function canonical(input: CanonicalInput): string {
  return JSON.stringify({
    ts: input.ts.toISOString(),
    actorUserId: input.actorUserId ?? null,
    actorEmail: input.actorEmail ?? null,
    action: input.action,
    subjectType: input.subjectType ?? null,
    subjectId: input.subjectId ?? null,
    companyKey: input.companyKey ?? null,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
    before: input.before ?? null,
    after: input.after ?? null,
    reason: input.reason ?? null,
  });
}

/**
 * Genesis sentinel for the first audit entry's `prevHash`. The schema requires
 * a non-empty string (so a missing chain is loud, not silently empty), and
 * the chain itself stays verifiable: every later entry is sha256(prevHash || canonical(entry)),
 * starting from this constant.
 */
const AUDIT_GENESIS = 'GENESIS';

/**
 * Append-only, hash-chained audit entry. Hash = sha256(prevHash || canonical(entry)).
 * Failures are logged but do NOT throw — auditing must never block business operations,
 * but every gap is alarmable.
 */
export async function audit(input: AuditEntryInput): Promise<void> {
  try {
    const ts = new Date();
    const last = await AuditMaster.findOne({}, { hash: 1 }).sort({ ts: -1, _id: -1 }).lean();
    const prevHash = last?.hash ?? AUDIT_GENESIS;
    const partial = { ts, ...input };
    const hash = sha256(prevHash + canonical(partial));
    await AuditMaster.create({ ...partial, prevHash, hash });
  } catch (err) {
    logger.error({ err, input }, 'audit.failed');
  }
}
