import fs from 'fs';
import path from 'path';
import { parseZReport } from '../src/modules/zreports/zreports.parser';

const file = path.resolve(__dirname, '../data/140526 EXCEL.XLSX');
const buf = fs.readFileSync(file);
const r = parseZReport(buf);

console.log('=== Z-report parser smoke test ===');
console.log('file:', file);
console.log('date:', r.date);
console.log('warnings:', r.warnings);
console.log('totals:', r.totals);
console.log('drawerAudit:', r.drawerAudit);
console.log('drawerCounted:', r.drawerCounted);
console.log('drawerDiscrepancy:', r.drawerDiscrepancy);
console.log('netDiscrepancy:', r.netDiscrepancy);
console.log('rows count:', r.rows.length);
console.log('accountReceipts count:', r.accountReceipts.length);

const byMethod = { cash: 0, card: 0, cheque: 0, other: 0 } as Record<string, number>;
for (const x of r.rows) byMethod[x.method] += x.amount;
console.log('row roll-up by method:', byMethod);

console.log('\nfirst 3 rows:');
for (const x of r.rows.slice(0, 3)) console.log('  ', x);

console.log('\nfirst 3 accountReceipts:');
for (const x of r.accountReceipts.slice(0, 3)) console.log('  ', x);
