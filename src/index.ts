import { env } from './config/env';
import { logger } from './lib/logger';
import { connectMaster, disconnectMaster } from './db/master';
import { closeAllTenantConnections } from './db/tenant';
import { Company } from './models/master/Company';
import { sapJobRunner, markInterruptedOnBoot } from './sap/jobRunner';
import { createApp } from './app';

async function main() {
  await connectMaster();

  // For each active tenant, mark any in-flight sync jobs from a previous
  // process as 'interrupted'. Done lazily — failures here don't block boot.
  void cleanupInterruptedSyncs();

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'http.listening');
  });

  // Long SAP pulls can take many minutes — relax the default Node socket
  // timeouts so a `wait:true` response can still make it back to Postman.
  // (Async jobs return in milliseconds, so this is mostly belt + braces.)
  server.requestTimeout = 30 * 60 * 1000; // 30 min
  server.headersTimeout = 31 * 60 * 1000;
  server.keepAliveTimeout = 65_000;

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutdown.start');
    void sapJobRunner.beginShutdown();
    server.close(async () => {
      try {
        await closeAllTenantConnections();
        await disconnectMaster();
        logger.info('shutdown.complete');
        process.exit(0);
      } catch (err) {
        logger.error({ err }, 'shutdown.error');
        process.exit(1);
      }
    });
    setTimeout(() => {
      logger.error('shutdown.timeout');
      process.exit(1);
    }, 15_000).unref();
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // CRITICAL: never let a SAP sync (or anything else) take down the process.
  // We log loudly but keep going — the failed sync's SyncJob row will already
  // be marked 'failed' inside the runner's catch block.
  process.on('unhandledRejection', (err) => {
    logger.error({ err }, 'unhandled.rejection (server stays up)');
  });
  process.on('uncaughtException', (err) => {
    logger.error({ err }, 'uncaught.exception (server stays up)');
  });
}

async function cleanupInterruptedSyncs() {
  try {
    const companies = await Company.find({ active: true }, { key: 1 }).lean();
    let total = 0;
    for (const c of companies) {
      total += await markInterruptedOnBoot(c.key);
    }
    if (total > 0) {
      logger.warn({ count: total }, 'sap.boot.interrupted_jobs_marked');
    }
  } catch (err) {
    logger.error({ err }, 'sap.boot.cleanup_failed');
  }
}

main().catch((err) => {
  logger.error({ err }, 'startup.failed');
  process.exit(1);
});
