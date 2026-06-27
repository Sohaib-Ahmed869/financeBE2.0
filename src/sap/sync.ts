import type { Model } from 'mongoose';
import { sapGet, type SapPaginated } from './client';
import { getTenantModelsFor } from '../db/tenant';
import type { EntityConfig } from './entityConfig';
import { logger } from '../lib/logger';

export interface SyncStats {
  fetched: number;
  created: number;
  updated: number;
  unchanged: number;
  errors: number;
  errorSamples: Array<{ id: string | number; message: string }>;
  firstId: string | number | null;
  lastId: string | number | null;
}

export interface SyncProgressSnapshot {
  fetched: number;
  created: number;
  updated: number;
  unchanged: number;
  errors: number;
  currentPage: number;
  lastDocId: string | number | null;
}

export interface SyncOptions {
  /** ISO date 'YYYY-MM-DD'. Inclusive lower bound on `dateField`. */
  from?: string;
  /** ISO date 'YYYY-MM-DD'. Inclusive upper bound on `dateField`. */
  to?: string;
  /** Page size. SAP defaults to 20; we ask for more to reduce round-trips. */
  pageSize?: number;
  /** Hard cap on total docs processed in this run. Optional safety belt. */
  maxDocs?: number;
  /**
   * Called after each page completes. Receives the running progress.
   * The runner uses this to write live state to Mongo so the UI can poll.
   * Failures here are logged but never break the sync.
   */
  onProgress?: (snapshot: SyncProgressSnapshot) => void | Promise<void>;
  /**
   * Polled at every page boundary. If it returns true, the sync stops
   * cleanly and the result reflects only the work done up to that point.
   */
  isCancelled?: () => boolean;
}

export interface SyncResult {
  ok: true;
  cancelled: boolean;
  entity: string;
  companyKey: string;
  sapPath: string;
  dateRange: { from: string | null; to: string | null };
  durationMs: number;
  pages: number;
  stats: SyncStats;
}

const ERROR_SAMPLE_LIMIT = 50;

function buildInitialUrl(cfg: EntityConfig, opts: SyncOptions): string {
  const filterClauses: string[] = [];
  if (cfg.baseFilter) filterClauses.push(`(${cfg.baseFilter})`);
  // Full-table entities (e.g. Customer) ignore the from/to window — they pull
  // the whole collection regardless of what the caller passed.
  if (!cfg.fullTable) {
    if (opts.from) filterClauses.push(`${cfg.dateField} ge '${opts.from}'`);
    if (opts.to) filterClauses.push(`${cfg.dateField} le '${opts.to}'`);
  }

  const params: string[] = [];
  if (filterClauses.length > 0) {
    params.push(`$filter=${encodeURIComponent(filterClauses.join(' and '))}`);
  }
  // Order by the entity's unique id (DocEntry / CardCode), not the date field.
  // SAP B1 pagination uses $orderby as the cursor key — non-unique keys like
  // DocDate cause silent skips/duplicates and, on this SAP server, also
  // truncate pagination after a fixed row count. Ordering by the unique id
  // matches the v1 pattern (D:\Calcite Codes\HalalSales) which fetches
  // thousands of rows reliably.
  params.push(`$orderby=${cfg.idField}`);
  return `${cfg.sapPath}?${params.join('&')}`;
}

async function upsertOne<T extends Record<string, unknown>>(
  model: Model<T>,
  cfg: EntityConfig,
  doc: Record<string, unknown>,
): Promise<'created' | 'updated' | 'unchanged'> {
  const idValue = doc[cfg.idField];
  if (idValue === undefined || idValue === null) {
    throw new Error(`SAP doc missing ${cfg.idField}`);
  }
  const result = await model.updateOne(
    { [cfg.idField]: idValue },
    { $set: { ...doc, lastSyncedAt: new Date() } },
    { upsert: true },
  );
  if (result.upsertedCount > 0) return 'created';
  if (result.modifiedCount > 0) return 'updated';
  return 'unchanged';
}

