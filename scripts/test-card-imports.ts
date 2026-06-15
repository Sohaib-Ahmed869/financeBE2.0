import fs from 'fs';
import path from 'path';
import {
  parseSogecommerceTransactions,
  parseSogecommerceRemises,
  parsePaypalCsv,
} from '../src/modules/cardImports/cardImports.parser';

const d = path.resolve(__dirname, '../data');

const tx = parseSogecommerceTransactions(
  fs.readFileSync(path.join(d, 'Listing_transactions_remisees.xls')),
);
console.log('=== Sogecommerce transactions ===');
console.log('provider:', tx.provider, 'rows:', tx.rows.length, 'period:', tx.periodStart, '→', tx.periodEnd, 'total:', tx.totalAmount);
console.log('warnings:', tx.warnings);
console.log('first 3:', tx.rows.slice(0, 3).map(r => ({ txId: r.transactionId, date: r.date, amount: r.amount, payerName: r.payerName, maskedPan: r.maskedPan, remiseNumber: r.remiseNumber })));

const rem = parseSogecommerceRemises(
  fs.readFileSync(path.join(d, 'Listing_remises.xls')),
);
console.log('\n=== Sogecommerce remises ===');
console.log('rows:', rem.rows.length, 'period:', rem.periodStart, '→', rem.periodEnd, 'total:', rem.totalAmount);
console.log('first 3:', rem.rows.slice(0, 3));

const pp = parsePaypalCsv(fs.readFileSync(path.join(d, 'PAYPAL FEB.CSV')));
console.log('\n=== PayPal ===');
console.log('rows:', pp.rows.length, 'period:', pp.periodStart, '→', pp.periodEnd, 'total:', pp.totalAmount);
console.log('first 3:', pp.rows.slice(0, 3).map(r => ({ txId: r.transactionId, date: r.date, amount: r.amount, payerName: r.payerName, payerEmail: r.payerEmail })));
