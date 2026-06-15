/**
 * Shared, single-source-of-truth data for the CLIENT demo (June 6-10, 2026).
 * Both gen-client-june.js (writes upload files) and seed-sap-client.js (creates
 * SAP invoices + bank mirror) read this so files and backing data always agree.
 *
 * Design for a clean, no-dead-ends client demo:
 *  - PUSH_INVOICES: real SAP invoices you create before the meeting and pay LIVE
 *    (one per method). Amounts chosen so SAP's VAT-inclusive DocTotal == `total`.
 *  - BANK_MIRROR: "payments already settled in SAP" — the expected side of bank
 *    verification (cannot be uploaded; seeded into the payments cache).
 *  - The daybook uses NON-PAYÉ deliveries only, so uploading it creates zero
 *    payment drafts (nothing dangles).
 *
 * All customers are real BPs in MSF_HALAL_TEST.
 */

// VAT group C3 in this tenant = 5.5%. lineTotal * 1.055 == DocTotal.
const VAT = 1.055;
const lineTotalFor = (docTotal) => Math.round((docTotal / VAT) * 100) / 100;

// Single push day so only ONE date needs a GBP exchange rate in SAP.
const PUSH_DATE = '2026-06-10';

// Live-push targets — you enter a payment for each during the demo and push it.
const PUSH_INVOICES = [
  { method: 'Cheque',  cardCode: 'C2622', cardName: 'CHICKEN ASIA', total: 1450.0 },
  { method: 'Bank',    cardCode: 'C6819', cardName: 'UGUR SARL',    total: 845.0 },
  { method: 'Cash',    cardCode: 'C2422', cardName: 'YUNUS',        total: 396.4 },
  { method: 'CB-Site', cardCode: 'C2983', cardName: 'FIRAT',        total: 720.0 },
  { method: 'PayPal',  cardCode: 'C2336', cardName: 'O.F.C',        total: 188.2 },
];

// Bank verification — settled payments (mirror) vs the uploaded bank statement.
// 5 match a bank line, 1 (O.F.C bank 220.00) has NO bank line -> "missing in bank".
const BANK_MIRROR = [
  { date: '2026-06-08', method: 'cheque', cardCode: 'C2622', cardName: 'CHICKEN ASIA', total: 1450.0 },
  { date: '2026-06-08', method: 'bank',   cardCode: 'C6819', cardName: 'UGUR SARL',    total: 512.3 },
  { date: '2026-06-09', method: 'card',   cardCode: 'C2983', cardName: 'FIRAT',        total: 1075.6 },
  { date: '2026-06-09', method: 'cash',   cardCode: 'C2422', cardName: 'YUNUS',        total: 380.0 },
  { date: '2026-06-10', method: 'card',   cardCode: 'C3050', cardName: 'KEBAB HOUSE',  total: 640.2 },
  { date: '2026-06-09', method: 'bank',   cardCode: 'C2336', cardName: 'O.F.C',        total: 220.0 },
];

// Bank statement deposit lines (what the bank actually shows). Matches the mirror
// daily method totals, plus one unexplained credit and one fee to tag.
const BANK_LINES = [
  { date: '08/06/2026', label: 'REMISE CHEQUE 9900456 CHICKEN ASIA', amount: 1450.0 },
  { date: '08/06/2026', label: 'VIREMENT RECU UGUR SARL',            amount: 512.3 },
  { date: '09/06/2026', label: 'REMISE CB SOGECOMMERCE',             amount: 1075.6 },
  { date: '09/06/2026', label: 'REMISE ESPECES NO00051',             amount: 380.0 },
  { date: '10/06/2026', label: 'REMISE CB',                          amount: 640.2 },
  { date: '10/06/2026', label: 'VIREMENT RECU SCI HORIZON',          amount: 500.0 },  // unexplained
  { date: '10/06/2026', label: 'COMMISSION CARTE BANCAIRE',          amount: -14.9 },  // fee to tag
];

// Daybook deliveries (NON-PAYÉ — awaiting payment, so no drafts are created).
const DAYBOOK = {
  6:  [['C2622', 'CHICKEN ASIA', 980.0, 'BL 6 juin'], ['C3050', 'KEBAB HOUSE', 455.8, 'BL 6 juin']],
  7:  [['C6819', 'UGUR SARL', 712.4, 'BL 7 juin']],
  8:  [['C2983', 'FIRAT', 324.5, 'BL 8 juin'], ['C2422', 'YUNUS', 540.0, 'BL 8 juin']],
  9:  [['C2336', 'O.F.C', 271.4, 'BL 9 juin']],
  10: [['C2622', 'CHICKEN ASIA', 1320.0, 'BL 10 juin'], ['C6819', 'UGUR SARL', 845.9, 'BL 10 juin']],
};

// Z-report (POS day 2026-06-10): counter sales + a couple of account receipts.
const ZREPORT_DATE = '2026-06-10';

module.exports = { VAT, lineTotalFor, PUSH_DATE, PUSH_INVOICES, BANK_MIRROR, BANK_LINES, DAYBOOK, ZREPORT_DATE };
