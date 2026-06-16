import * as XLSX from 'xlsx';
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('E:/HalalFoodsFinancev2/test-data');
fs.mkdirSync(OUT, { recursive: true });

function writeSheet(file, aoa, sheetName = 'Sheet1') {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, path.join(OUT, file));
  console.log('wrote', file);
}
function writeText(file, text, bom = false) {
  fs.writeFileSync(path.join(OUT, file), (bom ? '﻿' : '') + text, 'utf8');
  console.log('wrote', file);
}

/* ───────────────────────── 1. Z-REPORT (XLSX, new till format) ───────────────────────── */
// Cols: CARDCODE CUSTOMER DATE RECEIPT OPERATOR TOTAL CASH CHANGE ACCOUNT CCARD CHEQUE
const z = [
  ['MSF HALAL — Z REPORT (Paris)', '', 'From Date: 15/06/2026', '', '', '', '', '', '', '', ''],
  ['CARDCODE', 'CUSTOMER', 'DATE', 'RECEIPT', 'OPERATOR', 'TOTAL', 'CASH', 'CHANGE', 'ACCOUNT', 'CCARD', 'CHEQUE'],
  ['C1001', 'Cash Customer A', '15/06/2026', 'R001', 'OP1', '50.00', '60.00', '-10.00', '0', '0', '0'],
  ['C1002', 'Card Customer B', '15/06/2026', 'R002', 'OP1', '120.00', '0', '0', '0', '120.00', '0'],
  ['C1003', 'Cheque Customer C', '15/06/2026', 'R003', 'OP1', '200.00', '0', '0', '0', '0', '200.00'],
  ['C1004', 'Account Customer D', '15/06/2026', 'R004', 'OP1', '80.00', '0', '0', '80.00', '0', '0'],
  ['C1005', 'Mixed Customer E', '15/06/2026', 'R005', 'OP1', '100.00', '50.00', '0', '0', '50.00', '0'],
  ['ARINV TOTALS', '', '', '', '', '550.00', '110.00', '-10.00', '80.00', '170.00', '200.00'],
  ['', 'Opening Float', '', '', '', '', '150.00', '0', '0', '0', '0'],
  ['', 'Essence (carburant)', '', '', '', '', '-20.00', '0', '0', '0', '0'],
  ['TOTALS', '', '', '', '', '', '100.00', '0', '0', '170.00', '200.00'],
  ['Z Summary'],
  ['Cash'],
  ['In Audit : 230.00'],
  ['In Drawer : 225.00'],
  ['Discrepancy : -5.00'],
  ['Card'],
  ['In Audit : 170.00'],
  ['In Drawer : 170.00'],
  ['Discrepancy : 0.00'],
  ['Cheque'],
  ['In Audit : 200.00'],
  ['In Drawer : 200.00'],
  ['Discrepancy : 0.00'],
  ['Net Discrepancy : -5.00'],
];
writeSheet('01_zreport_2026-06-15.xlsx', z, 'Z Report');

/* ───────────────────────── 2. BANK STATEMENT (CSV, BRED-style, ; delimited) ───────────── */
const bank = [
  'Date;Libellé;Référence;Montant;Solde',
  '15/06/2026;VERSEMENT ESPECES NO0042;ESP-0615;225,00;10225,00',
  '16/06/2026;REMISE CHEQUE(S);CHQ-0616;200,00;10425,00',
  '16/06/2026;REMISE CARTE BANCAIRE SOGECOMMERCE;CB-0616;170,00;10595,00',
  '16/06/2026;VIREMENT PAYPAL EUROPE SARL;PP-0616;95,40;10690,40',
  '16/06/2026;PRELEVEMENT EDF FACTURE ELECTRICITE;EDF-0616;-120,00;10570,40',
  '17/06/2026;VIREMENT RECU JEAN DUPONT;VIR-0617;33,00;10603,40',
].join('\r\n');
writeText('02_bank_statement_bred_2026-06.csv', bank);

/* ───────────────────────── 3. PAYPAL (CSV, comma delimited, quoted, BOM) ────────────────── */
const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
const ppRows = [
  ['Date', 'Nom', 'Type', 'État', 'Avant commission', 'Commission', 'Net', 'Numéro de transaction', "De l'adresse email", "À l'adresse email"],
  ['15/06/2026', 'Marie Martin', 'Paiement DCC', 'Terminé', '45.00', '-2.00', '43.00', 'TX-PP-1001', 'marie.martin@example.com', 'shop@halalfood.fr'],
  ['15/06/2026', 'Ahmed Benali', 'Paiement Express Checkout', 'Terminé', '60.00', '-2.50', '57.50', 'TX-PP-1002', 'ahmed.benali@example.com', 'shop@halalfood.fr'],
  ['15/06/2026', 'PayPal', 'Paiement standard', 'Terminé', '-2.00', '0.00', '-2.00', 'TX-PP-FEE1', '', ''],
  ['16/06/2026', 'Virement bancaire', 'Virement standard', 'Terminé', '0.00', '0.00', '-95.40', 'TX-PP-SWEEP', '', ''],
];
writeText('03_paypal_2026-06.csv', ppRows.map((r) => r.map(q).join(',')).join('\r\n'), true);

/* ───────────────────────── 4. SOGECOMMERCE per-transaction (XLSX) ───────────────────────── */
const soge = [
  ['Transaction', 'Commande', 'Type', 'Date du paiement', 'Statut', 'Montant du paiement', 'Date remise', 'N° remise', 'Moyen de paiement', 'Numéro de carte', 'E-mail acheteur'],
  ['TX-CB-5001', 'Sophie Durand', 'Débit', '15/06/2026', 'Accepté', '75.00', '16/06/2026', 'REM-2026-0616', 'CB', '513778XXXXXX3558', 'sophie.durand@example.com'],
  ['TX-CB-5002', 'Karim Hadid', 'Débit', '15/06/2026', 'Accepté', '95.00', '16/06/2026', 'REM-2026-0616', 'CB', '497010XXXXXX1234', 'karim.hadid@example.com'],
];
writeSheet('04_sogecommerce_transactions_2026-06.xlsx', soge, 'Transactions');

/* ───────────────────────── 5. SOGECOMMERCE daily remises (XLSX) ─────────────────────────── */
const remises = [
  ['N° remise', 'Date de remise', 'Réseau', 'Débit', 'Crédit', 'Statut'],
  ['REM-2026-0616', '16/06/2026', 'CB', '170.00', '0', 'Traité'],
];
writeSheet('05_sogecommerce_remises_2026-06.xlsx', remises, 'Remises');

console.log('\nAll test files written to', OUT);
