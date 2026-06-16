import fs from 'node:fs';
import path from 'node:path';
import { parseZReport } from '../src/modules/zreports/zreports.parser';
import { parseBankStatement } from '../src/modules/bankStatements/bankStatements.parser';
import {
  parsePaypalCsv,
  parseSogecommerceTransactions,
  parseSogecommerceRemises,
} from '../src/modules/cardImports/cardImports.parser';

const OUT = path.resolve('E:/HalalFoodsFinancev2/test-data');
const read = (f: string) => fs.readFileSync(path.join(OUT, f));

console.log('================ Z-REPORT ================');
const z = parseZReport(read('01_zreport_2026-06-15.xlsx'));
console.log('date:', z.date, '| totals:', z.totals);
console.log('float:', z.float, '| expenses:', z.expenses, '| countedCash:', z.countedCash);
console.log('drawerAudit:', z.drawerAudit, '| drawerCounted:', z.drawerCounted);
console.log('netDiscrepancy:', z.netDiscrepancy, '| accountReceipts:', z.accountReceipts);
console.log('rows:', z.rows.length, '| warnings:', z.warnings);

console.log('\n================ BANK STATEMENT ================');
const b = parseBankStatement({ originalname: '02_bank_statement_bred_2026-06.csv', buffer: read('02_bank_statement_bred_2026-06.csv') });
console.log('delimiter:', b.detectedDelimiter, '| lines:', b.lines.length, '| warnings:', b.warnings);
for (const l of b.lines) console.log(` ${l.operationDate} ${l.direction.padEnd(6)} ${String(l.amount).padStart(8)} env=${l.envelopeNumber ?? '-'} | ${l.description}`);

console.log('\n================ PAYPAL ================');
const pp = parsePaypalCsv(read('03_paypal_2026-06.csv'));
console.log('rows:', pp.rows.length, '| total:', pp.totalAmount, '| period:', pp.periodStart, '→', pp.periodEnd, '| warnings:', pp.warnings);
for (const r of pp.rows) console.log(` ${r.date} ${r.method.padEnd(12)} ${String(r.amount).padStart(7)} ${r.payerName} <${r.payerEmail}> tx=${r.transactionId}`);

console.log('\n================ SOGECOMMERCE TRANSACTIONS ================');
const st = parseSogecommerceTransactions(read('04_sogecommerce_transactions_2026-06.xlsx'));
console.log('provider:', st.provider, '| rows:', st.rows.length, '| total:', st.totalAmount, '| warnings:', st.warnings);
for (const r of st.rows) console.log(` ${r.date} ${String(r.amount).padStart(7)} ${r.payerName} pan=${r.maskedPan} remise=${r.remiseNumber}`);

console.log('\n================ SOGECOMMERCE REMISES ================');
const sr = parseSogecommerceRemises(read('05_sogecommerce_remises_2026-06.xlsx'));
console.log('rows:', sr.rows.length, '| total:', sr.totalAmount, '| warnings:', sr.warnings);
for (const r of sr.rows) console.log(` ${r.date} ${String(r.amount).padStart(7)} ${r.remiseNumber} ${r.network} ${r.status}`);
