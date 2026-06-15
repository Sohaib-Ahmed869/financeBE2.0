/* eslint-disable no-console */
/**
 * HalalFoods Finance v2 — single end-to-end smoke test for the JUNE 2026 dataset.
 *
 * Drives the REAL running API (login → tenant header → CSRF) through every
 * pipeline the morning/day/end-of-day/weekly flows use, and prints one
 * PASS/FAIL table at the end. Safe to run repeatedly.
 *
 *   1. cd be && npm run dev                      # API on :4000 (separate terminal)
 *   2. node scripts/seed-june2026.js  (or .ts)   # tenant base data
 *   3. node scripts/e2e-june2026.js              # <-- this
 *
 * Flags / env:
 *   API=http://127.0.0.1:4000   COMPANY=paris
 *   EMAIL=... PASSWORD=...       (defaults to the seeded super-admin from .env)
 *   --with-sap                   also run the live SAP push step (creates a real
 *                                IncomingPayment in the SAP test DB)
 *   --quiet                      less per-step chatter
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const axios = require('axios');
const FormData = require('form-data');

const API = (process.env.API || 'http://127.0.0.1:4000').replace(/\/$/, '');
const COMPANY = process.env.COMPANY || 'paris';
const EMAIL = process.env.EMAIL || process.env.SEED_SOHAIB_EMAIL;
const PASSWORD = process.env.PASSWORD || process.env.SEED_SOHAIB_PASSWORD;
const DATA = path.resolve(__dirname, '../data/june2026');
const WITH_SAP = process.argv.includes('--with-sap');
const QUIET = process.argv.includes('--quiet');

const CSRF_COOKIE = process.env.CSRF_COOKIE_NAME || 'hff_csrf';

const cookies = {}; // name -> value
function cookieHeader() {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}
function storeSetCookie(res) {
  const sc = res.headers?.['set-cookie'];
  if (!sc) return;
  for (const line of sc) {
    const [pair] = line.split(';');
    const idx = pair.indexOf('=');
    if (idx > 0) cookies[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
}

async function req(method, p, { json, form, headers = {}, company = true } = {}) {
  const url = p.startsWith('http') ? p : `${API}${p}`;
  const h = { ...headers };
  if (Object.keys(cookies).length) h.Cookie = cookieHeader();
  if (company) h['X-Company'] = COMPANY;
  if (!['GET', 'HEAD'].includes(method.toUpperCase()) && cookies[CSRF_COOKIE]) {
    h['X-CSRF-Token'] = cookies[CSRF_COOKIE];
  }
  let data = json;
  if (form) Object.assign(h, form.getHeaders());
  else if (json !== undefined) h['Content-Type'] = 'application/json';

  const res = await axios.request({
    url, method, headers: h, data: form || data,
    timeout: 120000, validateStatus: () => true, maxContentLength: Infinity,
  });
  storeSetCookie(res);
  return res;
}

function upload(p, file, { headers = {}, fields = {} } = {}) {
  const form = new FormData();
  const buf = fs.readFileSync(path.join(DATA, file));
  form.append('file', buf, { filename: file });
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return req('POST', p, { form, headers });
}

/* ----------------------------- test harness ----------------------------- */
const results = [];
let group = '';
function section(name) { group = name; if (!QUIET) console.log(`\n=== ${name} ===`); }
function pass(name, detail = '') { results.push({ group, name, ok: true, detail }); if (!QUIET) console.log(`  ✓ ${name}${detail ? '  ' + detail : ''}`); }
function fail(name, detail = '') { results.push({ group, name, ok: false, detail }); console.log(`  ✗ ${name}${detail ? '  ' + detail : ''}`); }
function check(name, cond, detail = '') { cond ? pass(name, detail) : fail(name, detail); return cond; }
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const near = (a, b, eps = 0.011) => Math.abs(Number(a) - Number(b)) <= eps;
function body(res) { return typeof res.data === 'object' ? JSON.stringify(res.data).slice(0, 300) : String(res.data).slice(0, 300); }

