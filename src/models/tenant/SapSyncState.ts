import { Schema, type InferSchemaType } from 'mongoose';

/**
 * Per-entity SAP sync cursor. One row per (tenant DB × entity).
 *
 * The sync worker reads `lastDocEntryProcessed` to know where to pick up,
 * and writes `lastSyncedAt` / counters / errors after each run.
 */
export const SyncableEntities = [
  'Customer',
  'Item',
  'Invoice',
  'SalesOrder',
  'DeliveryNote',
  'CreditNote',
  'Return',
  'Payment',
] as const;
export type SyncableEntity = (typeof SyncableEntities)[number];

export const SapSyncStateSchema = new Schema(
  {
    entity: {
      type: String,
      required: true,
      unique: true,
      enum: SyncableEntities,
      index: true,
    },

    // Cursor strategy: SAP returns marketing docs in DocEntry order. The worker
    // pulls everything > lastDocEntryProcessed. For Customer (keyed by CardCode),
    // we use UpdateDate as the cursor instead — see `lastUpdateCursor`.
    lastDocEntryProcessed: { type: Number, default: 0 },
    lastUpdateCursor: Date,

    // Stats
    lastSyncStartedAt: Date,
    lastSyncFinishedAt: Date,
    lastSyncedAt: { type: Date, index: true },
    lastDurationMs: Number,
    nextScheduledSyncAt: Date,
    intervalSeconds: { type: Number, default: 300 }, // default: every 5 min

    // Health
    successfulSyncs: { type: Number, default: 0 },
    failedSyncs: { type: Number, default: 0 },
    consecutiveFailures: { type: Number, default: 0 },
    lastError: String,
    lastErrorAt: Date,

    // Volume
    totalDocsProcessed: { type: Number, default: 0 },
    docsProcessedLastRun: { type: Number, default: 0 },

    // A circuit-breaker — flipped on by the worker when too many failures
    // in a row. UI surfaces this as "Sync paused, intervention needed".
    paused: { type: Boolean, default: false },
    pausedAt: Date,
    pauseReason: String,
  },
  {
    timestamps: true,
    collection: 'sap_sync_state',
  },
);

export type ISapSyncState = InferSchemaType<typeof SapSyncStateSchema>;
