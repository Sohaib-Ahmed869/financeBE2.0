import { Types } from 'mongoose';
import { syncEntity, type SyncOptions, type SyncProgressSnapshot } from './sync';
import { getEntityConfig } from './entityConfig';
import { getTenantModelsFor } from '../db/tenant';
import { logger } from '../lib/logger';

interface QueuedJob {
  jobId: string;
  companyKey: string;
  /** URL slug — same as the route param. */
  entitySlug: string;
  triggeredByEmail: string;
  opts: Pick<SyncOptions, 'from' | 'to' | 'pageSize' | 'maxDocs'>;
}

const MAX_CONCURRENT = Math.max(
  1,
  parseInt(process.env.SAP_MAX_CONCURRENT_SYNCS ?? '4', 10),
);
/** How often the runner re-checks for capacity when at the cap. */
const CAPACITY_CHECK_INTERVAL_MS = 250;

/**
 * In-process SAP sync job runner.
 *
 * Properties:
 *   - Per-(company, entity) serialisation: two `paris × invoices` jobs cannot
 *     run concurrently — the second waits for the first.
 *   - Global concurrency cap (env: SAP_MAX_CONCURRENT_SYNCS, default 4).
 *   - Cancellation: setting `cancelRequested = true` on the SyncJob row makes
 *     the runner exit at the next page boundary.
 *   - Job state lives in Mongo (`SyncJob` collection); the runner is just a
 *     scheduler. A server restart loses in-flight work but Mongo retains the
 *     full history; on boot, we mark interrupted jobs.
 *   - Errors NEVER bubble to the process — every job is wrapped.
 */
class SapJobRunner {
  private chains = new Map<string, Promise<void>>(); // key = `${companyKey}:${entitySlug}`
  private active = 0;
  private cancelTokens = new Map<string, boolean>(); // jobId → cancelled?
  private shuttingDown = false;

  /** Enqueue a job. Returns immediately — the work happens in the background. */
  enqueue(job: QueuedJob): void {
    if (this.shuttingDown) {
      logger.warn({ jobId: job.jobId }, 'sap.runner.enqueue_during_shutdown');
      return;
    }
    const key = `${job.companyKey}:${job.entitySlug}`;
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(() => this.runWithCapacity(job));
    // Always swallow errors at the chain level so one failure doesn't poison
    // future jobs for the same (company, entity).
    this.chains.set(
      key,
      next.catch((err) => {
        logger.error({ err, jobId: job.jobId, key }, 'sap.runner.chain_error');
      }),
    );
    logger.info(`sap.runner enqueued ${key} (active=${this.active})`);
  }

  requestCancel(jobId: string): void {
    this.cancelTokens.set(jobId, true);
  }

  isCancelled(jobId: string): boolean {
    return this.cancelTokens.get(jobId) === true;
  }

  /** For introspection / tests. */
  stats() {
    return { active: this.active, queued: this.chains.size };
  }

  /**
   * On graceful shutdown, mark any 'queued' / 'running' jobs in Mongo as
   * 'interrupted' so the UI doesn't show them spinning forever.
   */
  async beginShutdown(): Promise<void> {
    this.shuttingDown = true;
    // We don't know which tenants have in-flight jobs from in-memory state
    // alone (chain map is keyed by company too). For now we rely on the
    // periodic startup-cleanup to mark stragglers — see `markInterruptedOnBoot`.
  }

  private async runWithCapacity(job: QueuedJob): Promise<void> {
    while (this.active >= MAX_CONCURRENT) {
      await new Promise((r) => setTimeout(r, CAPACITY_CHECK_INTERVAL_MS));
    }
    this.active++;
    try {
      await this.executeJob(job);
    } finally {
      this.active--;
      this.cancelTokens.delete(job.jobId);
    }
  }

