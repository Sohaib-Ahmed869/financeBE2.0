/**
 * Prepares the system for client use:
 *
 * 1. Syncs invoices, delivery-notes, payments from SAP (last 3 months)
 *    for all three companies — or just one via COMPANIES= env override.
 * 2. Syncs customers (full-table) for all three companies.
 * 3. Removes uploaded test data from every tenant DB:
 *      - bank_statements, bank_statement_lines
 *      - daybook_files, daybook_days
 *      - import_files, import_rows  (PayPal / Sogecommerce uploads)
 *      - payment_entries, payment_matches (test entries; SAP Payment mirror kept)
 *      - discrepancies, resolutions   (derived from test data)
 *      - sync_jobs                    (old job log — not business data)
 *
 * SAP-sourced read-models are NEVER touched:
 *    invoices, delivery_notes, payments (SAP mirror), customers, items,
 *    sales_orders, credit_notes, returns, sap_sync_state
 *
 * Users, roles, permissions, companies in the master DB are NEVER touched.
 *
 * Usage:
 *   npx ts-node scripts/prepare-for-client.ts
 *
 * Optional overrides:
 *   FROM=2026-01-01            (default: 3 months ago)
 *   TO=2026-06-27              (default: today)
 *   COMPANIES=paris            (default: paris,bordeaux,lyon)
 *   SKIP_SYNC=true             (skip SAP sync, cleanup only)
 *   SKIP_CLEANUP=true          (sync only, no cleanup)
 */
import path from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// Force stdout/stderr to flush synchronously — critical when piped to a file.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
if ((process.stdout as any)._handle?.setBlocking) (process.stdout as any)._handle.setBlocking(true);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
if ((process.stderr as any)._handle?.setBlocking) (process.stderr as any)._handle.setBlocking(true);

function log(msg: string) {
  process.stdout.write(`${new Date().toISOString()} ${msg}\n`);
}

import mongoose from 'mongoose';
import { connectMaster } from '../src/db/master';
import { syncEntity } from '../src/sap/sync';
import { ENTITY_CONFIGS } from '../src/sap/entityConfig';

const ALL_COMPANIES = ['paris', 'bordeaux', 'lyon'];

const TENANT_URIS: Record<string, string | undefined> = {
  paris:    process.env.TENANT_PARIS_MONGO_URI,
  bordeaux: process.env.TENANT_BORDEAUX_MONGO_URI,
  lyon:     process.env.TENANT_LYON_MONGO_URI,
};

// Collections to wipe — test/uploaded data only.
// SAP read-model collections are excluded.
const CLEANUP_COLLECTIONS = [
  'bank_statements',
  'bank_statement_lines',
  'daybook_files',
  'daybook_days',
  'import_files',
  'import_rows',
  'payment_entries',
  'payment_matches',
  'discrepancies',
  'resolutions',
  'sync_jobs',
];

// SAP entities to sync for the date window
const DATE_ENTITIES = ['invoices', 'delivery-notes', 'payments'];
// Full-table entities (no date range)
const FULL_TABLE_ENTITIES = ['customers'];

function pad2(n: number) { return String(n).padStart(2, '0'); }
function isoDate(d: Date) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function threeMonthsAgo() { const d = new Date(); d.setMonth(d.getMonth() - 3); return isoDate(d); }

function hr(ch = '─', n = 60) { return ch.repeat(n); }

// ─── Cleanup ──────────────────────────────────────────────────────────────────

async function cleanupCompany(company: string, uri: string) {
  log(`Cleanup: ${company.toUpperCase()}`);
  const conn = await mongoose.createConnection(uri).asPromise();
  let totalDeleted = 0;
  for (const coll of CLEANUP_COLLECTIONS) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const db = conn.db!;
      const before = await db.collection(coll).countDocuments();
      if (before === 0) {
        log(`  ${coll.padEnd(26)} already empty`);
        continue;
      }
      await db.collection(coll).deleteMany({});
      log(`  ${coll.padEnd(26)} deleted ${before}`);
      totalDeleted += before;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`  ${coll.padEnd(26)} skip (${msg})`);
    }
  }
  log(`→ ${totalDeleted} documents removed from ${company}`);
  await conn.close();
}

// ─── SAP sync ────────────────────────────────────────────────────────────────

interface SyncRow {
  company: string;
  entity: string;
  ok: boolean;
  fetched?: number;
  created?: number;
  updated?: number;
  unchanged?: number;
  errors?: number;
  durationMs?: number;
  message?: string;
}

