/**
 * Seeds coherent JUNE 2026 base data into the Paris tenant DB so the whole
 * pipeline can run WITHOUT a live SAP. Invoices/customers normally arrive via
 * SAP sync; this script inserts them (plus delivery notes and the SAP payment
 * mirror used by bank reconciliation) directly into Mongo.
 *
 *   npx ts-node scripts/seed-june2026.ts          # seed Paris
 *   TENANT_URI=mongodb://... npx ts-node scripts/seed-june2026.ts
 *
 * Idempotent: upserts by natural key (CardCode / DocEntry). Re-run safely.
 *
 * The card codes / amounts / dates here line up with the files produced by
 * scripts/gen-june2026-imports.js so imports reconcile against this data.
 */
import path from 'path';
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { CustomerSchema } from '../src/models/tenant/Customer';
import { InvoiceSchema } from '../src/models/tenant/Invoice';
import { DeliveryNoteSchema } from '../src/models/tenant/DeliveryNote';
import { PaymentSchema } from '../src/models/tenant/Payment';

const TENANT_URI = process.env.TENANT_URI || process.env.TENANT_PARIS_MONGO_URI;

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const line = (total: number, desc = 'Marchandise') => [
  { LineNum: 0, ItemCode: 'STD', ItemDescription: desc, Quantity: 1, Price: total, LineTotal: total, Currency: 'EUR' },
];

/* ----------------------------- Customers ----------------------------- */
const CUSTOMERS = [
  { CardCode: 'C9999', CardName: 'vente comptoir' },
  { CardCode: 'C2983', CardName: 'FIRAT', EmailAddress: 'firat-paris@example.com' },
  { CardCode: 'C2422', CardName: 'YUNUS' },
  { CardCode: 'C2622', CardName: 'CHICKEN ASIA', EmailAddress: 'compta@chickenasia.fr' },
  { CardCode: 'C4494', CardName: 'MCV DAUMESNIL' },
  { CardCode: 'C2336', CardName: 'O.F.C' },
  { CardCode: 'C6819', CardName: 'UGUR SARL', EmailAddress: 'contact@ugur.fr' },
  { CardCode: 'C3050', CardName: 'KEBAB HOUSE', EmailAddress: 'compta@kebabhouse.fr' },
];

/* ------------------------------ Invoices ----------------------------- */
// 10 open invoices. Each is a reconcile target for one payment method.
const INVOICES = [
  { DocEntry: 5001, DocNum: 12001, CardCode: 'C2622', CardName: 'CHICKEN ASIA', DocDate: '2026-06-02', DocTotal: 1240.5, note: 'pay by Cheque' },
  { DocEntry: 5002, DocNum: 12002, CardCode: 'C4494', CardName: 'MCV DAUMESNIL', DocDate: '2026-06-02', DocTotal: 284.64, note: 'pay by Bank transfer' },
  { DocEntry: 5003, DocNum: 12003, CardCode: 'C6819', CardName: 'UGUR SARL', DocDate: '2026-06-03', DocTotal: 980.0, note: 'pay by CB-Site (Sogecommerce)' },
  { DocEntry: 5004, DocNum: 12004, CardCode: 'C2983', CardName: 'FIRAT', DocDate: '2026-06-03', DocTotal: 156.3, note: 'pay by PayPal' },
  { DocEntry: 5005, DocNum: 12005, CardCode: 'C2422', CardName: 'YUNUS', DocDate: '2026-06-04', DocTotal: 432.75, note: 'pay by Cash' },
  { DocEntry: 5006, DocNum: 12006, CardCode: 'C3050', CardName: 'KEBAB HOUSE', DocDate: '2026-06-04', DocTotal: 610.2, note: 'pay by CB-Phone' },
  { DocEntry: 5007, DocNum: 12007, CardCode: 'C2336', CardName: 'O.F.C', DocDate: '2026-06-05', DocTotal: 271.4, note: 'POS / Z-report cheque receipt' },
  { DocEntry: 5008, DocNum: 12008, CardCode: 'C2622', CardName: 'CHICKEN ASIA', DocDate: '2026-06-05', DocTotal: 540.0, note: 'mark on Account (unpaid receivable)' },
  { DocEntry: 5009, DocNum: 12009, CardCode: 'C4494', CardName: 'MCV DAUMESNIL', DocDate: '2026-06-08', DocTotal: 825.9, note: 'open' },
  { DocEntry: 5010, DocNum: 12010, CardCode: 'C6819', CardName: 'UGUR SARL', DocDate: '2026-06-09', DocTotal: 1110.0, note: 'open receivable' },
];

