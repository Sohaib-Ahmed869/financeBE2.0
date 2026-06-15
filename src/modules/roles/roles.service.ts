import { Role } from '../../models/master/Role';
import { Permission } from '../../models/master/Permission';
import { UserCompanyAccess } from '../../models/master/UserCompanyAccess';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../../lib/errors';
import { audit } from '../../lib/audit';
import type { CreateRoleInput, UpdateRoleInput, ListRolesQuery } from './roles.validators';

interface ActorMeta {
  actorUserId: string;
  actorEmail: string;
  ip: string;
}

function publicRole(r: {
  _id: { toString(): string };
  name: string;
  description: string;
  companyKey?: string | null;
  isSystemRole: boolean;
  permissionKeys: string[];
  createdAt?: Date;
  updatedAt?: Date;
}) {
  return {
    id: r._id.toString(),
    name: r.name,
    description: r.description,
    companyKey: r.companyKey ?? null,
    isSystemRole: r.isSystemRole,
    permissionKeys: r.permissionKeys,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

async function validatePermissionKeys(keys: string[]) {
  if (keys.length === 0) return;
  const valid = await Permission.find({ key: { $in: keys } }, { key: 1 }).lean();
  const validSet = new Set(valid.map((p) => p.key));
  const unknown = keys.filter((k) => !validSet.has(k));
  if (unknown.length > 0) {
    throw new BadRequestError(`Unknown permission key(s): ${unknown.join(', ')}`);
  }
}

export async function listRoles(query: ListRolesQuery) {
  const filter: Record<string, unknown> = {};
  if (query.companyKey !== undefined) {
    filter.$or = [{ companyKey: query.companyKey }, { companyKey: null }];
  }
  if (query.q) filter.name = { $regex: query.q, $options: 'i' };
  const docs = await Role.find(filter).sort({ isSystemRole: -1, name: 1 }).lean();
  return docs.map((r) => publicRole(r as Parameters<typeof publicRole>[0]));
}

export async function getRole(id: string) {
  const r = await Role.findById(id).lean();
  if (!r) throw new NotFoundError('Role');
  return publicRole(r as Parameters<typeof publicRole>[0]);
}

export async function createRole(input: CreateRoleInput, actor: ActorMeta) {
  await validatePermissionKeys(input.permissionKeys);
  const existing = await Role.findOne({ name: input.name, companyKey: input.companyKey }).lean();
  if (existing) {
    throw new ConflictError(
      `A role named '${input.name}' already exists for this scope`,
    );
  }
  const created = await Role.create({
    name: input.name,
    description: input.description,
    companyKey: input.companyKey,
    permissionKeys: input.permissionKeys,
    isSystemRole: false,
  });
  await audit({
    action: 'roles.create',
    actorUserId: actor.actorUserId,
    actorEmail: actor.actorEmail,
    subjectType: 'Role',
    subjectId: created._id.toString(),
    companyKey: input.companyKey ?? undefined,
    after: { name: created.name, permissionKeys: created.permissionKeys },
    ip: actor.ip,
  });
  return publicRole(created);
}

export async function updateRole(id: string, patch: UpdateRoleInput, actor: ActorMeta) {
  const role = await Role.findById(id);
  if (!role) throw new NotFoundError('Role');
  if (role.isSystemRole && (patch.name !== undefined || patch.permissionKeys !== undefined)) {
    throw new ForbiddenError('System roles cannot be renamed or have their permissions edited');
  }
  if (patch.permissionKeys) await validatePermissionKeys(patch.permissionKeys);

  const before = {
    name: role.name,
    description: role.description,
    permissionKeys: role.permissionKeys.slice(),
  };
  if (patch.name !== undefined) role.name = patch.name;
  if (patch.description !== undefined) role.description = patch.description;
  if (patch.permissionKeys !== undefined) role.permissionKeys = patch.permissionKeys;
  await role.save();
  await audit({
    action: 'roles.update',
    actorUserId: actor.actorUserId,
    actorEmail: actor.actorEmail,
    subjectType: 'Role',
    subjectId: id,
    companyKey: role.companyKey ?? undefined,
    before,
    after: {
      name: role.name,
      description: role.description,
      permissionKeys: role.permissionKeys,
    },
    ip: actor.ip,
  });
  return publicRole(role);
}

export async function deleteRole(id: string, actor: ActorMeta) {
  const role = await Role.findById(id);
  if (!role) throw new NotFoundError('Role');
  if (role.isSystemRole) throw new ForbiddenError('System roles cannot be deleted');

  const inUse = await UserCompanyAccess.countDocuments({ roleIds: role._id });
  if (inUse > 0) {
    throw new ConflictError(
      `Cannot delete: role is assigned to ${inUse} user(s). Revoke first.`,
    );
  }
  await role.deleteOne();
  await audit({
    action: 'roles.delete',
    actorUserId: actor.actorUserId,
    actorEmail: actor.actorEmail,
    subjectType: 'Role',
    subjectId: id,
    companyKey: role.companyKey ?? undefined,
    before: { name: role.name, permissionKeys: role.permissionKeys },
    ip: actor.ip,
  });
}