async function syncCompany(
  company: string,
  entitySlug: string,
  from: string | undefined,
  to: string | undefined,
  pageSize: number,
): Promise<SyncRow> {
  const cfg = ENTITY_CONFIGS[entitySlug];
  if (!cfg) return { company, entity: entitySlug, ok: false, message: 'unknown entity' };

  const label = `[${company.padEnd(8)}/${cfg.entity.padEnd(12)}]`;
  log(`${label} starting`);
  try {
    const result = await syncEntity(company, cfg, {
      from,
      to,
      pageSize,
      onProgress: (snap) => {
        log(`${label} pg=${snap.currentPage} fetched=${snap.fetched} (+${snap.created}/~${snap.updated}/=${snap.unchanged})`);
      },
    });
    const s = result.stats;
    log(`${label} ✓ fetched=${s.fetched} (+${s.created}/~${s.updated}/=${s.unchanged}) err=${s.errors} ${result.durationMs}ms`);
    if (s.errorSamples.length > 0) {
      s.errorSamples.slice(0, 2).forEach((e) =>
        log(`  ${label} sample-err id=${e.id}: ${e.message}`),
      );
    }
    return {
      company, entity: cfg.entity, ok: true,
      fetched: s.fetched, created: s.created, updated: s.updated,
      unchanged: s.unchanged, errors: s.errors, durationMs: result.durationMs,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`${label} ✗ ${message}`);
    return { company, entity: entitySlug, ok: false, message };
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const FROM      = process.env.FROM     ?? threeMonthsAgo();
  const TO        = process.env.TO       ?? isoDate(new Date());
  const PAGE_SIZE = parseInt(process.env.PAGE_SIZE ?? '100', 10);
  const COMPANIES = (process.env.COMPANIES ?? ALL_COMPANIES.join(',')).split(',').map((c) => c.trim());
  const SKIP_SYNC    = process.env.SKIP_SYNC === 'true';
  const SKIP_CLEANUP = process.env.SKIP_CLEANUP === 'true';
  // Allow caller to override which date-window entities to sync (comma-separated)
  const ACTIVE_DATE_ENTITIES = process.env.DATE_ENTITIES
    ? process.env.DATE_ENTITIES.split(',').map((e) => e.trim())
    : DATE_ENTITIES;

  log(hr('═'));
  log('  HalalFoods Finance v2 — Client Preparation');
  log(hr('─'));
  log(`  Date range  : ${FROM} → ${TO}`);
  log(`  Companies   : ${COMPANIES.join(', ')}`);
  log(`  SAP sync    : ${SKIP_SYNC ? 'SKIP' : ACTIVE_DATE_ENTITIES.join(', ') + ' + ' + FULL_TABLE_ENTITIES.join(', ')}`);
  log(`  Cleanup     : ${SKIP_CLEANUP ? 'SKIP' : CLEANUP_COLLECTIONS.join(', ')}`);
  log(hr('═'));

  await connectMaster();

  // ── Phase 1: SAP sync ──────────────────────────────────────────────────────
  const syncRows: SyncRow[] = [];
  if (!SKIP_SYNC) {
    log('\n📡 Phase 1 — SAP sync');

    for (const company of COMPANIES) {
      // Date-window entities
      for (const slug of ACTIVE_DATE_ENTITIES) {
        syncRows.push(await syncCompany(company, slug, FROM, TO, PAGE_SIZE));
      }
      // Full-table entities (ignore date range)
      for (const slug of FULL_TABLE_ENTITIES) {
        syncRows.push(await syncCompany(company, slug, undefined, undefined, PAGE_SIZE));
      }
    }

    const failedSync = syncRows.filter((r) => !r.ok);
    if (failedSync.length > 0) {
      log(`⚠️  ${failedSync.length} sync(s) failed:`);
      failedSync.forEach((r) => log(`   ${r.company}/${r.entity}: ${r.message}`));
    } else {
      log('✅ All SAP syncs completed successfully.');
    }
  }

  // ── Phase 2: Cleanup ───────────────────────────────────────────────────────
  if (!SKIP_CLEANUP) {
    log('\n🧹 Phase 2 — Cleanup test uploads');
    for (const company of COMPANIES) {
      const uri = TENANT_URIS[company];
      if (!uri) {
        log(`  [WARN] No URI for ${company} — skipping cleanup`);
        continue;
      }
      await cleanupCompany(company, uri);
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n' + hr('═'));
  console.log('  Summary\n');
  if (syncRows.length > 0) {
    const w = Math.max(...syncRows.map((r) => `${r.company}/${r.entity}`.length));
    for (const r of syncRows) {
      const key = `${r.company}/${r.entity}`.padEnd(w);
      if (r.ok) {
        log(`  ${key}  ✓ fetched=${r.fetched} (+${r.created}/~${r.updated}/=${r.unchanged}) err=${r.errors} ${r.durationMs}ms`);
      } else {
        log(`  ${key}  ✗ ${r.message}`);
      }
    }
  }

  const failed = syncRows.filter((r) => !r.ok);
  if (failed.length > 0) {
    log(`❌ ${failed.length} sync failure(s). Check SAP connectivity and retry.`);
    process.exit(1);
  }

  log('✅ System ready for client use.');
  log(hr('═'));
  process.exit(0);
}

main().catch((err) => {
  log(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