/* --------------------------- Delivery Notes -------------------------- */
// Open DNs for the morning "convert to invoice" screen. (The convert ACTION
// itself posts to SAP, so it needs a live SAP; listing/selecting works offline.)
const DELIVERY_NOTES = [
  { DocEntry: 4001, DocNum: 8001, CardCode: 'C3050', CardName: 'KEBAB HOUSE', DocDate: '2026-06-12', DocTotal: 712.4 },
  { DocEntry: 4002, DocNum: 8002, CardCode: 'C2622', CardName: 'CHICKEN ASIA', DocDate: '2026-06-12', DocTotal: 1320.0 },
  { DocEntry: 4003, DocNum: 8003, CardCode: 'C6819', CardName: 'UGUR SARL', DocDate: '2026-06-13', DocTotal: 455.8 },
];

/* ----------------- SAP payment mirror (for bank recon) --------------- */
// These represent payments ALREADY in SAP. Bank reconciliation aggregates them
// into daily totals per method and verifies them against "BANK JUIN 2026.csv".
//   02/06 cheque 1240.50 | 02/06 bank 284.64
//   03/06 card 1136.30 (980 + 156.30) | 03/06 bank 175.00 (NO bank line -> missing)
//   04/06 cash 432.75 | 04/06 card 610.20
const SAP_PAYMENTS = [
  { DocEntry: 9001, DocNum: 30001, CardCode: 'C2622', CardName: 'CHICKEN ASIA', DocDate: '2026-06-02', DocTotal: 1240.5, method: 'cheque' },
  { DocEntry: 9002, DocNum: 30002, CardCode: 'C4494', CardName: 'MCV DAUMESNIL', DocDate: '2026-06-02', DocTotal: 284.64, method: 'bank' },
  { DocEntry: 9003, DocNum: 30003, CardCode: 'C6819', CardName: 'UGUR SARL', DocDate: '2026-06-03', DocTotal: 980.0, method: 'card' },
  { DocEntry: 9004, DocNum: 30004, CardCode: 'C2983', CardName: 'FIRAT', DocDate: '2026-06-03', DocTotal: 156.3, method: 'card' },
  { DocEntry: 9005, DocNum: 30005, CardCode: 'C2336', CardName: 'O.F.C', DocDate: '2026-06-03', DocTotal: 175.0, method: 'bank' },
  { DocEntry: 9006, DocNum: 30006, CardCode: 'C2422', CardName: 'YUNUS', DocDate: '2026-06-04', DocTotal: 432.75, method: 'cash' },
  { DocEntry: 9007, DocNum: 30007, CardCode: 'C3050', CardName: 'KEBAB HOUSE', DocDate: '2026-06-04', DocTotal: 610.2, method: 'card' },
];