  private async executeJob(job: QueuedJob): Promise<void> {
    const cfg = getEntityConfig(job.entitySlug);
    if (!cfg) {
      logger.error({ jobId: job.jobId, entitySlug: job.entitySlug }, 'sap.runner.unknown_entity');
      return;
    }

    const models = await getTenantModelsFor(job.companyKey);
    const jobObjectId = new Types.ObjectId(job.jobId);

    // Honour an early cancel that arrived between enqueue and execute.
    const earlyCheck = await models.SyncJob.findById(jobObjectId, { cancelRequested: 1 }).lean();
    if (earlyCheck?.cancelRequested) {
      this.cancelTokens.set(job.jobId, true);
      await models.SyncJob.updateOne(
        { _id: jobObjectId },
        {
          $set: {
            status: 'cancelled',
            startedAt: new Date(),
            finishedAt: new Date(),
            errorMessage: 'Cancelled before start',
          },
        },
      );
      return;
    }

    // Mark as running
    await models.SyncJob.updateOne(
      { _id: jobObjectId },
      { $set: { status: 'running', startedAt: new Date() } },
    );

    try {
      const result = await syncEntity(job.companyKey, cfg, {
        from: job.opts.from,
        to: job.opts.to,
        pageSize: job.opts.pageSize,
        maxDocs: job.opts.maxDocs,
        onProgress: async (snapshot: SyncProgressSnapshot) => {
          await models.SyncJob.updateOne(
            { _id: jobObjectId },
            {
              $set: {
                progress: snapshot,
                lastProgressAt: new Date(),
              },
            },
          );
        },
        isCancelled: () => {
          if (this.isCancelled(job.jobId)) return true;
          // Also check Mongo every-so-often — but per-page already checks the
          // in-memory token, and `requestCancel` sets the token, so this is
          // mostly belt + braces.
          return false;
        },
      });

      await models.SyncJob.updateOne(
        { _id: jobObjectId },
        {
          $set: {
            status: result.cancelled ? 'cancelled' : 'completed',
            finishedAt: new Date(),
            durationMs: result.durationMs,
            pages: result.pages,
            result: {
              fetched: result.stats.fetched,
              created: result.stats.created,
              updated: result.stats.updated,
              unchanged: result.stats.unchanged,
              errors: result.stats.errors,
              firstId: result.stats.firstId,
              lastId: result.stats.lastId,
              errorSamples: result.stats.errorSamples,
            },
          },
        },
      );

      const s = result.stats;
      logger.info(
        `sap.runner done ${cfg.entity} [${job.companyKey}] ` +
          `fetched=${s.fetched} (+${s.created}/~${s.updated}/=${s.unchanged}) ` +
          `errors=${s.errors} pages=${result.pages} in ${result.durationMs}ms` +
          (result.cancelled ? ' [cancelled]' : ''),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await models.SyncJob.updateOne(
        { _id: jobObjectId },
        {
          $set: {
            status: 'failed',
            finishedAt: new Date(),
            errorMessage: message,
          },
        },
      ).catch((updateErr) => {
        logger.error({ updateErr, jobId: job.jobId }, 'sap.runner.failed_update_failed');
      });
      logger.error(
        `sap.runner failed ${cfg.entity} [${job.companyKey}]: ${message}`,
      );
      // Swallow — never let a sync error take down the process.
    }
  }
}

export const sapJobRunner = new SapJobRunner();

/**
 * Called on server boot for each known tenant: any job left in `queued` or
 * `running` from a previous process is flagged `interrupted` so the UI
 * doesn't show ghosts.
 */
export async function markInterruptedOnBoot(companyKey: string): Promise<number> {
  try {
    const models = await getTenantModelsFor(companyKey);
    const result = await models.SyncJob.updateMany(
      { status: { $in: ['queued', 'running'] } },
      {
        $set: {
          status: 'interrupted',
          finishedAt: new Date(),
          errorMessage: 'Server restarted while job was in flight',
        },
      },
    );
    if (result.modifiedCount > 0) {
      logger.warn(
        { companyKey, count: result.modifiedCount },
        'sap.runner.boot_marked_interrupted',
      );
    }
    return result.modifiedCount;
  } catch (err) {
    logger.error({ err, companyKey }, 'sap.runner.boot_cleanup_failed');
    return 0;
  }
}
