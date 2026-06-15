import { Types } from 'mongoose';
import { UserCompanyAccess } from '../../models/master/UserCompanyAccess';
import { Role } from '../../models/master/Role';
import { User } from '../../models/master/User';
import { Company } from '../../models/master/Company';
import { BadRequestError, ConflictError, NotFoundError } from '../../lib/errors';
import { audit } from '../../lib/audit';
import type {
  GrantAccessInput,
  UpdateAccessInput,
  RevokeAccessInput,
  ListAccessQuery,
} from './access.validators';

interface ActorMeta {
  actorUserId: string;
  actorEmail: string;
  ip: string;
}

async function ensureRolesValidForCompany(roleIds: string[], companyKey: string) {
  const roles = await Role.find({ _id: { $in: roleIds } }).lean();
  if (roles.length !== roleIds.length) {
    throw new BadRequestError('One or more roles not found');
  }
  for (const r of roles) {
    if (r.companyKey !== null && r.companyKey !== companyKey) {
      throw new BadRequestError(
        `Role '${r.name}' is scoped to company '${r.companyKey}', not '${companyKey}'`,
      );
    }
  }
}

export async function grantAccess(input: GrantAccessInput, actor: ActorMeta) {
  const [user, company] = await Promise.all([
    User.findById(input.userId).lean(),
    Company.findOne({ key: input.companyKey }).lean(),
  ]);
  if (!user) throw new NotFoundError('User');
  if (!company) throw new NotFoundError('Company');

  await ensureRolesValidForCompany(input.roleIds, input.companyKey);

  const existing = await UserCompanyAccess.findOne({
    userId: input.userId,
    companyKey: input.companyKey,
  });
  if (existing && existing.active) {
    throw new ConflictError('User already has access to this company; update instead');
  }

  const doc = existing
    ? await UserCompanyAccess.findByIdAndUpdate(
        existing._id,
        {
          $set: {
            roleIds: input.roleIds.map((id) => new Types.ObjectId(id)),
            active: true,
            grantedBy: new Types.ObjectId(actor.actorUserId),
            grantedAt: new Date(),
            revokedAt: null,
            revokeReason: null,
          },
        },
        { new: true },
      )
    : await UserCompanyAccess.create({
        userId: new Types.ObjectId(input.userId),
        companyKey: input.companyKey,
        roleIds: input.roleIds.map((id) => new Types.ObjectId(id)),
        grantedBy: new Types.ObjectId(actor.actorUserId),
      });

  await audit({
    action: 'access.grant',
    actorUserId: actor.actorUserId,
    actorEmail: actor.actorEmail,
    subjectType: 'UserCompanyAccess',
    subjectId: doc!._id.toString(),
    companyKey: input.companyKey,
    after: { userId: input.userId, roleIds: input.roleIds },
    ip: actor.ip,
  });

  return publicAccess(doc!.toObject());
}

export async function updateAccess(id: string, patch: UpdateAccessInput, actor: ActorMeta) {
  const access = await UserCompanyAccess.findById(id);
  if (!access) throw new NotFoundError('Access');
  await ensureRolesValidForCompany(patch.roleIds, access.companyKey);
  const before = { roleIds: access.roleIds.map((r) => r.toString()) };
  access.roleIds = patch.roleIds.map((id) => new Types.ObjectId(id));
  await access.save();
  await audit({
    action: 'access.update',
    actorUserId: actor.actorUserId,
    actorEmail: actor.actorEmail,
    subjectType: 'UserCompanyAccess',
    subjectId: id,
    companyKey: access.companyKey,
    before,
    after: { roleIds: patch.roleIds },
    ip: actor.ip,
  });
  return publicAccess(access.toObject());
}

export async function revokeAccess(id: string, input: RevokeAccessInput, actor: ActorMeta) {
  const access = await UserCompanyAccess.findById(id);
  if (!access) throw new NotFoundError('Access');
  if (!access.active) return publicAccess(access.toObject());
  access.active = false;
  access.revokedAt = new Date();
  access.revokeReason = input.reason ?? 'manual_revoke';
  await access.save();
  await audit({
    action: 'access.revoke',
    actorUserId: actor.actorUserId,
    actorEmail: actor.actorEmail,
    subjectType: 'UserCompanyAccess',
    subjectId: id,
    companyKey: access.companyKey,
    reason: input.reason,
    ip: actor.ip,
  });
  return publicAccess(access.toObject());
}

export async function listAccess(query: ListAccessQuery) {
  const filter: Record<string, unknown> = {};
  if (query.userId) filter.userId = new Types.ObjectId(query.userId);
  if (query.companyKey) filter.companyKey = query.companyKey;
  if (query.active !== undefined) filter.active = query.active;
  const docs = await UserCompanyAccess.find(filter).sort({ createdAt: -1 }).lean();
  return docs.map((d) => publicAccess(d as Parameters<typeof publicAccess>[0]));
}

function publicAccess(d: {
  _id: { toString(): string };
  userId: { toString(): string };
  companyKey: string;
  roleIds: Array<{ toString(): string }>;
  active: boolean;
  grantedBy?: { toString(): string } | null;
  grantedAt?: Date;
  revokedAt?: Date | null;
  revokeReason?: string | null;
}) {
  return {
    id: d._id.toString(),
    userId: d.userId.toString(),
    companyKey: d.companyKey,
    roleIds: d.roleIds.map((r) => r.toString()),
    active: d.active,
    grantedBy: d.grantedBy ? d.grantedBy.toString() : null,
    grantedAt: d.grantedAt ?? null,
    revokedAt: d.revokedAt ?? null,
    revokeReason: d.revokeReason ?? null,
  };
}
