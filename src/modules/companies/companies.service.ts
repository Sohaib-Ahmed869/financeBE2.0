import { Company } from '../../models/master/Company';
import { encrypt } from '../../lib/crypto';
import { evictTenantConnection } from '../../db/tenant';
import { ConflictError, NotFoundError } from '../../lib/errors';
import { audit } from '../../lib/audit';
import { _resetChannelTaggerCache } from '../daybook/daybook.channelTagger';
import type {
  CreateCompanyInput,
  UpdateCompanyInput,
  RotateSapInput,
} from './companies.validators';

interface ActorMeta {
  actorUserId: string;
  actorEmail: string;
  ip: string;
}

function publicCompany(c: {
  _id: { toString(): string };
  key: string;
  name: string;
  sap: { baseUrl: string; companyDB: string; username: string };
  posUdfFieldName: string;
  ownCompanyCardCodes?: string[];
  currency: string;
  timezone: string;
  locale: string;
  active: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}) {
  return {
    id: c._id.toString(),
    key: c.key,
    name: c.name,
    sap: {
      baseUrl: c.sap.baseUrl,
      companyDB: c.sap.companyDB,
      username: c.sap.username,
      // password and mongoUri intentionally NOT returned
      hasPassword: undefined as boolean | undefined,
    },
    posUdfFieldName: c.posUdfFieldName,
    ownCompanyCardCodes: c.ownCompanyCardCodes ?? [],
    currency: c.currency,
    timezone: c.timezone,
    locale: c.locale,
    active: c.active,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

export async function listCompanies() {
  const docs = await Company.find({}).sort({ name: 1 }).lean();
  return docs.map((c) => {
    const out = publicCompany(c as Parameters<typeof publicCompany>[0]);
    out.sap.hasPassword = Boolean(c.sap.password);
    return out;
  });
}

export async function getCompany(key: string) {
  const c = await Company.findOne({ key }).lean();
  if (!c) throw new NotFoundError('Company');
  const out = publicCompany(c as Parameters<typeof publicCompany>[0]);
  out.sap.hasPassword = Boolean(c.sap.password);
  return out;
}

export async function createCompany(input: CreateCompanyInput, actor: ActorMeta) {
  const exists = await Company.findOne({ key: input.key }).lean();
  if (exists) throw new ConflictError(`Company key '${input.key}' already exists`);
  const created = await Company.create({
    key: input.key,
    name: input.name,
    mongoUri: encrypt(input.mongoUri),
    sap: {
      baseUrl: input.sap.baseUrl,
      companyDB: input.sap.companyDB,
      username: input.sap.username,
      password: input.sap.password ? encrypt(input.sap.password) : '',
    },
    posUdfFieldName: input.posUdfFieldName,
    currency: input.currency,
    timezone: input.timezone,
    locale: input.locale,
    active: true,
  });
  await audit({
    action: 'companies.create',
    actorUserId: actor.actorUserId,
    actorEmail: actor.actorEmail,
    subjectType: 'Company',
    subjectId: created._id.toString(),
    companyKey: created.key,
    after: { key: created.key, name: created.name },
    ip: actor.ip,
  });
  const out = publicCompany(created);
  out.sap.hasPassword = Boolean(created.sap.password);
  return out;
}

export async function updateCompany(key: string, patch: UpdateCompanyInput, actor: ActorMeta) {
  const company = await Company.findOne({ key });
  if (!company) throw new NotFoundError('Company');
  const before = {
    name: company.name,
    posUdfFieldName: company.posUdfFieldName,
    currency: company.currency,
    timezone: company.timezone,
    locale: company.locale,
    active: company.active,
    mongoUriRotated: false,
  };
  if (patch.name !== undefined) company.name = patch.name;
  if (patch.posUdfFieldName !== undefined) company.posUdfFieldName = patch.posUdfFieldName;
  if (patch.currency !== undefined) company.currency = patch.currency;
  if (patch.timezone !== undefined) company.timezone = patch.timezone;
  if (patch.locale !== undefined) company.locale = patch.locale;
  if (patch.active !== undefined) company.active = patch.active;
  if (patch.mongoUri !== undefined) {
    company.mongoUri = encrypt(patch.mongoUri);
    before.mongoUriRotated = true;
    evictTenantConnection(key); // force fresh connection on next access
  }
  await company.save();
  await audit({
    action: 'companies.update',
    actorUserId: actor.actorUserId,
    actorEmail: actor.actorEmail,
    subjectType: 'Company',
    subjectId: company._id.toString(),
    companyKey: company.key,
    before,
    after: {
      name: company.name,
      posUdfFieldName: company.posUdfFieldName,
      currency: company.currency,
      timezone: company.timezone,
      locale: company.locale,
      active: company.active,
    },
    ip: actor.ip,
  });
  const out = publicCompany(company);
  out.sap.hasPassword = Boolean(company.sap.password);
  return out;
}

export async function rotateSapCreds(key: string, patch: RotateSapInput, actor: ActorMeta) {
  const company = await Company.findOne({ key });
  if (!company) throw new NotFoundError('Company');
  if (patch.baseUrl !== undefined) company.sap.baseUrl = patch.baseUrl;
  if (patch.companyDB !== undefined) company.sap.companyDB = patch.companyDB;
  if (patch.username !== undefined) company.sap.username = patch.username;
  if (patch.password !== undefined) company.sap.password = patch.password ? encrypt(patch.password) : '';
  await company.save();
  await audit({
    action: 'companies.rotate_sap_creds',
    actorUserId: actor.actorUserId,
    actorEmail: actor.actorEmail,
    subjectType: 'Company',
    subjectId: company._id.toString(),
    companyKey: company.key,
    after: {
      baseUrl: company.sap.baseUrl,
      companyDB: company.sap.companyDB,
      username: company.sap.username,
      passwordChanged: patch.password !== undefined,
    },
    ip: actor.ip,
  });
  const out = publicCompany(company);
  out.sap.hasPassword = Boolean(company.sap.password);
  return out;
}

/**
 * Replace the company's `ownCompanyCardCodes` list. Codes are upper-cased,
 * trimmed, deduplicated, and empty strings dropped before persisting.
 *
 * After a successful write we invalidate the channel-tagger's per-tenant
 * cache so the next daybook entry classifies against the fresh list rather
 * than the up-to-30-seconds-stale snapshot.
 */
export async function updateOwnCompanyCardCodes(
  key: string,
  cardCodes: string[],
  actor: ActorMeta,
) {
  const company = await Company.findOne({ key });
  if (!company) throw new NotFoundError('Company');

  const before = (company.ownCompanyCardCodes ?? []).slice();
  const normalized = Array.from(
    new Set(
      (cardCodes ?? [])
        .map((c) => (typeof c === 'string' ? c.trim().toUpperCase() : ''))
        .filter((c) => c.length > 0),
    ),
  );
  company.ownCompanyCardCodes = normalized;
  await company.save();

  _resetChannelTaggerCache();

  await audit({
    action: 'company.updateOwnCompanyCardCodes',
    actorUserId: actor.actorUserId,
    actorEmail: actor.actorEmail,
    subjectType: 'Company',
    subjectId: company._id.toString(),
    companyKey: company.key,
    before: { ownCompanyCardCodes: before },
    after: { ownCompanyCardCodes: normalized },
    ip: actor.ip,
  });

  const out = publicCompany(company);
  out.sap.hasPassword = Boolean(company.sap.password);
  return out;
}

export async function deactivateCompany(key: string, actor: ActorMeta) {
  const company = await Company.findOne({ key });
  if (!company) throw new NotFoundError('Company');
  company.active = false;
  await company.save();
  evictTenantConnection(key);
  await audit({
    action: 'companies.deactivate',
    actorUserId: actor.actorUserId,
    actorEmail: actor.actorEmail,
    subjectType: 'Company',
    subjectId: company._id.toString(),
    companyKey: company.key,
    ip: actor.ip,
  });
}
