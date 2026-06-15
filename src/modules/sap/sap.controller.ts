import { Types } from 'mongoose';
import { asyncHandler } from '../../lib/asyncHandler';
import { BadRequestError, NotFoundError, UnauthorizedError } from '../../lib/errors';
import { getEntityConfig, ENTITY_SLUGS } from '../../sap/entityConfig';
import { syncEntity } from '../../sap/sync';
import { sapJobRunner } from '../../sap/jobRunner';
import { testSapLogin } from '../../sap/session';
import { getTenantModelsFor } from '../../db/tenant';
import { audit } from '../../lib/audit';
import type { SyncBodyInput, ListJobsQuery } from './sap.validators';

const ipOf = (req: { ip?: string; headers?: Record<string, unknown> }): string =>
  ((req.headers?.['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || '');

/**
 * POST /api/sap/sync/:entity
 *
 * Default behaviour: enqueue a background job and return 202 with the job id.
 * The HTTP request returns in milliseconds — the actual SAP pull continues
 * in-process and writes progress to the SyncJob row, which the UI polls.
 *
 * For Postman / small one-off pulls, pass `"wait": true` in the body to block
 * until the sync finishes (legacy behaviour).
 */
export const sync = asyncHandler<{ entity: string }, unknown, SyncBodyInput>(
  async (req, res) => {
    if (!req.auth) throw new UnauthorizedError();
    if (!req.tenant) throw new BadRequestError('No active company');

    const cfg = getEntityConfig(req.params.entity);
    if (!cfg) {
      throw new BadRequestError(
        `Unknown entity '${req.params.entity}'. Valid: ${ENTITY_SLUGS.join(', ')}`,
      );
    }

    const body = req.body ?? {};
    const m = await getTenantModelsFor(req.tenant.companyKey);

    // Always create a SyncJob row — gives us full history regardless of mode.
    const job = await m.SyncJob.create({
      entity: cfg.entity,
      triggeredByEmail: req.auth.email,
      requestedFrom: body.from,
      requestedTo: body.to,
      pageSize: body.pageSize,
      maxDocs: body.maxDocs,
      status: 'queued',
    });

    await audit({
      action: 'sap.sync.requested',
      actorUserId: req.auth.userId,
      actorEmail: req.auth.email,
      subjectType: 'SyncJob',
      subjectId: job._id.toString(),
      companyKey: req.tenant.companyKey,
      after: {
        entity: cfg.entity,
        from: body.from ?? null,
        to: body.to ?? null,
        wait: body.wait,
      },
      ip: ipOf(req),
    });

    if (body.wait) {
      // Synchronous mode — run inline.
      try {
        await m.SyncJob.updateOne(
          { _id: job._id },
          { $set: { status: 'running', startedAt: new Date() } },
        );
        const result = await syncEntity(req.tenant.companyKey, cfg, {
          from: body.from,
          to: body.to,
          pageSize: body.pageSize,
          maxDocs: body.maxDocs,
          onProgress: async (snapshot) => {
            await m.SyncJob.updateOne(
              { _id: job._id },
              { $set: { progress: snapshot, lastProgressAt: new Date() } },
            );
          },
        });
        await m.SyncJob.updateOne(
          { _id: job._id },
          {
            $set: {
              status: 'completed',
              finishedAt: new Date(),
              durationMs: result.durationMs,
              pages: result.pages,
              result: result.stats,
            },
          },
        );
        return res.json({ ...result, jobId: job._id.toString() });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await m.SyncJob.updateOne(
          { _id: job._id },
          { $set: { status: 'failed', finishedAt: new Date(), errorMessage: message } },
        );
        throw err;
      }
    }

    // Async mode — kick the runner and return 202.
    sapJobRunner.enqueue({
      jobId: job._id.toString(),
      companyKey: req.tenant.companyKey,
      entitySlug: cfg.slug,
      triggeredByEmail: req.auth.email,
      opts: {
        from: body.from,
        to: body.to,
        pageSize: body.pageSize,
        maxDocs: body.maxDocs,
      },
    });
    return res.status(202).json({
      jobId: job._id.toString(),
      status: 'queued',
      entity: cfg.entity,
      statusUrl: `/api/sap/jobs/${job._id.toString()}`,
    });
  },
);

/** POST /api/sap/test — verify SAP creds for the active company. */
export const test = asyncHandler(async (req, res) => {
  if (!req.auth) throw new UnauthorizedError();
  if (!req.tenant) throw new BadRequestError('No active company');
  const result = await testSapLogin(req.tenant.companyKey);
  await audit({
    action: 'sap.test',
    actorUserId: req.auth.userId,
    actorEmail: req.auth.email,
    companyKey: req.tenant.companyKey,
    ip: ipOf(req),
  });
  res.json(result);
});

/** GET /api/sap/sync-state — list all per-entity sync cursors for this tenant. */
export const syncState = asyncHandler(async (req, res) => {
  if (!req.auth) throw new UnauthorizedError();
  if (!req.tenant) throw new BadRequestError('No active company');
  const m = await getTenantModelsFor(req.tenant.companyKey);
  const items = await m.SapSyncState.find({}).sort({ entity: 1 }).lean();
  res.json({
    items: items.map((s) => ({
      entity: s.entity,
      lastSyncedAt: s.lastSyncedAt ?? null,
      lastDurationMs: s.lastDurationMs ?? null,
      docsProcessedLastRun: s.docsProcessedLastRun ?? 0,
      totalDocsProcessed: s.totalDocsProcessed ?? 0,
      successfulSyncs: s.successfulSyncs ?? 0,
      failedSyncs: s.failedSyncs ?? 0,
      consecutiveFailures: s.consecutiveFailures ?? 0,
      lastError: s.lastError ?? null,
      lastErrorAt: s.lastErrorAt ?? null,
      paused: s.paused ?? false,
    })),
  });
});

/** GET /api/sap/entities — list of supported entity slugs. */
export const entities = asyncHandler(async (_req, res) => {
  const out = ENTITY_SLUGS.map((slug) => {
    const c = getEntityConfig(slug)!;
    return {
      slug: c.slug,
      entity: c.entity,
      sapPath: c.sapPath,
      idField: c.idField,
      fullTable: Boolean(c.fullTable),
    };
  });
  res.json({ entities: out });
});

/** GET /api/sap/jobs — paginated list of recent jobs (for the UI table). */
export const listJobs = asyncHandler<unknown, unknown, unknown, ListJobsQuery>(async (req, res) => {
  if (!req.auth) throw new UnauthorizedError();
  if (!req.tenant) throw new BadRequestError('No active company');
  const { entity, status, triggeredByEmail, page, limit } = req.query;
  const filter: Record<string, unknown> = {};
  if (entity) filter.entity = entity;
  if (status) filter.status = status;
  if (triggeredByEmail) filter.triggeredByEmail = triggeredByEmail;

  const m = await getTenantModelsFor(req.tenant.companyKey);
  const total = await m.SyncJob.countDocuments(filter);
  const items = await m.SyncJob.find(filter)
    .sort({ triggeredAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();

  res.json({
    items: items.map((j) => ({
      id: j._id.toString(),
      entity: j.entity,
      status: j.status,
      cancelRequested: j.cancelRequested ?? false,
      triggeredByEmail: j.triggeredByEmail,
      triggeredAt: j.triggeredAt,
      startedAt: j.startedAt ?? null,
      finishedAt: j.finishedAt ?? null,
      durationMs: j.durationMs ?? null,
      requestedFrom: j.requestedFrom ?? null,
      requestedTo: j.requestedTo ?? null,
      pageSize: j.pageSize ?? null,
      progress: j.progress,
      lastProgressAt: j.lastProgressAt ?? null,
      result: j.result ?? null,
      errorMessage: j.errorMessage ?? null,
    })),
    total,
    page,
    limit,
    pages: Math.max(1, Math.ceil(total / limit)),
  });
});

/** GET /api/sap/jobs/:id — single job detail. */
export const getJob = asyncHandler<{ id: string }>(async (req, res) => {
  if (!req.auth) throw new UnauthorizedError();
  if (!req.tenant) throw new BadRequestError('No active company');
  const m = await getTenantModelsFor(req.tenant.companyKey);
  const job = await m.SyncJob.findById(new Types.ObjectId(req.params.id)).lean();
  if (!job) throw new NotFoundError('SyncJob');
  res.json({
    id: job._id.toString(),
    entity: job.entity,
    status: job.status,
    cancelRequested: job.cancelRequested ?? false,
    triggeredByEmail: job.triggeredByEmail,
    triggeredAt: job.triggeredAt,
    startedAt: job.startedAt ?? null,
    finishedAt: job.finishedAt ?? null,
    durationMs: job.durationMs ?? null,
    pages: job.pages ?? null,
    requestedFrom: job.requestedFrom ?? null,
    requestedTo: job.requestedTo ?? null,
    pageSize: job.pageSize ?? null,
    maxDocs: job.maxDocs ?? null,
    progress: job.progress,
    lastProgressAt: job.lastProgressAt ?? null,
    result: job.result ?? null,
    errorMessage: job.errorMessage ?? null,
  });
});

/** POST /api/sap/jobs/:id/cancel — request cancellation of a running/queued job. */
export const cancelJob = asyncHandler<{ id: string }>(async (req, res) => {
  if (!req.auth) throw new UnauthorizedError();
  if (!req.tenant) throw new BadRequestError('No active company');
  const m = await getTenantModelsFor(req.tenant.companyKey);
  const job = await m.SyncJob.findById(new Types.ObjectId(req.params.id));
  if (!job) throw new NotFoundError('SyncJob');
  if (!['queued', 'running'].includes(job.status)) {
    throw new BadRequestError(`Job is already ${job.status}; cannot cancel`);
  }
  job.cancelRequested = true;
  await job.save();
  sapJobRunner.requestCancel(job._id.toString());

  await audit({
    action: 'sap.sync.cancel',
    actorUserId: req.auth.userId,
    actorEmail: req.auth.email,
    subjectType: 'SyncJob',
    subjectId: job._id.toString(),
    companyKey: req.tenant.companyKey,
    ip: ipOf(req),
  });

  res.json({ ok: true, jobId: job._id.toString(), status: job.status });
});

/** GET /api/sap/runner-stats — concurrency / queue depth (for diagnostics). */
export const runnerStats = asyncHandler(async (_req, res) => {
  res.json(sapJobRunner.stats());
});
