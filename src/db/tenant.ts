import mongoose, { type Connection } from 'mongoose';
import { Company } from '../models/master/Company';
import { decrypt } from '../lib/crypto';
import { NotFoundError, BadRequestError } from '../lib/errors';
import { logger } from '../lib/logger';
import { getTenantModels, type TenantModels } from '../models/tenant';

interface TenantConn {
  conn: Connection;
  companyKey: string;
}

const pool = new Map<string, TenantConn>();

/**
 * Returns a per-company Mongoose Connection. The first call for a company
 * lazily opens the connection (decrypting the URI from the Company doc) and
 * caches it in the pool. Subsequent calls reuse the same connection.
 */
export async function getTenantConnection(companyKey: string): Promise<Connection> {
  const cached = pool.get(companyKey);
  if (cached && cached.conn.readyState === 1) return cached.conn;

  const company = await Company.findOne({ key: companyKey, active: true }).lean();
  if (!company) throw new NotFoundError(`Company '${companyKey}' not found or inactive`);
  if (!company.mongoUri) {
    throw new BadRequestError(`Company '${companyKey}' has no Mongo URI configured`);
  }

  let uri: string;
  try {
    uri = decrypt(company.mongoUri);
  } catch (err) {
    logger.error({ err, companyKey }, 'tenant.mongo.decrypt_failed');
    throw new BadRequestError(`Cannot read Mongo URI for company '${companyKey}'`);
  }

  const conn = await mongoose
    .createConnection(uri, {
      autoIndex: true,
      serverSelectionTimeoutMS: 10_000,
    })
    .asPromise();

  conn.on('error', (err) => logger.error({ err, companyKey }, 'tenant.mongo.error'));
  conn.on('disconnected', () => logger.warn({ companyKey }, 'tenant.mongo.disconnected'));

  pool.set(companyKey, { conn, companyKey });
  logger.info({ companyKey }, 'tenant.mongo.connected');
  return conn;
}

export async function closeAllTenantConnections(): Promise<void> {
  await Promise.all(
    Array.from(pool.values()).map(({ conn, companyKey }) =>
      conn
        .close()
        .then(() => logger.info({ companyKey }, 'tenant.mongo.closed'))
        .catch((err) => logger.error({ err, companyKey }, 'tenant.mongo.close_failed')),
    ),
  );
  pool.clear();
}

/** Drops a specific tenant from the pool — call when its config changes. */
export function evictTenantConnection(companyKey: string): void {
  const entry = pool.get(companyKey);
  if (!entry) return;
  entry.conn.close().catch((err) => logger.error({ err, companyKey }, 'tenant.mongo.evict_failed'));
  pool.delete(companyKey);
}

/**
 * Resolves the tenant connection for `companyKey` and returns the typed
 * model registry bound to it. Use this from controllers/services:
 *
 *   const { Invoice, Customer } = await getTenantModelsFor(req.tenant!.companyKey);
 *   const invoices = await Invoice.find({ ... });
 */
export async function getTenantModelsFor(companyKey: string): Promise<TenantModels> {
  const conn = await getTenantConnection(companyKey);
  return getTenantModels(conn);
}
