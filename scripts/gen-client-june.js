/* eslint-disable no-console */
/**
 * Writes the CLIENT demo upload files (June 6-10, 2026) into
 * be/data/client-june2026/. Pure file writer — no DB, no SAP. Run with:
 *
 *   node scripts/gen-client-june.js
 *
 * Files (all uploaded LIVE during the meeting):
 *   - 100626 ZREPORT JUIN.XLSX                 -> /zreports/upload?date=2026-06-10
 *   - Feuille de solde Juin 2026.xlsx          -> /daybook/upload   (non-payé only)
 *   - BANK JUIN 2026.csv                       -> /bank-statements/upload (bankKey=bred)
 *   - PAYPAL JUIN 2026.CSV                     -> /card-imports/upload?provider=paypal
 *   - Listing_transactions_remisees_juin.xlsx  -> /card-imports/upload?provider=sogecommerce-site
 *   - Listing_remises_juin.xlsx                -> /card-imports/upload-remises
 */
const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
const { BANK_LINES, DAYBOOK } = require('./client-june-data');

const OUT = path.resolve(__dirname, '../data/client-june2026');
fs.mkdirSync(OUT, { recursive: true });
const r2 = (n) => Math.round(n * 100) / 100;
const fr = (n) => n.toFixed(2).replace('.', ',');

const writeWb = (sheets, file) => {
  const wb = xlsx.utils.book_new();
  for (const [name, aoa] of sheets) xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(aoa), name);
  xlsx.writeFile(wb, path.join(OUT, file));
  console.log('wrote', file);
};
const writeText = (file, text) => { fs.writeFileSync(path.join(OUT, file), text); console.log('wrote', file); };

/* 1. Z-REPORT — POS day 2026-06-10 (drawer gap -4.30). */
{
  const H = ['CARDCODE','CUSTOMER','DATE','RECEIPT','OPERATOR','TOTAL','GOODS','VAT','ACCOUNT','CASH','CHANGE','CCARD','CHEQUE','COMMENT'];
  const D = '6/10/26';
  const receipts = [
    ['C9999','vente comptoir',D,'277001','RO1', 58.42, 55.37, 3.05, 0, 60,   -1.58, 0,      0,     ''],
    ['C9999','vente comptoir',D,'277002','RO1', 34.10, 32.32, 1.78, 0, 40,   -5.90, 0,      0,     ''],
    ['C2336','O.F.C',         D,'277003','RO1', 188.20,178.39,9.81, 0, 0,     0,    0,      188.20,''],
    ['C9999','vente comptoir',D,'277004','RO1', 72.55, 68.77, 3.78, 0, 80,   -7.45, 0,      0,     ''],
    ['C2422','YUNUS',         D,'277005','RO1', 95.40, 90.43, 4.97, 0, 0,     0,    95.40,  0,     ''],
    ['C2622','CHICKEN ASIA',  D,'277006','RO1', 152.30,144.36,7.94, 152.30,0, 0,    0,      0,     'paiement sur compte'],
  ];
  const sum = (i) => r2(receipts.reduce((a, r) => a + (Number(r[i]) || 0), 0));
  const arinv = ['ARINV TOTALS',null,null,null,null, sum(5),sum(6),sum(7),sum(8),sum(9),sum(10),sum(11),sum(12)];
  const float = [null,'CASH ADD FLOAT',D,'3','RO1',0,0,0,0,500,0,0,0];
  const exp1  = [null,'loyer juin acompte',D,'1601','RO1',0,0,0,0,-150,0,0,0];
  const exp2  = [null,'fournitures',D,'1875','RO1',0,0,0,0,-64.50,0,0,0];
  const petty = ['PETTY TOTALS',null,null,null,null,0,0,0,0,r2(500-150-64.5),0,0,0];
  const totals = ['TOTALS',null,null,null,null,arinv[5],arinv[6],arinv[7],arinv[8],arinv[9],arinv[10],arinv[11],arinv[12]];
  const aoa = [
    [null,'Sales Summary Report'],[null,'From Date: 10/06/2026'],[null,'To Date: 10/06/2026'],[null,'Shop: S001'],[null,' '],
    H, ...receipts, [],[],[],[], arinv, ['ORDER TOTALS'], ['PAYALLOC TOTALS'], float, exp1, exp2, [],[],[],[], petty, totals,
    [null,'Z Summary'],[null,' '],
    [null,'  Cash'],[null,'    In Audit    : 165.40'],[null,'    In Drawer   : 161.10'],[null,'    Discrepancy : -4.30'],[null,' '],
    [null,'  Card'],[null,'    In Audit    : 95.40'],[null,'    In Drawer   : 95.40'],[null,'    Discrepancy : 0'],[null,' '],
    [null,'  Cheque'],[null,'    In Audit    : 188.20'],[null,'    In Drawer   : 188.20'],[null,'    Discrepancy : 0'],[null,' '],
    [null,'  Net Discrepancy : -4.30'],
  ];
  writeWb([['SMExport 4.99', aoa], ['Sheet1', [[]]]], '100626 ZREPORT JUIN.XLSX');
}

