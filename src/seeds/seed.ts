import 'dotenv/config';
import { Types } from 'mongoose';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { connectMaster, disconnectMaster } from '../db/master';
import { encrypt } from '../lib/crypto';
import { hashPassword } from '../modules/auth/auth.service';
import { Company } from '../models/master/Company';
import { Permission } from '../models/master/Permission';
import { Role } from '../models/master/Role';
import { User } from '../models/master/User';
import { UserCompanyAccess } from '../models/master/UserCompanyAccess';
import {
  PERMISSION_CATALOG,
  OWNER_PERMISSION_KEYS,
  ACCOUNTANT_PERMISSION_KEYS,
} from '../lib/permissions.catalog';

interface SeedCompany {
  key: string;
  name: string;
  mongoUri: string | undefined;
  sap: { baseUrl: string; companyDB: string; username: string; password: string };
}

const COMPANIES: SeedCompany[] = [
  {
    key: 'paris',
    name: 'MSF Halal Food Service — Paris',
    mongoUri: env.TENANT_PARIS_MONGO_URI,
    sap: {
      baseUrl: env.SAP_BASE_URL_PARIS ?? '',
      companyDB: env.SAP_COMPANY_DB_PARIS ?? 'MSF_HALAL_LIVE_NEW',
      username: env.SAP_USERNAME_PARIS ?? '',
      password: env.SAP_PASSWORD_PARIS ?? '',
    },
  },
  {
    key: 'bordeaux',
    name: 'MSF Halal Food Service — Bordeaux',
    mongoUri: env.TENANT_BORDEAUX_MONGO_URI,
    sap: {
      baseUrl: env.SAP_BASE_URL_BORDEAUX ?? '',
      companyDB: env.SAP_COMPANY_DB_BORDEAUX ?? 'A19865_HALAL_FOODSERVICE_BORDEAUX_NEW',
      username: env.SAP_USERNAME_BORDEAUX ?? '',
      password: env.SAP_PASSWORD_BORDEAUX ?? '',
    },
  },
  {
    key: 'lyon',
    name: 'MSF Halal Food Service — Lyon',
    mongoUri: env.TENANT_LYON_MONGO_URI,
    sap: {
      baseUrl: env.SAP_BASE_URL_LYON ?? '',
      companyDB: env.SAP_COMPANY_DB_LYON ?? 'A19865_HALAL_FOODSERVICE_LYON_NEW',
      username: env.SAP_USERNAME_LYON ?? '',
      password: env.SAP_PASSWORD_LYON ?? '',
    },
  },
];

async function seedPermissions() {
  for (const p of PERMISSION_CATALOG) {
    await Permission.updateOne(
      { key: p.key },
      {
        $set: {
          key: p.key,
          domain: p.domain,
          action: p.action,
          description: p.description,
          riskLevel: p.riskLevel,
        },
      },
      { upsert: true },
    );
  }
  // Remove permissions no longer in the catalog (cleanup).
  await Permission.deleteMany({ key: { $nin: PERMISSION_CATALOG.map((p) => p.key) } });
  logger.info({ count: PERMISSION_CATALOG.length }, 'seed.permissions.synced');
}

async function seedCompanies() {
  for (const c of COMPANIES) {
    if (!c.mongoUri) {
      logger.warn(
        { key: c.key },
        'seed.company.skipped (no mongo URI in env — set TENANT_*_MONGO_URI)',
      );
      continue;
    }
    const existing = await Company.findOne({ key: c.key });
    if (existing) {
      // Refresh SAP config from env so re-seeding fixes stale baseUrl/companyDB/username.
      // Password is only re-encrypted if env supplied one (avoids clobbering an in-app rotation
      // when SAP_PASSWORD_* is left blank).
      const sapPatch: Record<string, unknown> = {
        'sap.baseUrl': c.sap.baseUrl,
        'sap.companyDB': c.sap.companyDB,
        'sap.username': c.sap.username,
      };
      if (c.sap.password) sapPatch['sap.password'] = encrypt(c.sap.password);
      await Company.updateOne({ _id: existing._id }, { $set: sapPatch });
      logger.info(
        { key: c.key, companyDB: c.sap.companyDB },
        'seed.company.sap_refreshed',
      );
      continue;
    }
    await Company.create({
      key: c.key,
      name: c.name,
      mongoUri: encrypt(c.mongoUri),
      sap: {
        baseUrl: c.sap.baseUrl,
        companyDB: c.sap.companyDB,
        username: c.sap.username,
        password: c.sap.password ? encrypt(c.sap.password) : '',
      },
      active: true,
    });
    logger.info({ key: c.key, companyDB: c.sap.companyDB }, 'seed.company.created');
  }
}

