import { User } from '../../models/master/User';
import { AuthSession } from '../../models/master/AuthSession';
import { UserCompanyAccess } from '../../models/master/UserCompanyAccess';
import { ConflictError, NotFoundError } from '../../lib/errors';
import { hashPassword } from '../auth/auth.service';
import { audit } from '../../lib/audit';
import type {
  CreateUserInput,
  UpdateUserInput,
  ListUsersQuery,
  ResetPasswordInput,
} from './users.validators';

interface ActorMeta {
  actorUserId: string;
  actorEmail: string;
  ip: string;
}

function publicUser(u: {
  _id: { toString(): string };
  email: string;
  name: string;
  language: 'en' | 'fr';
  isSuperAdmin: boolean;
  active: boolean;
  lastLoginAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}) {
  return {
    id: u._id.toString(),
    email: u.email,
    name: u.name,
    language: u.language,
    isSuperAdmin: u.isSuperAdmin,
    active: u.active,
    lastLoginAt: u.lastLoginAt ?? null,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
}

export async function listUsers(query: ListUsersQuery) {
  const filter: Record<string, unknown> = {};
  if (query.q) {
    filter.$or = [
      { email: { $regex: query.q, $options: 'i' } },
      { name: { $regex: query.q, $options: 'i' } },
    ];
  }
  if (query.active !== undefined) filter.active = query.active;

  const total = await User.countDocuments(filter);
  const docs = await User.find(filter)
    .sort({ createdAt: -1 })
    .skip((query.page - 1) * query.limit)
    .limit(query.limit)
    .lean();

  return {
    items: docs.map((u) => publicUser(u as Parameters<typeof publicUser>[0])),
    total,
    page: query.page,
    limit: query.limit,
    pages: Math.max(1, Math.ceil(total / query.limit)),
  };
}

export async function getUser(id: string) {
  const u = await User.findById(id).lean();
  if (!u) throw new NotFoundError('User');
  return publicUser(u as Parameters<typeof publicUser>[0]);
}

export async function createUser(input: CreateUserInput, actor: ActorMeta) {
  const exists = await User.findOne({ email: input.email }).lean();
  if (exists) throw new ConflictError('A user with this email already exists');
  const passwordHash = await hashPassword(input.password);
  const created = await User.create({
    email: input.email,
    name: input.name,
    language: input.language,
    isSuperAdmin: input.isSuperAdmin,
    passwordHash,
    active: true,
  });
  await audit({
    action: 'users.create',
    actorUserId: actor.actorUserId,
    actorEmail: actor.actorEmail,
    subjectType: 'User',
    subjectId: created._id.toString(),
    after: { email: created.email, name: created.name, isSuperAdmin: created.isSuperAdmin },
    ip: actor.ip,
  });
  return publicUser(created);
}

export async function updateUser(id: string, patch: UpdateUserInput, actor: ActorMeta) {
  const user = await User.findById(id);
  if (!user) throw new NotFoundError('User');
  const before = {
    name: user.name,
    language: user.language,
    active: user.active,
    isSuperAdmin: user.isSuperAdmin,
  };
  if (patch.name !== undefined) user.name = patch.name;
  if (patch.language !== undefined) user.language = patch.language;
  if (patch.active !== undefined) user.active = patch.active;
  if (patch.isSuperAdmin !== undefined) user.isSuperAdmin = patch.isSuperAdmin;
  await user.save();

  // If we just deactivated, revoke all sessions immediately.
  if (patch.active === false) {
    await AuthSession.updateMany(
      { userId: id, revokedAt: null },
      { $set: { revokedAt: new Date(), revokeReason: 'user_deactivated' } },
    );
  }

  await audit({
    action: 'users.update',
    actorUserId: actor.actorUserId,
    actorEmail: actor.actorEmail,
    subjectType: 'User',
    subjectId: id,
    before,
    after: {
      name: user.name,
      language: user.language,
      active: user.active,
      isSuperAdmin: user.isSuperAdmin,
    },
    ip: actor.ip,
  });
  return publicUser(user);
}

export async function deactivateUser(id: string, actor: ActorMeta) {
  const user = await User.findById(id);
  if (!user) throw new NotFoundError('User');
  user.active = false;
  await user.save();
  await UserCompanyAccess.updateMany(
    { userId: id, active: true },
    { $set: { active: false, revokedAt: new Date(), revokeReason: 'user_deactivated' } },
  );
  await AuthSession.updateMany(
    { userId: id, revokedAt: null },
    { $set: { revokedAt: new Date(), revokeReason: 'user_deactivated' } },
  );
  await audit({
    action: 'users.deactivate',
    actorUserId: actor.actorUserId,
    actorEmail: actor.actorEmail,
    subjectType: 'User',
    subjectId: id,
    ip: actor.ip,
  });
  return publicUser(user);
}

export async function resetUserPassword(id: string, input: ResetPasswordInput, actor: ActorMeta) {
  const user = await User.findById(id).select('+passwordHash');
  if (!user) throw new NotFoundError('User');
  user.passwordHash = await hashPassword(input.newPassword);
  user.passwordChangedAt = new Date();
  user.failedLoginAttempts = 0;
  user.lockedUntil = null;
  await user.save();

  await AuthSession.updateMany(
    { userId: id, revokedAt: null },
    { $set: { revokedAt: new Date(), revokeReason: 'admin_password_reset' } },
  );

  await audit({
    action: 'users.reset_password',
    actorUserId: actor.actorUserId,
    actorEmail: actor.actorEmail,
    subjectType: 'User',
    subjectId: id,
    ip: actor.ip,
  });
}
