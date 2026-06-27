/**
 * Syncs invoices, delivery-notes, and payments from SAP for the last 3 months
 * across all three tenant companies (paris, bordeaux, lyon).
 *
 * Does NOT sync customers — those already exist in SAP and are untouched.
 *
 * Usage:
 *   npx ts-node scripts/sync-last-3months.ts
 *
 * Optional env overrides:
 *   FROM=2026-01-01   # start date (default: 3 months before today)
 *   TO=2026-06-24     # end date   (default: today)
 *   PAGE_SIZE=100     # SAP page size (default: 100)
 *   COMPANIES=paris   # comma-separated subset (default: paris,bordeaux,lyon)
 */
import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

import mongoose from 'mongoose';
import { connectMaster } from '../src/db/master';
import { getTenantModelsFor } from '../src/db/tenant';
import { syncEntity } from '../src/sap/sync';
import { ENTITY_CONFIGS } from '../src/sap/entityConfig';

const ENTITIES_TO_SYNC = ['invoices', 'delivery-notes', 'payments'];
const ALL_COMPANIES = ['paris', 'bordeaux', 'lyon'];

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

function isoDate(d: Date) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function threeMonthsAgo(): string {
  const d = new Date();
  d.setMonth(d.getMonth() - 3);
  return isoDate(d);
}

async function runSync() {
  const FROM = process.env.FROM ?? threeMonthsAgo();
  const TO = process.env.TO ?? isoDate(new Date());
  const PAGE_SIZE = parseInt(process.env.PAGE_SIZE ?? '100', 10);
  const COMPANIES = (process.env.COMPANIES ?? ALL_COMPANIES.join(',')).split(',').map((c) => c.trim());
  const ENTITIES = (process.env.ENTITIES ?? ENTITIES_TO_SYNC.join(',')).split(',').map((e) => e.trim());

  console.log(`\n=== SAP sync ===`);
  console.log(`  Date range : ${FROM} → ${TO}`);
  console.log(`  Entities   : ${ENTITIES.join(', ')}`);
  console.log(`  Companies  : ${COMPANIES.join(', ')}`);
  console.log(`  Page size  : ${PAGE_SIZE}\n`);

  await connectMaster();

  const results: Array<{
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
  }> = [];

  for (const company of COMPANIES) {
    for (const entitySlug of ENTITIES) {
      const cfg = ENTITY_CONFIGS[entitySlug];
      if (!cfg) {
        console.warn(`  [WARN] Unknown entity slug: ${entitySlug} — skipping`);
        continue;
      }

      const label = `  [${company}/${cfg.entity}]`;
      console.log(`${label} starting…`);
      const start = Date.now();

      try {
        const result = await syncEntity(company, cfg, {
          from: FROM,
          to: TO,
          pageSize: PAGE_SIZE,
          onProgress: (snap) => {
            process.stdout.write(
              `\r${label} page=${snap.currentPage} fetched=${snap.fetched} (+${snap.created}/~${snap.updated}/=${snap.unchanged}) err=${snap.errors}   `,
            );
          },
        });

        process.stdout.write('\n');
        const s = result.stats;
        console.log(
          `${label} done — fetched=${s.fetched} created=${s.created} updated=${s.updated} unchanged=${s.unchanged} errors=${s.errors} in ${result.durationMs}ms`,
        );
        if (s.errorSamples.length > 0) {
          console.log(`${label} error samples:`);
          s.errorSamples.slice(0, 3).forEach((e) => console.log(`    id=${e.id}: ${e.message}`));
        }

        results.push({
          company,
          entity: cfg.entity,
          ok: true,
          fetched: s.fetched,
          created: s.created,
          updated: s.updated,
          unchanged: s.unchanged,
          errors: s.errors,
          durationMs: result.durationMs,
        });
      } catch (err) {
        process.stdout.write('\n');
        const message = err instanceof Error ? err.message : String(err);
        console.error(`${label} FAILED — ${message}`);
        results.push({ company, entity: cfg.entity, ok: false, message });
      }
    }
  }

  console.log('\n=== Summary ===');
  const width = Math.max(...results.map((r) => `${r.company}/${r.entity}`.length));
  for (const r of results) {
    const key = `${r.company}/${r.entity}`.padEnd(width);
    if (r.ok) {
      console.log(
        `  ${key}  ✓ fetched=${r.fetched} (+${r.created}/~${r.updated}/=${r.unchanged}) err=${r.errors} ${r.durationMs}ms`,
      );
    } else {
      console.log(`  ${key}  ✗ ${r.message}`);
    }
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`\n${failed.length} sync(s) failed.`);
    process.exit(1);
  }

  console.log('\nAll syncs completed successfully.');
  process.exit(0);
}

runSync().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
