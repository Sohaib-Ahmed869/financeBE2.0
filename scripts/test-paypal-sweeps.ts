import fs from 'fs';
import path from 'path';
import { parsePaypalCsv } from '../src/modules/cardImports/cardImports.parser';

const file = path.resolve(__dirname, '../data/PAYPAL FEB.CSV');
const result = parsePaypalCsv(fs.readFileSync(file));

const customerPayments = result.rows.filter((r) => r.method === 'PayPal');
const sweeps = result.rows.filter((r) => r.method === 'PayPal sweep');
const sweepTotal = sweeps.reduce((acc, r) => acc + r.amount, 0);

console.log('=== PayPal parse summary ===');
console.log('file:', file);
console.log('customerPayments.length:', customerPayments.length);
console.log('sweeps.length:', sweeps.length);
console.log('sweep total amount:', +sweepTotal.toFixed(2));
console.log('first 5 sweeps:', sweeps.slice(0, 5).map((r) => ({
  txId: r.transactionId,
  date: r.date,
  amount: r.amount,
  method: r.method,
})));
console.log('warnings:', result.warnings);