async function seedRolesPerCompany() {
  for (const c of COMPANIES) {
    const company = await Company.findOne({ key: c.key }).lean();
    if (!company) continue;

    await Role.updateOne(
      { name: 'Owner', companyKey: c.key },
      {
        $set: {
          name: 'Owner',
          description: 'Full access to every operation in this company.',
          companyKey: c.key,
          isSystemRole: true,
          permissionKeys: OWNER_PERMISSION_KEYS,
        },
      },
      { upsert: true },
    );
    await Role.updateOne(
      { name: 'Accountant', companyKey: c.key },
      {
        $set: {
          name: 'Accountant',
          description:
            'Day-to-day finance access. Cannot manage users, roles, companies, or rotate SAP credentials.',
          companyKey: c.key,
          isSystemRole: true,
          permissionKeys: ACCOUNTANT_PERMISSION_KEYS,
        },
      },
      { upsert: true },
    );
    logger.info({ key: c.key }, 'seed.roles.synced');
  }
}

async function ensureUser(
  email: string | undefined,
  password: string | undefined,
  name: string,
  isSuperAdmin = false,
): Promise<string | null> {
  if (!email || !password) {
    logger.warn({ name }, 'seed.user.skipped (missing email or password in env)');
    return null;
  }
  const existing = await User.findOne({ email }).lean();
  if (existing) {
    // Idempotent: reconcile profile fields if the seed has been adjusted.
    // (Never touches the password — that's user-managed after first login.)
    const updates: Record<string, unknown> = {};
    if (existing.name !== name) updates.name = name;
    if (existing.isSuperAdmin !== isSuperAdmin) updates.isSuperAdmin = isSuperAdmin;
    if (Object.keys(updates).length > 0) {
      await User.updateOne({ _id: existing._id }, { $set: updates });
      logger.info({ email, updates }, 'seed.user.reconciled');
    }
    return existing._id.toString();
  }
  const hash = await hashPassword(password);
  const created = await User.create({
    email,
    name,
    passwordHash: hash,
    language: 'en',
    isSuperAdmin,
    active: true,
  });
  logger.info({ email }, 'seed.user.created');
  return created._id.toString();
}

async function ensureAccess(userId: string, companyKey: string, roleName: string) {
  const company = await Company.findOne({ key: companyKey }).lean();
  if (!company) return;
  const role = await Role.findOne({ name: roleName, companyKey }).lean();
  if (!role) return;
  const roleId = new Types.ObjectId(String(role._id));
  const existing = await UserCompanyAccess.findOne({ userId, companyKey });
  if (existing) {
    if (!existing.active) {
      existing.active = true;
      existing.revokedAt = null;
      existing.revokeReason = null;
    }
    if (!existing.roleIds.some((id) => id.equals(roleId))) {
      existing.roleIds.push(roleId);
    }
    await existing.save();
    return;
  }
  await UserCompanyAccess.create({
    userId: new Types.ObjectId(userId),
    companyKey,
    roleIds: [roleId],
  });
  logger.info({ userId, companyKey, roleName }, 'seed.access.created');
}

async function seedUsers() {
  // Names kept as plain words (no parenthetical role) so avatar initials read
  // cleanly: "Idris" → ID, "Accountant Paris" → AP, etc.
  const sohaibId = await ensureUser(
    env.SEED_SOHAIB_EMAIL,
    env.SEED_SOHAIB_PASSWORD,
    'Sohaib',
    true,
  );
  const idrisId = await ensureUser(
    env.SEED_IDRIS_EMAIL,
    env.SEED_IDRIS_PASSWORD,
    'Idris',
    false,
  );

  // Idris is Owner across all 3 companies.
  if (idrisId) {
    for (const c of COMPANIES) await ensureAccess(idrisId, c.key, 'Owner');
  }

  // Sohaib is super-admin — no per-company access required, but grant Owner everywhere
  // so /me lists the companies in his switcher.
  if (sohaibId) {
    for (const c of COMPANIES) await ensureAccess(sohaibId, c.key, 'Owner');
  }

  // One Accountant per company.
  const accountants: Array<[string, string | undefined, string | undefined, string]> = [
    [
      'paris',
      env.SEED_ACCOUNTANT_PARIS_EMAIL,
      env.SEED_ACCOUNTANT_PARIS_PASSWORD,
      'Accountant Paris',
    ],
    [
      'bordeaux',
      env.SEED_ACCOUNTANT_BORDEAUX_EMAIL,
      env.SEED_ACCOUNTANT_BORDEAUX_PASSWORD,
      'Accountant Bordeaux',
    ],
    [
      'lyon',
      env.SEED_ACCOUNTANT_LYON_EMAIL,
      env.SEED_ACCOUNTANT_LYON_PASSWORD,
      'Accountant Lyon',
    ],
  ];
  for (const [key, email, pwd, name] of accountants) {
    const id = await ensureUser(email, pwd, name);
    if (id) await ensureAccess(id, key, 'Accountant');
  }
}

async function run() {
  try {
    await connectMaster();
    await seedPermissions();
    await seedCompanies();
    await seedRolesPerCompany();
    await seedUsers();
    logger.info('seed.complete');
  } catch (err) {
    logger.error({ err }, 'seed.failed');
    process.exitCode = 1;
  } finally {
    await disconnectMaster();
  }
}

run();
