/* eslint-disable no-console */
/**
 * Pushes the JUNE 2026 "initial data" into the LIVE SAP test company
 * (MSF_HALAL_TEST): creates real open A/R invoices for existing customers,
 * then mirrors them into the Mongo invoice cache so the app reconciles
 * against real SAP DocEntries. Writes data/june2026/sap-invoices.json which
 * the e2e driver's `--with-sap` step reads to push real payments.
 *
 *   node scripts/seed-sap-june2026.js
 *
 * SAFETY: refuses to run unless SAP_COMPANY_DB_PARIS === MSF_HALAL_TEST.
 *
 * PREREQUISITE: the SAP test DB must have a daily exchange rate for GBP on
 * each invoice DocDate, or SAP rejects the post with
 *   "Update the exchange rate , 'GBP'".
 * Add the rates in SAP (Administration > Exchange Rates) for 02–05 June 2026
 * before running. Service-type invoices (revenue account + VAT group) are used
 * so no inventory/stock is required.
 *
 * Idempotent-ish: SAP always assigns a NEW DocEntry per run, so re-running
 * creates fresh invoices. Run once; the JSON captures what was created.
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const axios = require('axios');
const mongoose = require('mongoose');

const BASE = (process.env.SAP_BASE_URL_PARIS || '').replace(/\/$/, '');
const COMPANY_DB = process.env.SAP_COMPANY_DB_PARIS;
const TENANT_URI = process.env.TENANT_URI || process.env.TENANT_PARIS_MONGO_URI;
const OUT = path.resolve(__dirname, '../data/june2026/sap-invoices.json');

// Revenue account + sales VAT group copied from a real posted invoice in this DB.
const REVENUE_ACCOUNT = '707000';
const VAT_GROUP = 'C3';

if (COMPANY_DB !== 'MSF_HALAL_TEST') {
  console.error(`REFUSING: SAP_COMPANY_DB_PARIS is "${COMPANY_DB}", not the authorized test DB MSF_HALAL_TEST.`);
  process.exit(3);
}

// Existing BPs in MSF_HALAL_TEST. `lineTotal` is pre-VAT; SAP computes the
// real DocTotal — we capture and use that for the payment, so VAT need not be
// exact. method drives which RCT sub-table the payment hits on push.
// All dated 2026-06-01 — the date confirmed to carry a GBP daily rate in the
// test DB. (The offline pipeline already exercises the full multi-date spread;
// the live-SAP proof only needs real invoices to post payments against.)
const INV_DATE = process.env.SAP_INV_DATE || '2026-06-01';
const TARGETS = [
  { cardCode: 'C2622', date: INV_DATE, lineTotal: 1175.83, method: 'Cheque', desc: 'HFF e2e — cheque target' },
  { cardCode: 'C4494', date: INV_DATE, lineTotal: 269.80, method: 'Bank', desc: 'HFF e2e — bank target' },
  { cardCode: 'C6819', date: INV_DATE, lineTotal: 928.91, method: 'CB-Site', desc: 'HFF e2e — CB-site target' },
  { cardCode: 'C2983', date: INV_DATE, lineTotal: 148.15, method: 'PayPal', desc: 'HFF e2e — PayPal target' },
  { cardCode: 'C2422', date: INV_DATE, lineTotal: 410.19, method: 'Cash', desc: 'HFF e2e — cash target' },
  { cardCode: 'C3050', date: INV_DATE, lineTotal: 578.39, method: 'CB-Phone', desc: 'HFF e2e — CB-phone target' },
];

async function login() {
  const r = await axios.post(`${BASE}/Login`, {
    CompanyDB: COMPANY_DB, UserName: process.env.SAP_USERNAME_PARIS, Password: process.env.SAP_PASSWORD_PARIS,
  }, { validateStatus: () => true });
  if (r.status !== 200) throw new Error(`SAP login failed ${r.status}: ${JSON.stringify(r.data)}`);
  return r.headers['set-cookie'].map((c) => c.split(';')[0]).join('; ');
}

async function createInvoice(cookie, t) {
  const body = {
    CardCode: t.cardCode, DocDate: t.date, DocDueDate: t.date, TaxDate: t.date,
    DocType: 'dDocument_Service',
    Comments: t.desc + ' (safe to cancel)',
    DocumentLines: [{ AccountCode: REVENUE_ACCOUNT, ItemDescription: t.desc, LineTotal: t.lineTotal, VatGroup: VAT_GROUP }],
  };
  const r = await axios.post(`${BASE}/Invoices`, body, { headers: { Cookie: cookie, 'Content-Type': 'application/json' }, validateStatus: () => true });
  if (r.status < 200 || r.status >= 300) {
    throw new Error(`create ${t.cardCode}/${t.date} -> ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
  }
  return r.data; // full invoice incl. DocEntry, DocNum, DocTotal, CardName
}

async function main() {
  console.log(`Target SAP CompanyDB = ${COMPANY_DB} (test DB)`);
  const cookie = await login();

  const conn = await mongoose.createConnection(TENANT_URI).asPromise();
  const Invoice = conn.collection('invoices'); // raw collection — no schema needed

  const created = [];
  for (const t of TARGETS) {
    try {
      const inv = await createInvoice(cookie, t);
      console.log(`✓ ${t.cardCode} ${t.date}  DocEntry=${inv.DocEntry} DocNum=${inv.DocNum} DocTotal=${inv.DocTotal} (${t.method})`);
      await Invoice.updateOne(
        { DocEntry: inv.DocEntry },
        { $set: {
            DocEntry: inv.DocEntry, DocNum: inv.DocNum, DocType: 'dDocument_Service',
            CardCode: inv.CardCode, CardName: inv.CardName,
            DocDate: new Date(`${t.date}T00:00:00.000Z`), DocDueDate: new Date(`${t.date}T00:00:00.000Z`),
            DocCurrency: inv.DocCurrency || 'EUR', DocTotal: inv.DocTotal, PaidToDate: 0,
            DocumentStatus: 'O', Cancelled: 'tNO',
            Comments: t.desc, lastSyncedAt: new Date(),
          } },
        { upsert: true },
      );
      created.push({ docEntry: inv.DocEntry, docNum: inv.DocNum, cardCode: inv.CardCode, amount: inv.DocTotal, date: t.date, method: t.method });
    } catch (e) {
      console.error(`✗ ${t.cardCode} ${t.date}: ${e.message}`);
    }
  }

  fs.writeFileSync(OUT, JSON.stringify(created, null, 2));
  console.log(`\nWrote ${created.length} invoice(s) to ${path.relative(process.cwd(), OUT)}`);
  if (created.length < TARGETS.length) {
    console.log('Some invoices failed — usually a missing GBP exchange rate for that DocDate. Add it in SAP and re-run.');
  }
  await conn.close();
  await mongoose.disconnect();
}

main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
