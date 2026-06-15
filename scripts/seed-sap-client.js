/* eslint-disable no-console */
/**
 * Pre-meeting staging for the CLIENT demo. Two things that CANNOT come from a
 * file upload (they live in SAP), so we stage them once before the meeting:
 *
 *   1. PUSH_INVOICES — 5 real open A/R invoices in MSF_HALAL_TEST (one per
 *      payment method), dated PUSH_DATE. You pay these LIVE during the demo.
 *   2. BANK_MIRROR — "payments already settled in SAP", seeded into the Mongo
 *      payments cache so the uploaded bank statement reconciles against them.
 *
 * Writes data/client-june2026/client-sap-invoices.json (the exact DocEntry +
 * DocTotal to enter during the demo).
 *
 *   node scripts/seed-sap-client.js
 *
 * SAFETY: refuses unless SAP_COMPANY_DB_PARIS === MSF_HALAL_TEST.
 * PREREQUISITE: a GBP daily exchange rate must exist in SAP for PUSH_DATE
 * (2026-06-10) — otherwise SAP rejects with "Update the exchange rate , 'GBP'".
 * Override with SAP_INV_DATE=YYYY-MM-DD (use a date that already has a rate,
 * e.g. 2026-06-01).
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const axios = require('axios');
const mongoose = require('mongoose');
const { PUSH_INVOICES, PUSH_DATE, BANK_MIRROR, lineTotalFor } = require('./client-june-data');

const BASE = (process.env.SAP_BASE_URL_PARIS || '').replace(/\/$/, '');
const COMPANY_DB = process.env.SAP_COMPANY_DB_PARIS;
const TENANT_URI = process.env.TENANT_URI || process.env.TENANT_PARIS_MONGO_URI;
// Default to a date that already has a GBP rate in the test DB, so staging
// (and the live push) never hits "Update the exchange rate". Set
// SAP_INV_DATE=2026-06-10 (after adding that day's GBP rate) for date-coherence.
const INV_DATE = process.env.SAP_INV_DATE || '2026-06-01';
const OUT = path.resolve(__dirname, '../data/client-june2026/client-sap-invoices.json');
const REVENUE_ACCOUNT = '707000';
const VAT_GROUP = 'C3';

if (COMPANY_DB !== 'MSF_HALAL_TEST') {
  console.error(`REFUSING: SAP_COMPANY_DB_PARIS is "${COMPANY_DB}", not the authorized test DB MSF_HALAL_TEST.`);
  process.exit(3);
}

const d = (iso) => new Date(`${iso}T00:00:00.000Z`);

async function login() {
  const r = await axios.post(`${BASE}/Login`, {
    CompanyDB: COMPANY_DB, UserName: process.env.SAP_USERNAME_PARIS, Password: process.env.SAP_PASSWORD_PARIS,
  }, { validateStatus: () => true });
  if (r.status !== 200) throw new Error(`SAP login failed ${r.status}: ${JSON.stringify(r.data)}`);
  return r.headers['set-cookie'].map((c) => c.split(';')[0]).join('; ');
}

function mirrorMethodFields(m, p) {
  switch (m) {
    case 'cheque': return { PaymentChecks: [{ CheckSum: p.total, DueDate: d(p.date), BankCode: '30002', CheckNumber: 9900456 }] };
    case 'card':   return { PaymentCreditCards: [{ CreditSum: p.total, CreditCard: 1, CreditAcct: '512300' }] };
    case 'bank':   return { TransferSum: p.total, TransferAccount: '512000', TransferDate: d(p.date) };
    case 'cash':
    default:       return { CashSum: p.total };
  }
}

async function main() {
  console.log(`Target SAP CompanyDB = ${COMPANY_DB} (test DB).  Invoice date = ${INV_DATE}`);
  const cookie = await login();
  const conn = await mongoose.createConnection(TENANT_URI).asPromise();
  const Invoice = conn.collection('invoices');
  const Payment = conn.collection('payments');

  // 1) Live-push invoices in SAP.
  const created = [];
  for (const t of PUSH_INVOICES) {
    const body = {
      CardCode: t.cardCode, DocDate: INV_DATE, DocDueDate: INV_DATE, TaxDate: INV_DATE,
      DocType: 'dDocument_Service', Comments: `HFF client demo — ${t.method} target (safe to cancel)`,
      DocumentLines: [{ AccountCode: REVENUE_ACCOUNT, ItemDescription: `HFF client demo — ${t.method}`, LineTotal: lineTotalFor(t.total), VatGroup: VAT_GROUP }],
    };
    const r = await axios.post(`${BASE}/Invoices`, body, { headers: { Cookie: cookie, 'Content-Type': 'application/json' }, validateStatus: () => true });
    if (r.status < 200 || r.status >= 300) {
      console.error(`✗ invoice ${t.cardCode} ${t.method}: ${r.status} ${JSON.stringify(r.data).slice(0, 160)}`);
      continue;
    }
    const inv = r.data;
    const exact = inv.DocTotal === t.total ? '' : `  (DocTotal ${inv.DocTotal} ≠ target ${t.total} — enter ${inv.DocTotal})`;
    console.log(`✓ ${t.method.padEnd(8)} ${t.cardCode}  DocEntry=${inv.DocEntry} DocTotal=${inv.DocTotal}${exact}`);
    await Invoice.updateOne(
      { DocEntry: inv.DocEntry },
      { $set: {
          DocEntry: inv.DocEntry, DocNum: inv.DocNum, DocType: 'dDocument_Service',
          CardCode: inv.CardCode, CardName: inv.CardName, DocDate: d(INV_DATE), DocDueDate: d(INV_DATE),
          DocCurrency: inv.DocCurrency || 'EUR', DocTotal: inv.DocTotal, PaidToDate: 0,
          DocumentStatus: 'O', Cancelled: 'tNO', Comments: body.Comments, lastSyncedAt: new Date(),
        } },
      { upsert: true },
    );
    created.push({ method: t.method, cardCode: inv.CardCode, cardName: t.cardName, docEntry: inv.DocEntry, docNum: inv.DocNum, amount: inv.DocTotal, date: INV_DATE });
  }
  fs.writeFileSync(OUT, JSON.stringify(created, null, 2));
  console.log(`Wrote ${created.length} push invoice(s) → ${path.relative(process.cwd(), OUT)}`);

  // 2) Bank mirror (payments already in SAP) into the payments cache.
  let mirrorN = 0;
  for (let i = 0; i < BANK_MIRROR.length; i++) {
    const p = BANK_MIRROR[i];
    const docEntry = 95000 + i; // synthetic mirror DocEntry range (demo only)
    await Payment.updateOne(
      { DocEntry: docEntry },
      { $set: {
          DocEntry: docEntry, DocNum: 31000 + i, DocType: 'rCustomer',
          CardCode: p.cardCode, CardName: p.cardName, DocDate: d(p.date), DocCurrency: 'EUR',
          DocTotal: p.total, Cancelled: 'tNO', ...mirrorMethodFields(p.method, p), lastSyncedAt: new Date(),
        } },
      { upsert: true },
    );
    mirrorN++;
  }
  console.log(`Seeded ${mirrorN} bank-mirror payment(s) for verification.`);

  await conn.close();
  await mongoose.disconnect();
  if (created.length < PUSH_INVOICES.length) {
    console.log('\nSome invoices failed — usually a missing GBP exchange rate for the invoice date. Add it in SAP (or set SAP_INV_DATE=2026-06-01) and re-run.');
  }
  console.log('\n✅ Client demo staged.');
}
main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
