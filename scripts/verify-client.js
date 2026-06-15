/* eslint-disable no-console */
/**
 * Dry-run / pre-meeting sanity check for the CLIENT demo. Uploads every June
 * 6-10 file through the live API exactly as you will during the meeting, and
 * asserts the results — including that the daybook creates ZERO dangling
 * payment drafts. Does NOT push to SAP (leaves the staged invoices open for the
 * live demo).
 *
 *   npm run demo:client      # reset + stage SAP invoices + bank mirror
 *   npm run verify:client     # this — confirm every upload is clean
 *
 * NOTE: this populates the DB. Run `npm run demo:client` again afterwards to
 * return to the clean pre-meeting state before the real demo.
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
const DATA = path.resolve(__dirname, '../data/client-june2026');
const CSRF_COOKIE = process.env.CSRF_COOKIE_NAME || 'hff_csrf';

const cookies = {};
const cookieHeader = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
function store(res) { const sc = res.headers?.['set-cookie']; if (!sc) return; for (const l of sc) { const p = l.split(';')[0]; const i = p.indexOf('='); if (i > 0) cookies[p.slice(0, i).trim()] = p.slice(i + 1).trim(); } }
async function req(method, p, { json, form } = {}) {
  const h = {};
  if (Object.keys(cookies).length) h.Cookie = cookieHeader();
  if (p.startsWith('/api') && p !== '/api/health') h['X-Company'] = COMPANY;
  if (!['GET', 'HEAD'].includes(method) && cookies[CSRF_COOKIE]) h['X-CSRF-Token'] = cookies[CSRF_COOKIE];
  if (form) Object.assign(h, form.getHeaders()); else if (json !== undefined) h['Content-Type'] = 'application/json';
  const res = await axios.request({ url: `${API}${p}`, method, headers: h, data: form || json, timeout: 120000, validateStatus: () => true, maxContentLength: Infinity });
  store(res); return res;
}
function upload(p, file, fields = {}) {
  const form = new FormData();
  form.append('file', fs.readFileSync(path.join(DATA, file)), { filename: file });
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return req('POST', p, { form });
}
const results = [];
const near = (a, b, e = 0.011) => Math.abs(Number(a) - Number(b)) <= e;
function check(name, cond, detail = '') { results.push({ name, ok: !!cond, detail }); console.log(`  ${cond ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`); return cond; }
const body = (r) => (typeof r.data === 'object' ? JSON.stringify(r.data) : String(r.data)).slice(0, 250);

async function main() {
  console.log(`verify-client → ${API} company=${COMPANY}`);
  await req('GET', '/api/health');
  let r = await req('POST', '/api/auth/login', { json: { email: EMAIL, password: PASSWORD } });
  if (!check('login', r.status === 200, `status=${r.status}`)) return finish();

  console.log('\nZ-report (2026-06-10):');
  r = await upload('/api/zreports/upload?date=2026-06-10', '100626 ZREPORT JUIN.XLSX');
  check('upload Z-report', r.status === 201, `status=${r.status}`);
  r = await req('GET', '/api/zreports/2026-06-10');
  check('Z net discrepancy -4.30', near(r.data?.netDiscrepancy, -4.3), `got ${r.data?.netDiscrepancy}`);

  console.log('\nDaybook (non-payé — must create NO payment drafts):');
  r = await upload('/api/daybook/upload', 'Feuille de solde Juin 2026.xlsx');
  check('upload daybook (5 days)', r.status === 201 && r.data?.daysParsed === 5, `days=${r.data?.daysParsed}`);
  r = await req('GET', '/api/payments?limit=1');
  check('NO dangling payment drafts created', (r.data?.total ?? 0) === 0, `payment_entries total=${r.data?.total}`);

  console.log('\nBank reconciliation:');
  r = await upload('/api/bank-statements/upload', 'BANK JUIN 2026.csv', { bankKey: 'bred' });
  check('upload bank (7 lines)', r.status === 201 && r.data?.linesParsed === 7, `lines=${r.data?.linesParsed}`);
  const bankId = r.data?.id;
  if (bankId) {
    r = await req('POST', `/api/bank-statements/${bankId}/auto-match`, { json: {} });
    const st = r.data?.statement || {};
    const mr = st.methodReconciliation || [];
    check('bank: 5 matched', st.linesMatchedCount === 5, `matched=${st.linesMatchedCount}`);
    check('bank: a "missing in bank"', mr.some((m) => /missing/i.test(m.status)), `statuses=${mr.map((m) => m.status).join(',')}`);
  }

  console.log('\nCard imports:');
  r = await upload('/api/card-imports/upload?provider=paypal', 'PAYPAL JUIN 2026.CSV');
  check('PayPal rows=2', r.status === 201 && r.data?.rows === 2, `rows=${r.data?.rows}`);
  r = await upload('/api/card-imports/upload?provider=sogecommerce-site', 'Listing_transactions_remisees_juin.xlsx');
  check('Sogecommerce rows=2 (Rejeté skipped)', r.status === 201 && r.data?.rows === 2, `rows=${r.data?.rows}`);
  r = await upload('/api/card-imports/upload-remises', 'Listing_remises_juin.xlsx');
  check('Sogecommerce remises', r.status === 201, `status=${r.status}`);

  console.log('\nLive-push invoices staged & open in SAP cache:');
  const jsonPath = path.join(DATA, 'client-sap-invoices.json');
  if (fs.existsSync(jsonPath)) {
    const invs = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    check('5 push invoices staged', invs.length === 5, `count=${invs.length}`);
    for (const inv of invs) {
      r = await req('GET', `/api/invoices/${inv.docEntry}`);
      const open = r.status === 200 && (r.data?.DocumentStatus === 'O' || r.data?.DocumentStatus === 'bost_Open') && (r.data?.PaidToDate ?? 0) === 0;
      check(`  ${inv.method} ${inv.cardCode} ${inv.amount} (inv ${inv.docEntry}) open`, open, open ? '' : body(r));
    }
  } else {
    check('client-sap-invoices.json present', false, 'run: npm run demo:client');
  }
  finish();
}
function finish() {
  const ok = results.filter((x) => x.ok).length;
  console.log(`\n${'='.repeat(56)}\n  ${ok}/${results.length} checks passed\n${'='.repeat(56)}`);
  if (ok !== results.length) console.log('  (re-run `npm run demo:client` to reset to clean pre-meeting state)');
  process.exit(ok === results.length ? 0 : 1);
}
main().catch((e) => { console.error('FATAL', e.stack || e.message); process.exit(2); });
