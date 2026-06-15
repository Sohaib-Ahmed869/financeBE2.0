import argon2 from 'argon2';
import { User, type UserDoc } from '../../models/master/User';
import { AuthSession } from '../../models/master/AuthSession';
import { UserCompanyAccess } from '../../models/master/UserCompanyAccess';
import { Role } from '../../models/master/Role';
import { Company } from '../../models/master/Company';
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from '../../lib/errors';
import { signSessionToken } from '../../lib/jwt';
import { env } from '../../config/env';
import { audit } from '../../lib/audit';
import { PERMISSION_KEYS } from '../../lib/permissions.catalog';

const MAX_FAILED = 8;
const LOCK_MINUTES = 15;

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

export interface LoginOk {
  user: UserDoc;
  sessionId: string;
  token: string;
  expiresAt: Date;
}

export async function login(
  email: string,
  password: string,
  meta: { ip: string; userAgent: string },
): Promise<LoginOk> {
  const user = await User.findOne({ email: email.toLowerCase() }).select('+passwordHash');
  if (!user) {
    // Same response as bad password to prevent enumeration.
    throw new UnauthorizedError('Invalid email or password');
  }
  if (!user.active) throw new ForbiddenError('Account is deactivated');
  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    throw new ForbiddenError('Account temporarily locked. Try again later.');
  }

  const ok = await verifyPassword(user.passwordHash, password);
  if (!ok) {
    user.failedLoginAttempts = (user.failedLoginAttempts ?? 0) + 1;
    if (user.failedLoginAttempts >= MAX_FAILED) {
      user.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60 * 1000);
      user.failedLoginAttempts = 0;
    }
    await user.save();
    throw new UnauthorizedError('Invalid email or password');
  }

  user.failedLoginAttempts = 0;
  user.lockedUntil = null;
  user.lastLoginAt = new Date();
  await user.save();

  const expiresAt = new Date(Date.now() + env.SESSION_TTL_HOURS * 60 * 60 * 1000);
  const session = await AuthSession.create({
    userId: user._id,
    userAgent: meta.userAgent,
    ip: meta.ip,
    expiresAt,
  });

  const token = signSessionToken(
    { sub: user._id.toString(), jti: session._id.toString() },
    env.SESSION_TTL_HOURS,
  );

  await audit({
    action: 'auth.login',
    actorUserId: user._id.toString(),
    actorEmail: user.email,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });

  return { user, sessionId: session._id.toString(), token, expiresAt };
}

export async function logout(sessionId: string, actorEmail: string, ip: string): Promise<void> {
  await AuthSession.updateOne(
    { _id: sessionId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokeReason: 'logout' } },
  );
  await audit({ action: 'auth.logout', actorEmail, ip });
}

/**
 * The /me payload: profile + companies the user can see + per-company roles.
 * If `activeCompanyKey` is provided, also returns the union of permissions for it.
 */
export async function getMe(userId: string, activeCompanyKey?: string) {
  const user = await User.findById(userId).lean();
  if (!user) throw new NotFoundError('User');

  const accesses = await UserCompanyAccess.find({ userId, active: true }).lean();
  const companyKeys = accesses.map((a) => a.companyKey);
  const companies = await Company.find(
    { key: { $in: companyKeys }, active: true },
    { key: 1, name: 1, currency: 1, locale: 1, timezone: 1 },
  ).lean();

  const roleIds = accesses.flatMap((a) => a.roleIds);
  const roles = await Role.find({ _id: { $in: roleIds } }).lean();
  const roleById = new Map(roles.map((r) => [r._id.toString(), r]));

  const companyRows = companies.map((c) => {
    const access = accesses.find((a) => a.companyKey === c.key)!;
    const userRoles = access.roleIds
      .map((id) => roleById.get(id.toString()))
      .filter(Boolean)
      .map((r) => ({ id: r!._id.toString(), name: r!.name, isSystemRole: r!.isSystemRole }));
    return {
      key: c.key,
      name: c.name,
      currency: c.currency,
      locale: c.locale,
      timezone: c.timezone,
      roles: userRoles,
    };
  });

  let permissions: string[] | null = null;
  if (activeCompanyKey) {
    if (user.isSuperAdmin) {
      permissions = PERMISSION_KEYS.slice();
    } else {
      const access = accesses.find((a) => a.companyKey === activeCompanyKey);
      if (access) {
        const set = new Set<string>();
        for (const id of access.roleIds) {
          const r = roleById.get(id.toString());
          if (r) for (const k of r.permissionKeys) set.add(k);
        }
        permissions = Array.from(set);
      } else {
        permissions = [];
      }
    }
  }

  return {
    user: {
      id: user._id.toString(),
      email: user.email,
      name: user.name,
      language: user.language,
      isSuperAdmin: user.isSuperAdmin,
      lastLoginAt: user.lastLoginAt,
    },
    companies: companyRows,
    activeCompanyKey: activeCompanyKey ?? null,
    permissions,
  };
}

export async function updateMe(
  userId: string,
  patch: { name?: string; language?: 'en' | 'fr' },
  meta: { ip: string; actorEmail: string },
) {
  const user = await User.findById(userId);
  if (!user) throw new NotFoundError('User');
  const before = { name: user.name, language: user.language };
  if (patch.name !== undefined) user.name = patch.name;
  if (patch.language !== undefined) user.language = patch.language;
  await user.save();
  await audit({
    action: 'me.update',
    actorUserId: userId,
    actorEmail: meta.actorEmail,
    subjectType: 'User',
    subjectId: userId,
    before,
    after: { name: user.name, language: user.language },
    ip: meta.ip,
  });
  return user;
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  meta: { ip: string; actorEmail: string; sessionId: string },
) {
  const user = await User.findById(userId).select('+passwordHash');
  if (!user) throw new NotFoundError('User');
  const ok = await verifyPassword(user.passwordHash, currentPassword);
  if (!ok) throw new BadRequestError('Current password is incorrect');
  user.passwordHash = await hashPassword(newPassword);
  user.passwordChangedAt = new Date();
  await user.save();

  // Revoke all OTHER sessions to force fresh logins elsewhere.
  await AuthSession.updateMany(
    { userId, _id: { $ne: meta.sessionId }, revokedAt: null },
    { $set: { revokedAt: new Date(), revokeReason: 'password_changed' } },
  );

  await audit({
    action: 'me.change_password',
    actorUserId: userId,
    actorEmail: meta.actorEmail,
    subjectType: 'User',
    subjectId: userId,
    ip: meta.ip,
  });
}
