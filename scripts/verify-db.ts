/**
 * Verifies the state of all three tenant DBs.
 * Run after prepare-for-client to confirm:
 *   - SAP read-models are populated (invoices, delivery_notes, payments, customers)
 *   - Test/uploaded data is gone (bank_statements, import_files, daybook_files, etc.)
 *
 * Usage:
 *   npx ts-node scripts/verify-db.ts
 *   npx ts-node scripts/verify-db.ts COMPANIES=paris
 */
import path from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import mongoose from 'mongoose';

const ALL_COMPANIES = ['paris', 'bordeaux', 'lyon'];

const TENANT_URIS: Record<string, string | undefined> = {
  paris:    process.env.TENANT_PARIS_MONGO_URI,
  bordeaux: process.env.TENANT_BORDEAUX_MONGO_URI,
  lyon:     process.env.TENANT_LYON_MONGO_URI,
};

// Collections we EXPECT to have data
const EXPECTED = [
  'invoices',
  'delivery_notes',
  'payments',
  'customers',
];

// Collections that MUST be empty (test/uploaded data)
const MUST_BE_EMPTY = [
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
];

function hr(n = 60) { return '─'.repeat(n); }
function pad(s: string, n: number) { return s.padEnd(n); }

async function verifyCompany(company: string, uri: string) {
  const conn = await mongoose.createConnection(uri).asPromise();
  const db = conn.db!;

  console.log(`\n  ${company.toUpperCase()}  (${conn.name})`);
  console.log('  ' + hr(56));

  let allOk = true;

  console.log('  SAP read-models:');
  for (const coll of EXPECTED) {
    const count = await db.collection(coll).countDocuments();
    const ok = count > 0;
    if (!ok) allOk = false;
    const icon = ok ? '✓' : '✗';
    console.log(`    ${icon} ${pad(coll, 20)} ${count.toLocaleString()} docs`);
  }

  // Invoice date range
  try {
    const oldest = await db.collection('invoices').find({}, { projection: { DocDate: 1 } })
      .sort({ DocDate: 1 }).limit(1).toArray();
    const newest = await db.collection('invoices').find({}, { projection: { DocDate: 1 } })
      .sort({ DocDate: -1 }).limit(1).toArray();
    if (oldest[0] && newest[0]) {
      console.log(`      invoice date range: ${oldest[0].DocDate?.toString().slice(0,10)} → ${newest[0].DocDate?.toString().slice(0,10)}`);
    }
  } catch { /* ignore */ }

  console.log('  Test/uploaded data (must all be 0):');
  for (const coll of MUST_BE_EMPTY) {
    const count = await db.collection(coll).countDocuments();
    const ok = count === 0;
    if (!ok) allOk = false;
    const icon = ok ? '✓' : '✗';
    const extra = count > 0 ? `  ← ${count} LEFT — run cleanup` : '';
    console.log(`    ${icon} ${pad(coll, 28)} ${count}${extra}`);
  }

  console.log(`  ${allOk ? '✅ All good' : '❌ Issues found — see above'}`);
  await conn.close();
  return allOk;
}

async function main() {
  const arg = process.argv[2];
  const companies = arg
    ? [arg.replace('COMPANIES=', '')]
    : ALL_COMPANIES;

  console.log('\n' + '═'.repeat(60));
  console.log('  HalalFoods Finance v2 — DB Verification');
  console.log('  ' + new Date().toISOString());
  console.log('═'.repeat(60));

  const results: boolean[] = [];
  for (const company of companies) {
    const uri = TENANT_URIS[company];
    if (!uri) { console.error(`  No URI for ${company}`); results.push(false); continue; }
    results.push(await verifyCompany(company, uri));
  }

  const allOk = results.every(Boolean);
  console.log('\n' + '═'.repeat(60));
  console.log(allOk
    ? '  ✅ System ready for client use.'
    : '  ❌ Some checks failed. Address issues above before handover.');
  console.log('═'.repeat(60) + '\n');
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