/**
 * Pulls a single SAP entity into the tenant DB. Walks `odata.nextLink`
 * pages, upserts by the entity's natural id (DocEntry / CardCode), and
 * records the run on `SapSyncState`.
 *
 * Designed to run unattended for a long time. Progress + cancellation are
 * exposed via `opts.onProgress` and `opts.isCancelled` so the JobRunner
 * can persist liveness and respect a user's cancel request mid-run.
 */
export async function syncEntity(
  companyKey: string,
  cfg: EntityConfig,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const startedAt = Date.now();
  const models = await getTenantModelsFor(companyKey);
  const model = models[cfg.modelKey] as unknown as Model<Record<string, unknown>>;

  await models.SapSyncState.updateOne(
    { entity: cfg.entity },
    {
      $set: {
        entity: cfg.entity,
        lastSyncStartedAt: new Date(),
        lastError: null,
        lastErrorAt: null,
      },
    },
    { upsert: true },
  );

  const stats: SyncStats = {
    fetched: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    errors: 0,
    errorSamples: [],
    firstId: null,
    lastId: null,
  };

  let nextUrl: string | null = buildInitialUrl(cfg, opts);
  let pages = 0;
  let cancelled = false;

  const emitProgress = async () => {
    if (!opts.onProgress) return;
    try {
      await opts.onProgress({
        fetched: stats.fetched,
        created: stats.created,
        updated: stats.updated,
        unchanged: stats.unchanged,
        errors: stats.errors,
        currentPage: pages,
        lastDocId: stats.lastId,
      });
    } catch (err) {
      logger.warn({ err, companyKey, entity: cfg.entity }, 'sap.sync.onProgress_failed');
    }
  };

  try {
    while (nextUrl) {
      if (opts.isCancelled?.()) {
        cancelled = true;
        break;
      }

      pages++;
      const data: SapPaginated<Record<string, unknown>> = await sapGet<
        SapPaginated<Record<string, unknown>>
      >(companyKey, nextUrl, { maxPageSize: opts.pageSize ?? 100 });
      logger.info(
        `sap.sync ${cfg.entity} [${companyKey}] page=${pages} got=${data.value.length} total=${stats.fetched + data.value.length} next=${data['odata.nextLink'] ? 'y' : 'n'}`,
      );

      for (const doc of data.value) {
        if (opts.maxDocs && stats.fetched >= opts.maxDocs) {
          nextUrl = null;
          break;
        }
        stats.fetched++;
        const id = doc[cfg.idField] as string | number | undefined;
        if (id !== undefined) {
          if (stats.firstId === null) stats.firstId = id;
          stats.lastId = id;
        }
        try {
          const outcome = await upsertOne(model, cfg, doc);
          stats[outcome]++;
        } catch (err) {
          stats.errors++;
          if (stats.errorSamples.length < ERROR_SAMPLE_LIMIT) {
            stats.errorSamples.push({
              id: id ?? 'unknown',
              message: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      // Persist progress after each page so the UI sees liveness.
      await emitProgress();

      const next: string | undefined = data['odata.nextLink'];
      nextUrl = next ?? null;
    }

    await models.SapSyncState.updateOne(
      { entity: cfg.entity },
      {
        $set: {
          lastSyncFinishedAt: new Date(),
          lastSyncedAt: new Date(),
          lastDurationMs: Date.now() - startedAt,
          docsProcessedLastRun: stats.fetched,
          consecutiveFailures: 0,
        },
        $inc: {
          successfulSyncs: 1,
          totalDocsProcessed: stats.fetched,
        },
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await models.SapSyncState.updateOne(
      { entity: cfg.entity },
      {
        $set: {
          lastError: message,
          lastErrorAt: new Date(),
        },
        $inc: {
          failedSyncs: 1,
          consecutiveFailures: 1,
        },
      },
    );
    throw err;
  }

  return {
    ok: true,
    cancelled,
    entity: cfg.entity,
    companyKey,
    sapPath: cfg.sapPath,
    dateRange: { from: opts.from ?? null, to: opts.to ?? null },
    durationMs: Date.now() - startedAt,
    pages,
    stats,
  };
}
