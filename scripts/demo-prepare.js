/* eslint-disable no-console */
/**
 * Populates the Paris tenant via the live API so every frontend screen has
 * coherent June 2026 data to show a client — then leaves the SAP-backed
 * payments MATCHED-BUT-NOT-PUSHED so you can click "Push to SAP" live in the
 * UI during the demo. Also downloads the daybook Excel export.
 *
 *   node scripts/demo-prepare.js
 *
 * Order (see npm run demo:fe): reset-demo → seed-june2026 → seed-sap-june2026
 * → demo-prepare. Requires the dev server running (npm run dev).
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
const EXPORT_DIR = path.join(DATA, 'exports');
const CSRF_COOKIE = process.env.CSRF_COOKIE_NAME || 'hff_csrf';

const cookies = {};
const cookieHeader = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
function store(res) {
  const sc = res.headers?.['set-cookie'];
  if (!sc) return;
  for (const line of sc) { const p = line.split(';')[0]; const i = p.indexOf('='); if (i > 0) cookies[p.slice(0, i).trim()] = p.slice(i + 1).trim(); }
}
async function req(method, p, { json, form, responseType } = {}) {
  const h = {};
  if (Object.keys(cookies).length) h.Cookie = cookieHeader();
  if (p.startsWith('/api') && p !== '/api/health') h['X-Company'] = COMPANY;
  if (!['GET', 'HEAD'].includes(method) && cookies[CSRF_COOKIE]) h['X-CSRF-Token'] = cookies[CSRF_COOKIE];
  if (form) Object.assign(h, form.getHeaders());
  else if (json !== undefined) h['Content-Type'] = 'application/json';
  const res = await axios.request({ url: `${API}${p}`, method, headers: h, data: form || json, responseType, timeout: 120000, validateStatus: () => true, maxContentLength: Infinity });
  store(res);
  return res;
}
function upload(p, file, fields = {}) {
  const form = new FormData();
  form.append('file', fs.readFileSync(path.join(DATA, file)), { filename: file });
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return req('POST', p, { form });
}
const ok = (r) => r.status >= 200 && r.status < 300;
function log(label, r, extra = '') { console.log(`  ${ok(r) ? '✓' : '✗'} ${label} (${r.status})${extra ? '  ' + extra : ''}`); }

async function main() {
  console.log(`demo-prepare → ${API} company=${COMPANY} user=${EMAIL}`);
  await req('GET', '/api/health');
  let r = await req('POST', '/api/auth/login', { json: { email: EMAIL, password: PASSWORD } });
  log('login', r);
  if (!ok(r)) { console.log('   ', JSON.stringify(r.data).slice(0, 200)); process.exit(1); }

  console.log('\nUploads (so every screen has data):');
  r = await upload('/api/zreports/upload?date=2026-06-05', '050626 ZREPORT JUIN.XLSX'); log('Z-report 2026-06-05', r);
  r = await req('PUT', '/api/zreports/2026-06-05/counted-cash', { json: { countedCash: 190 } }); log('Z counted cash', r);
  r = await req('POST', '/api/zreports/2026-06-05/verify', { json: {} }); log('Z verify', r);
  r = await upload('/api/daybook/upload', 'Feuille de solde Juin 2026.xlsx'); log('daybook June', r, `days=${r.data?.daysParsed ?? ''}`);
  r = await upload('/api/bank-statements/upload', 'BANK JUIN 2026.csv', { bankKey: 'bred' }); log('bank statement', r);
  const bankId = r.data?.id;
  if (bankId) { r = await req('POST', `/api/bank-statements/${bankId}/auto-match`, { json: {} }); log('bank auto-match', r, `matched=${r.data?.statement?.linesMatchedCount ?? ''}`); }
  r = await upload('/api/card-imports/upload?provider=paypal', 'PAYPAL JUIN 2026.CSV'); log('PayPal import', r);
  r = await upload('/api/card-imports/upload?provider=sogecommerce-site', 'Listing_transactions_remisees_juin.xlsx'); log('Sogecommerce txns', r);
  r = await upload('/api/card-imports/upload-remises', 'Listing_remises_juin.xlsx'); log('Sogecommerce remises', r);

  // Payments matched to REAL SAP invoices, LEFT UNPUSHED (live push in the UI).
  console.log('\nPayments matched to real SAP invoices (left unpushed for live demo):');
  const jsonPath = path.join(DATA, 'sap-invoices.json');
  let pushable = 0;
  if (fs.existsSync(jsonPath)) {
    const targets = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    for (const t of targets) {
      const payload = { date: t.date, cardCode: t.cardCode, method: t.method, amount: t.amount };
      if (t.method === 'Cheque') payload.cheque = { chequeNumber: '9900001', bankCode: '', payerName: t.cardCode, chequeDate: t.date };
      if (t.method === 'Bank') payload.bank = { transferReference: `VIR-${t.docEntry}`, bankAccount: '512000' };
      if (['CB-Site', 'CB-Phone', 'PayPal'].includes(t.method)) payload.card = { transactionId: `TX-${t.docEntry}` };
      let pr = await req('POST', '/api/payments', { json: payload });
      if (!ok(pr)) { log(`payment ${t.method}`, pr); continue; }
      const id = pr.data?.id || pr.data?._id;
      const mr = await req('PUT', `/api/payments/${id}/match`, { json: { invoiceDocEntry: t.docEntry, matchedVia: 'manual' } });
      log(`${t.method} ${t.amount} → SAP invoice ${t.docEntry} [matched]`, mr);
      if (ok(mr)) pushable++;
    }
  } else {
    console.log('   (no sap-invoices.json — run seed-sap-june2026.js first for live-push payments)');
  }

  // Daybook Excel export artifact.
  console.log('\nExports:');
  if (!fs.existsSync(EXPORT_DIR)) fs.mkdirSync(EXPORT_DIR, { recursive: true });
  r = await req('GET', '/api/daybook/months/2026/6/export', { responseType: 'arraybuffer' });
  if (ok(r)) {
    const out = path.join(EXPORT_DIR, 'Feuille de solde Juin 2026 — export.xlsx');
    fs.writeFileSync(out, Buffer.from(r.data));
    log('daybook export', r, `→ ${path.relative(path.resolve(__dirname, '../..'), out)}`);
  } else { log('daybook export', r); }

  console.log(`\n✅ Demo data ready. ${pushable} payment(s) matched to real SAP invoices are waiting for a live "Push to SAP" in the Payments screen.`);
}
main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