async function main() {
  console.log(`HFF e2e — API=${API} company=${COMPANY} user=${EMAIL} sap=${WITH_SAP ? 'on' : 'off'}`);

  /* ---- auth ---- */
  section('Auth');
  // Prime the double-submit CSRF cookie (server sets it on the first request).
  await req('GET', '/api/health', { company: false });
  let r = await req('POST', '/api/auth/login', { json: { email: EMAIL, password: PASSWORD }, company: false });
  if (!check('login', r.status === 200, `status=${r.status}`)) {
    console.log('  login body:', body(r));
    return finish();
  }
  r = await req('GET', '/api/auth/me');
  check('me + company access', r.status === 200, `status=${r.status}`);

  /* ---- SAP connectivity ---- */
  section('SAP connectivity');
  r = await req('POST', '/api/sap/test', { json: {} });
  check('SAP login (test DB)', r.status === 200 && r.data?.ok, `status=${r.status} db=${r.data?.companyDB || ''}`);

  await runZReport();
  await runDaybook();
  await runBank();
  await runCardImports();
  await runPaymentsOffline();
  await runDeliveryNotes();
  if (WITH_SAP) await runSapPush();

  finish();
}

/* =============================== Z-REPORT =============================== */
async function runZReport() {
  section('POS / Z-report (end of day)');
  const date = '2026-06-05';
  let r = await upload(`/api/zreports/upload?date=${date}`, '050626 ZREPORT JUIN.XLSX');
  if (!check('upload Z-report', r.status === 201 || r.status === 200, `status=${r.status}`)) {
    console.log('   body:', body(r)); return;
  }
  r = await req('GET', `/api/zreports/${date}`);
  check('read Z-report', r.status === 200, `status=${r.status}`);
  const z = r.data || {};
  if (!QUIET) console.log('   parsed:', JSON.stringify(z).slice(0, 400));
  check('Z totals cash 196.47', near(z.totals?.cash, 196.47), `got ${z.totals?.cash}`);
  check('Z totals cheque 271.40', near(z.totals?.cheque, 271.4), `got ${z.totals?.cheque}`);
  check('Z totals card 110.19', near(z.totals?.card, 110.19), `got ${z.totals?.card}`);
  check('Z net discrepancy -6.47', near(z.netDiscrepancy, -6.47), `got ${z.netDiscrepancy}`);

  r = await req('PUT', `/api/zreports/${date}/counted-cash`, { json: { countedCash: 190 } });
  check('set counted cash', r.status === 200, `status=${r.status}`);
  r = await req('POST', `/api/zreports/${date}/verify`, { json: {} });
  check('verify Z-report', r.status === 200, `status=${r.status}`);
  if (!QUIET) console.log('   verify:', JSON.stringify(r.data).slice(0, 400));
}

/* =============================== DAYBOOK =============================== */
async function runDaybook() {
  section('Daybook (Feuille de solde)');
  let r = await upload('/api/daybook/upload', 'Feuille de solde Juin 2026.xlsx');
  if (!check('upload daybook', r.status === 201 || r.status === 200, `status=${r.status}`)) {
    console.log('   body:', body(r)); return;
  }
  if (!QUIET) console.log('   upload result:', JSON.stringify(r.data).slice(0, 400));
  check('daybook parsed 4 day-sheets', r.data?.daysParsed === 4, `daysParsed=${r.data?.daysParsed}`);
  r = await req('GET', '/api/daybook/months/2026/6');
  check('read June month', r.status === 200, `status=${r.status}`);
  r = await req('GET', '/api/daybook/months/2026/6/export');
  check('export June (parity)', r.status === 200, `status=${r.status} type=${r.headers['content-type'] || ''}`);
}