function paymentMethodFields(m: string, p: { DocTotal: number; DocDate: string; CardCode: string }) {
  switch (m) {
    case 'cheque':
      return { PaymentChecks: [{ CheckSum: p.DocTotal, DueDate: d(p.DocDate), BankCode: '30002', AccountNum: 'FR7630002...', CheckNumber: 8801234 }] };
    case 'card':
      return { PaymentCreditCards: [{ CreditSum: p.DocTotal, CreditCard: 1, CreditAcct: '512300', CardValidUntil: d('2027-01-01') }] };
    case 'bank':
      return { TransferSum: p.DocTotal, TransferAccount: '512000', TransferDate: d(p.DocDate), TransferReference: `VIR-${p.CardCode}-${p.DocDate}` };
    case 'cash':
    default:
      return { CashSum: p.DocTotal, CashAccount: '531000' };
  }
}

async function main() {
  if (!TENANT_URI) throw new Error('Set TENANT_PARIS_MONGO_URI in be/.env (or TENANT_URI env var)');
  const conn = await mongoose.createConnection(TENANT_URI).asPromise();
  console.log('connected to tenant DB:', conn.name);

  const Customer = conn.model('Customer', CustomerSchema, 'customers');
  const Invoice = conn.model('Invoice', InvoiceSchema, 'invoices');
  const DeliveryNote = conn.model('DeliveryNote', DeliveryNoteSchema, 'delivery_notes');
  const Payment = conn.model('Payment', PaymentSchema, 'payments');

  for (const c of CUSTOMERS) {
    await Customer.updateOne(
      { CardCode: c.CardCode },
      { $set: { ...c, CardType: 'cCustomer', Currency: 'EUR', Frozen: 'tNO', Valid: 'tYES', lastSyncedAt: new Date() } },
      { upsert: true },
    );
  }
  console.log(`customers upserted: ${CUSTOMERS.length}`);

  for (const inv of INVOICES) {
    await Invoice.updateOne(
      { DocEntry: inv.DocEntry },
      {
        $set: {
          DocEntry: inv.DocEntry, DocNum: inv.DocNum, DocType: 'dDocument_Items',
          CardCode: inv.CardCode, CardName: inv.CardName,
          DocDate: d(inv.DocDate), DocDueDate: d(inv.DocDate),
          DocCurrency: 'EUR', DocTotal: inv.DocTotal, PaidToDate: 0,
          DocumentStatus: 'O', Cancelled: 'tNO',
          Comments: inv.note, DocumentLines: line(inv.DocTotal),
          lastSyncedAt: new Date(),
        },
      },
      { upsert: true },
    );
  }
  console.log(`invoices upserted: ${INVOICES.length} (all open, status 'O')`);

  for (const dn of DELIVERY_NOTES) {
    await DeliveryNote.updateOne(
      { DocEntry: dn.DocEntry },
      {
        $set: {
          DocEntry: dn.DocEntry, DocNum: dn.DocNum, DocType: 'dDocument_Items',
          CardCode: dn.CardCode, CardName: dn.CardName,
          DocDate: d(dn.DocDate), DocDueDate: d(dn.DocDate),
          DocCurrency: 'EUR', DocTotal: dn.DocTotal,
          DocumentStatus: 'O', Cancelled: 'tNO',
          DocumentLines: line(dn.DocTotal), lastSyncedAt: new Date(),
        },
      },
      { upsert: true },
    );
  }
  console.log(`delivery notes upserted: ${DELIVERY_NOTES.length} (all open)`);

  for (const p of SAP_PAYMENTS) {
    await Payment.updateOne(
      { DocEntry: p.DocEntry },
      {
        $set: {
          DocEntry: p.DocEntry, DocNum: p.DocNum, DocType: 'rCustomer',
          CardCode: p.CardCode, CardName: p.CardName,
          DocDate: d(p.DocDate), DocCurrency: 'EUR', DocTotal: p.DocTotal,
          Cancelled: 'tNO', ...paymentMethodFields(p.method, p),
          lastSyncedAt: new Date(),
        },
      },
      { upsert: true },
    );
  }
  console.log(`SAP payment mirror upserted: ${SAP_PAYMENTS.length} (for bank reconciliation)`);

  console.log('\n✅ June 2026 seed complete.');
  await conn.close();
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
