/* eslint-disable no-console */
/**
 * Clears the Paris tenant's OPERATIONAL pipeline collections so a demo run
 * starts from a clean, tidy state. Leaves the SAP-synced master data
 * (customers, invoices, items, delivery_notes, sync state) untouched.
 *
 *   node scripts/reset-demo.js
 *
 * Safe: local tenant DB only. Followed by seed-june2026 + demo-prepare.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const mongoose = require('mongoose');

const TENANT_URI = process.env.TENANT_URI || process.env.TENANT_PARIS_MONGO_URI;

// Operational pipeline data we regenerate each demo. NOT customers/invoices/
// items/delivery_notes (those mirror SAP) or sap_sync_state.
const CLEAR = [
  'payments',            // SAP payment mirror (re-seeded by seed-june2026)
  'payment_entries',
  'payment_matches',
  'zreports',
  'bank_statements',
  'bank_statement_lines',
  'import_files',        // card imports (PayPal / Sogecommerce)
  'import_rows',
  'daybook_days',
  'daybook_files',
  'discrepancies',
  'resolutions',
  'learned_patterns',
  'sync_jobs',
];

(async () => {
  const conn = await mongoose.createConnection(TENANT_URI).asPromise();
  console.log('connected to tenant DB:', conn.name);
  for (const name of CLEAR) {
    try {
      const before = await conn.db.collection(name).countDocuments();
      await conn.db.collection(name).deleteMany({});
      console.log(`  cleared ${name.padEnd(22)} (${before} → 0)`);
    } catch (e) {
      console.log(`  skip ${name}: ${e.message}`);
    }
  }
  console.log('✅ demo reset complete (master/SAP data preserved).');
  await conn.close();
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
