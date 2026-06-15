/* Validates the generated June 2026 import files against the REAL parsers. */
import fs from 'fs';
import path from 'path';
import { parseZReport } from '../src/modules/zreports/zreports.parser';
import { parseDaybookWorkbook } from '../src/modules/daybook/daybook.parser';
import { parseBankStatement } from '../src/modules/bankStatements/bankStatements.parser';
import {
  parsePaypalCsv,
  parseSogecommerceTransactions,
  parseSogecommerceRemises,
} from '../src/modules/cardImports/cardImports.parser';

const D = path.resolve(__dirname, '../data/june2026');
const read = (f: string) => fs.readFileSync(path.join(D, f));

function hr(t: string) { console.log('\n========== ' + t + ' =========='); }

try {
  hr('Z-REPORT');
  const z = parseZReport(read('050626 ZREPORT JUIN.XLSX'));
  console.log({ date: z.date, totals: z.totals, countedCash: z.countedCash, float: z.float,
    expenses: z.expenses, rows: z.rows.length, accountReceipts: z.accountReceipts,
    drawerAudit: z.drawerAudit, drawerCounted: z.drawerCounted, drawerDiscrepancy: z.drawerDiscrepancy,
    netDiscrepancy: z.netDiscrepancy });
} catch (e) { console.error('ZREPORT FAILED:', e); }

try {
  hr('DAYBOOK');
  const wb = parseDaybookWorkbook(read('Feuille de solde Juin 2026.xlsx'), 'Feuille de solde Juin 2026.xlsx');
  console.log('month/year:', (wb as any).month, (wb as any).year, 'days:', (wb as any).days?.length);
  for (const d of (wb as any).days || []) {
    console.log(' day', d.dayOfMonth, 'totals=', d.totals, 'livraisons=', (d.livraisons || d.deliveries || []).length);
  }
} catch (e) { console.error('DAYBOOK FAILED:', e); }

try {
  hr('BANK');
  const b = parseBankStatement({ originalname: 'BANK JUIN 2026.csv', buffer: read('BANK JUIN 2026.csv') });
  console.log({ delimiter: (b as any).detectedDelimiter, lines: b.lines.length, warnings: b.warnings });
  for (const l of b.lines) console.log('  ', l.operationDate, l.amount, '|', l.description, '| env:', l.envelopeNumber);
} catch (e) { console.error('BANK FAILED:', e); }

try {
  hr('CARD: PayPal');
  const c = parsePaypalCsv(read('PAYPAL JUIN 2026.CSV'));
  console.log('rows:', c.rows.length, 'warnings:', c.warnings);
  for (const r of c.rows) console.log('  ', JSON.stringify(r).slice(0, 200));
} catch (e) { console.error('CARD PAYPAL FAILED:', e); }

try {
  hr('CARD: Sogecommerce transactions');
  const c = parseSogecommerceTransactions(read('Listing_transactions_remisees_juin.xlsx'), { defaultChannel: 'site' });
  console.log('rows:', c.rows.length, 'warnings:', c.warnings);
  for (const r of c.rows) console.log('  ', JSON.stringify(r).slice(0, 220));
} catch (e) { console.error('CARD SOGE TX FAILED:', e); }

try {
  hr('CARD: Sogecommerce remises');
  const c = parseSogecommerceRemises(read('Listing_remises_juin.xlsx'));
  console.log('rows:', c.rows.length, 'warnings:', c.warnings, 'period:', c.periodStart, c.periodEnd);
  for (const r of c.rows) console.log('  ', JSON.stringify(r).slice(0, 200));
} catch (e) { console.error('CARD SOGE REMISES FAILED:', e); }
