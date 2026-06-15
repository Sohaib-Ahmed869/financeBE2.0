import { Schema, type InferSchemaType } from 'mongoose';
import { SyncableEntities } from './SapSyncState';

/**
 * One record per SAP-sync invocation. Supersedes "everything happens inside
 * one HTTP request" — the API kicks off a job, the runner advances it in
 * the background, the UI polls or streams from here.
 *
 * Status lifecycle:
 *
 *   queued → running → completed
 *                   ↘ failed
 *                   ↘ cancelled    (user requested stop)
 *                   ↘ interrupted  (server restarted while running)
 */
export const SyncJobSchema = new Schema(
  {
    entity: { type: String, required: true, enum: SyncableEntities, index: true },

    // Who asked for this and what
    triggeredByEmail: { type: String, required: true, index: true },
    triggeredAt: { type: Date, default: () => new Date(), index: true },

    requestedFrom: String, // ISO 'YYYY-MM-DD'
    requestedTo: String,
    pageSize: Number,
    maxDocs: Number,

    // Status
    status: {
      type: String,
      required: true,
      enum: ['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted'],
      default: 'queued',
      index: true,
    },
    cancelRequested: { type: Boolean, default: false },

    // Live progress (updated by the runner per page)
    progress: {
      fetched: { type: Number, default: 0 },
      created: { type: Number, default: 0 },
      updated: { type: Number, default: 0 },
      unchanged: { type: Number, default: 0 },
      errors: { type: Number, default: 0 },
      currentPage: { type: Number, default: 0 },
      lastDocId: { type: Schema.Types.Mixed, default: null },
    },
    lastProgressAt: Date,

    // Final result — populated on completion / failure
    startedAt: Date,
    finishedAt: Date,
    durationMs: Number,
    pages: Number,
    result: {
      fetched: Number,
      created: Number,
      updated: Number,
      unchanged: Number,
      errors: Number,
      firstId: Schema.Types.Mixed,
      lastId: Schema.Types.Mixed,
      errorSamples: [
        new Schema(
          { id: Schema.Types.Mixed, message: String },
          { _id: false },
        ),
      ],
    },

    errorMessage: String,
  },
  {
    timestamps: true,
    collection: 'sync_jobs',
  },
);

SyncJobSchema.index({ entity: 1, triggeredAt: -1 });
SyncJobSchema.index({ status: 1, triggeredAt: -1 });
SyncJobSchema.index({ triggeredAt: -1 });

export type ISyncJob = InferSchemaType<typeof SyncJobSchema>;