/* ============================ BANK RECON ============================ */
async function runBank() {
  section('Bank reconciliation (verification only)');
  let r = await upload('/api/bank-statements/upload', 'BANK JUIN 2026.csv', { fields: { bankKey: 'bred' } });
  if (!check('upload bank statement', r.status === 201 || r.status === 200, `status=${r.status}`)) {
    console.log('   body:', body(r)); return;
  }
  const id = r.data?.id || r.data?._id || r.data?.statement?.id;
  if (!QUIET) console.log('   upload result:', JSON.stringify(r.data).slice(0, 400));
  if (!check('statement id returned', !!id, `id=${id}`)) return;
  check('bank parsed 7 lines', r.data?.linesParsed === 7, `linesParsed=${r.data?.linesParsed}`);
  r = await req('POST', `/api/bank-statements/${id}/auto-match`, { json: {} });
  check('auto-match bank', r.status === 200, `status=${r.status}`);
  if (!QUIET) console.log('   auto-match:', JSON.stringify(r.data).slice(0, 700));
  const st = r.data?.statement || {};
  const mr = st.methodReconciliation || [];
  check('bank: 5 lines matched', st.linesMatchedCount === 5, `matched=${st.linesMatchedCount}`);
  check('bank: a "missing in bank" outcome', mr.some((m) => /missing/i.test(m.status)), `statuses=${mr.map((m) => m.status).join(',')}`);
}

/* ============================ CARD IMPORTS ============================ */
async function runCardImports() {
  section('Card imports (PayPal / Sogecommerce)');
  let r = await upload('/api/card-imports/upload?provider=paypal', 'PAYPAL JUIN 2026.CSV');
  check('upload PayPal', r.status === 201 || r.status === 200, `status=${r.status}`);
  if (!QUIET) console.log('   paypal:', JSON.stringify(r.data).slice(0, 400));
  check('PayPal: 2 rows parsed', r.data?.rows === 2, `rows=${r.data?.rows}`);

  r = await upload('/api/card-imports/upload?provider=sogecommerce-site', 'Listing_transactions_remisees_juin.xlsx');
  check('upload Sogecommerce txns', r.status === 201 || r.status === 200, `status=${r.status}`);
  if (!QUIET) console.log('   soge txns:', JSON.stringify(r.data).slice(0, 400));
  check('Soge: 2 valid rows (Rejeté skipped)', r.data?.rows === 2, `rows=${r.data?.rows}`);

  r = await upload('/api/card-imports/upload-remises', 'Listing_remises_juin.xlsx');
  check('upload Sogecommerce remises', r.status === 201 || r.status === 200, `status=${r.status}`);
  if (!QUIET) console.log('   remises:', JSON.stringify(r.data).slice(0, 400));
  check('Remises: 2 batches', r.data?.rows === 2, `rows=${r.data?.rows}`);
}

/* ===================== PAYMENTS entry + match (offline) ===================== */
const PAYMENT_PLAN = [
  { docEntry: 5001, cardCode: 'C2622', method: 'Cheque', amount: 1240.5, date: '2026-06-02', cheque: { chequeNumber: '8801234', bankCode: '30002', bankName: 'BRED', payerName: 'CHICKEN ASIA', chequeDate: '2026-06-02' } },
  { docEntry: 5002, cardCode: 'C4494', method: 'Bank', amount: 284.64, date: '2026-06-02', bank: { transferReference: 'VIR-MCV-0602', bankAccount: '512000' } },
  { docEntry: 5003, cardCode: 'C6819', method: 'CB-Site', amount: 980.0, date: '2026-06-03', card: { transactionId: 'SOGE-5003' } },
  { docEntry: 5004, cardCode: 'C2983', method: 'PayPal', amount: 156.3, date: '2026-06-03', card: { transactionId: 'PP-5004' } },
  { docEntry: 5005, cardCode: 'C2422', method: 'Cash', amount: 432.75, date: '2026-06-04' },
  { docEntry: 5006, cardCode: 'C3050', method: 'CB-Phone', amount: 610.2, date: '2026-06-04', card: { transactionId: 'CBP-5006' } },
];