/* 2. DAYBOOK — June, day-sheets 6-10, NON-PAYÉ deliveries only (no payment drafts). */
{
  const dow = { 6:'Friday', 7:'Saturday', 8:'Monday', 9:'Tuesday', 10:'Wednesday' };
  const daySheet = (day) => {
    const dels = DAYBOOK[day] || [];
    const rows = [];
    const set = (r, c, v) => { while (rows.length <= r) rows.push([]); while (rows[r].length <= c) rows[r].push(null); rows[r][c] = v; };
    set(0, 8, 'DATE'); set(0, 10, `${dow[day]} ${day} June 2026`);
    set(2, 4, 'Remise Bancaire (SAP)'); set(2, 8, 'EXCEL');
    set(3, 4, 'Espèces'); set(3, 5, 0); set(3, 8, 'ESPECES'); set(3, 10, 0);
    set(4, 4, 'Chèques'); set(4, 5, 0); set(4, 8, 'CHEQUES'); set(4, 10, 0);
    set(5, 4, 'Monnaie non déposée'); set(5, 5, 0); set(5, 8, 'CARTE CREDIT'); set(5, 10, 0);
    set(6, 8, 'VIREMENT'); set(6, 10, 0);
    set(7, 1, 'Caisse Espèces'); set(7, 3, 'Caisse chèques'); set(7, 5, 'Caisse CB');
    set(14, 1, 'Fond de caisse'); set(14, 2, 250);
    // LIVRAISONS — non payées (awaiting payment): no PaymentEntry drafts created.
    set(18, 0, 'LIVRAISONS');
    let r = 19;
    set(r, 0, 'CODE CLIENT'); set(r, 1, 'Livraisons non payées'); r++;
    for (const [code, name, amt, note] of dels) { set(r, 0, code); set(r, 1, name); set(r, 4, amt); set(r, 5, note); r++; }
    return rows;
  };
  writeWb([6, 7, 8, 9, 10].map((d) => [String(d), daySheet(d)]), 'Feuille de solde Juin 2026.xlsx');
}

/* 3. BANK STATEMENT — CSV ';' FR decimals, bankKey=bred. */
{
  const head = ["Date d'opération", 'Libellé', 'Montant', 'Solde'];
  let bal = 30000;
  const rows = [head];
  for (const l of BANK_LINES) { bal = r2(bal + l.amount); rows.push([l.date, l.label, fr(l.amount), fr(bal)]); }
  writeText('BANK JUIN 2026.csv', rows.map((r) => r.join(';')).join('\r\n') + '\r\n');
}

/* 4. PAYPAL — one customer payment + a sweep. */
{
  const header = ['Date','Heure','Nom','Type','État','Devise','Avant commission','Commission','Net','Numéro de transaction','De l\'adresse email','À l\'adresse email'];
  const rows = [
    header,
    ['09/06/2026','11:02:10','FIRAT','Paiement DCC','Terminé','EUR','188,20','-6,12','182,08','7CD22334EF556677A','firat-paris@example.com','tresorerie@msfhalal.fr'],
    ['09/06/2026','11:02:10','','Paiement standard','Terminé','EUR','-6,12','0,00','-6,12','7CD22334EF556677B','','tresorerie@msfhalal.fr'],
    ['10/06/2026','23:00:00','','Virement standard','Terminé','EUR','-182,08','0,00','-182,08','7ZZ11223344556677C','','tresorerie@msfhalal.fr'],
  ];
  const esc = (v) => /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
  writeText('PAYPAL JUIN 2026.CSV', rows.map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n');
}

/* 5. SOGECOMMERCE TRANSACTIONS — 2 accepted + 1 rejected (skipped by parser). */
{
  const H = ['Transaction','Commande','Type','Date du paiement','Statut','Montant du paiement','Date remise','N° remise','Moyen de paiement','Numéro de carte','E-mail acheteur'];
  const rows = [
    H,
    ['TX20260609001','UGUR SARL','Débit','09/06/2026','Accepté','455,60','10/06/2026','R20260610','CB','513778XXXXXX3558','contact@ugur.fr'],
    ['TX20260609002','KEBAB HOUSE','Débit','09/06/2026','Accepté','620,00','10/06/2026','R20260610','CB','497010XXXXXX1122','compta@kebabhouse.fr'],
    ['TX20260609003','CLIENT REJETE','Débit','09/06/2026','Rejeté','88,00','','','CB','411111XXXXXX9999','rejet@example.com'],
  ];
  writeWb([['Transactions', rows]], 'Listing_transactions_remisees_juin.xlsx');
}

/* 6. SOGECOMMERCE REMISES. */
{
  const H = ['N° remise','Date de remise','Réseau','Débit','Crédit','Statut'];
  const rows = [H, ['R20260610','10/06/2026','CB','0,00','1075,60','Validé']];
  writeWb([['Remises', rows]], 'Listing_remises_juin.xlsx');
}

console.log('\nAll CLIENT June 6-10 files written to', OUT);
