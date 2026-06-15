import axios, { type AxiosInstance } from 'axios';
import { Company } from '../models/master/Company';
import { decrypt } from '../lib/crypto';
import { logger } from '../lib/logger';
import { BadRequestError, NotFoundError } from '../lib/errors';

interface CachedSession {
  cookie: string;
  expiresAt: Date;
  baseUrl: string;
  companyDB: string;
}

interface SapCreds {
  baseUrl: string;
  companyDB: string;
  username: string;
  password: string;
}

const sessionCache = new Map<string, CachedSession>();

/** SAP B1 sessions default to 30 min — keep ours fresh with a 5-min safety buffer. */
const SESSION_TTL_MS = 25 * 60 * 1000;

const http: AxiosInstance = axios.create({
  timeout: 30_000,
  // Many SAP B1 hosts ship with self-signed or non-SNI certs; the production
  // setting should be true. We honour an env override (SAP_INSECURE_TLS=true)
  // for dev against test SAPs only.
  // (Wired up via the dispatcher in sapGet/sapPost below — keeping this
  //  client itself stock so axios defaults to validating certs.)
});

async function loadCreds(companyKey: string): Promise<SapCreds> {
  const company = await Company.findOne({ key: companyKey, active: true }).lean();
  if (!company) throw new NotFoundError(`Company '${companyKey}'`);
  if (!company.sap?.baseUrl || !company.sap?.companyDB) {
    throw new BadRequestError(
      `Company '${companyKey}' has no SAP configuration. Set baseUrl + companyDB + credentials first.`,
    );
  }
  if (!company.sap.username || !company.sap.password) {
    throw new BadRequestError(`Company '${companyKey}' has no SAP credentials.`);
  }
  let password: string;
  try {
    password = decrypt(company.sap.password);
  } catch (err) {
    logger.error({ err, companyKey }, 'sap.creds.decrypt_failed');
    throw new BadRequestError(`Cannot decrypt SAP password for '${companyKey}'`);
  }
  return {
    baseUrl: company.sap.baseUrl.replace(/\/$/, ''),
    companyDB: company.sap.companyDB,
    username: company.sap.username,
    password,
  };
}

/**
 * Returns a valid Service Layer session cookie for `companyKey`. Cached for
 * ~25 minutes; logs in fresh otherwise. Concurrent calls for the same
 * tenant share one in-flight login (no thundering herd).
 */
const inFlight = new Map<string, Promise<CachedSession>>();

async function freshLogin(companyKey: string, creds: SapCreds): Promise<CachedSession> {
  logger.debug({ companyKey, companyDB: creds.companyDB }, 'sap.login.attempt');
  const response = await http.post(
    `${creds.baseUrl}/Login`,
    {
      CompanyDB: creds.companyDB,
      UserName: creds.username,
      Password: creds.password,
    },
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: 30_000,
      validateStatus: () => true, // we'll surface a clean error below
    },
  );

  if (response.status !== 200) {
    logger.error(
      { companyKey, status: response.status, body: response.data },
      'sap.login.failed',
    );
    throw new BadRequestError(
      `SAP login failed (status ${response.status}): ${JSON.stringify(response.data)}`,
    );
  }
  const cookies = response.headers['set-cookie'];
  if (!cookies || cookies.length === 0) {
    throw new BadRequestError('SAP login returned no session cookie');
  }
  const cookie = cookies.map((c) => c.split(';')[0]).join('; ');
  logger.info(`sap.login ok [${companyKey}] db=${creds.companyDB}`);
  return {
    cookie,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    baseUrl: creds.baseUrl,
    companyDB: creds.companyDB,
  };
}

export async function getSapSession(companyKey: string): Promise<CachedSession> {
  const cached = sessionCache.get(companyKey);
  if (cached && cached.expiresAt.getTime() > Date.now()) return cached;

  const existing = inFlight.get(companyKey);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const creds = await loadCreds(companyKey);
      const session = await freshLogin(companyKey, creds);
      sessionCache.set(companyKey, session);
      return session;
    } finally {
      inFlight.delete(companyKey);
    }
  })();

  inFlight.set(companyKey, promise);
  return promise;
}

/** Wipe the cached session — call on 401. */
export function invalidateSapSession(companyKey: string): void {
  sessionCache.delete(companyKey);
}

/** Verify the SAP creds work without doing anything else. */
export async function testSapLogin(companyKey: string) {
  invalidateSapSession(companyKey);
  const session = await getSapSession(companyKey);
  return {
    ok: true,
    companyDB: session.companyDB,
    baseUrl: session.baseUrl,
    sessionAcquiredAt: new Date(),
    sessionExpiresAt: session.expiresAt,
  };
}