async function runPaymentsOffline() {
  section('Payments — entry + reconcile (no push)');
  global.__entries = [];
  for (const p of PAYMENT_PLAN) {
    const payload = { date: p.date, cardCode: p.cardCode, method: p.method, amount: p.amount };
    if (p.cheque) payload.cheque = p.cheque;
    if (p.bank) payload.bank = p.bank;
    if (p.card) payload.card = p.card;
    let r = await req('POST', '/api/payments', { json: payload });
    if (!check(`enter ${p.method} ${p.amount}`, r.status === 201 || r.status === 200, `status=${r.status}`)) {
      console.log('   body:', body(r)); continue;
    }
    const id = r.data?.id || r.data?._id;
    r = await req('PUT', `/api/payments/${id}/match`, { json: { invoiceDocEntry: p.docEntry, matchedVia: 'manual' } });
    check(`match -> invoice ${p.docEntry}`, r.status === 200, `status=${r.status}`);
    global.__entries.push({ ...p, id });
  }
  // Account method (no push) on invoice 5008
  let r = await req('POST', '/api/payments', { json: { date: '2026-06-05', cardCode: 'C2622', method: 'Account', amount: 540.0 } });
  if (r.status === 201 || r.status === 200) {
    const id = r.data?.id || r.data?._id;
    r = await req('PUT', `/api/payments/${id}/match`, { json: { onAccount: true } });
    check('Account payment on-account', r.status === 200, `status=${r.status}`);
  } else {
    check('Account payment entry', false, `status=${r.status} ${body(r)}`);
  }
}

/* ============================ DELIVERY NOTES ============================ */
async function runDeliveryNotes() {
  section('Delivery notes (morning convert list)');
  const r = await req('GET', '/api/delivery-notes?status=open&limit=50');
  check('list open delivery notes', r.status === 200, `status=${r.status} count=${(r.data?.items || r.data || []).length ?? '?'}`);
}

/* ============================ LIVE SAP PUSH ============================ */
async function runSapPush() {
  section('LIVE SAP push (creates real IncomingPayments in SAP test DB)');
  const jsonPath = path.join(DATA, 'sap-invoices.json');
  if (!fs.existsSync(jsonPath)) {
    fail('SAP invoices file', `missing ${jsonPath} — run: node scripts/seed-sap-june2026.js first`);
    return;
  }
  const targets = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  if (!Array.isArray(targets) || targets.length === 0) {
    fail('SAP invoices file', 'no invoices recorded — seed-sap-june2026.js created none (check exchange rates)');
    return;
  }
  for (const t of targets) {
    const label = `${t.method} ${t.cardCode} ${t.amount} (inv ${t.docEntry})`;
    const payload = { date: t.date, cardCode: t.cardCode, method: t.method, amount: t.amount };
    if (t.method === 'Cheque') payload.cheque = { chequeNumber: '9900001', bankCode: '', payerName: t.cardCode, chequeDate: t.date };
    if (t.method === 'Bank') payload.bank = { transferReference: `VIR-${t.docEntry}`, bankAccount: '512000' };
    if (['CB-Site', 'CB-Phone', 'PayPal'].includes(t.method)) payload.card = { transactionId: `TX-${t.docEntry}` };

    let r = await req('POST', '/api/payments', { json: payload });
    if (!check(`enter ${label}`, r.status === 201 || r.status === 200, `status=${r.status}`)) { console.log('   body:', body(r)); continue; }
    const id = r.data?.id || r.data?._id;
    r = await req('PUT', `/api/payments/${id}/match`, { json: { invoiceDocEntry: t.docEntry, matchedVia: 'manual' } });
    if (!check(`match ${label}`, r.status === 200, `status=${r.status}`)) continue;
    r = await req('POST', `/api/payments/${id}/push`, { json: {} });
    check(`PUSH ${label}`, r.status === 200 && r.data?.status === 'pushed',
      `status=${r.status} sapDocEntry=${r.data?.sapDocEntry || ''} table=${r.data?.sapTable || ''} ${r.data?.status === 'pushed' ? '' : body(r)}`);
  }
}

/* ================================ SUMMARY ================================ */
function finish() {
  const total = results.length;
  const ok = results.filter((x) => x.ok).length;
  console.log(`\n${'='.repeat(60)}\nSUMMARY  ${ok}/${total} passed\n${'='.repeat(60)}`);
  let g = '';
  for (const r of results) {
    if (r.group !== g) { g = r.group; console.log(`\n${g}`); }
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
  }
  console.log('');
  process.exit(ok === total ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e.stack || e.message); process.exit(2); });
