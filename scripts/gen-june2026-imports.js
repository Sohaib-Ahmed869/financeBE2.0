/**
 * Generates a coherent set of JUNE 2026 import files for end-to-end pipeline
 * testing. Pure file writer — no DB, no env, no SAP. Run with:
 *
 *   node scripts/gen-june2026-imports.js
 *
 * Outputs into be/data/june2026/. The card codes / amounts / dates here are
 * deliberately aligned with scripts/seed-june2026.ts so that the imported
 * files reconcile against the seeded customers / invoices / SAP payments.
 *
 * Files produced:
 *   - 050626 ZREPORT JUIN.XLSX            -> POST /zreports/upload?date=2026-06-05
 *   - Feuille de solde Juin 2026.xlsx     -> POST /daybook/upload
 *   - BANK JUIN 2026.csv                  -> POST /bank-statements/upload  (bankKey=bred)
 *   - PAYPAL JUIN 2026.CSV                -> POST /card-imports/upload?provider=paypal
 *   - Listing_transactions_remisees_juin.xlsx -> POST /card-imports/upload?provider=sogecommerce-site
 *   - Listing_remises_juin.xlsx           -> POST /card-imports/upload-remises
 */
const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');

const OUT = path.resolve(__dirname, '../data/june2026');
fs.mkdirSync(OUT, { recursive: true });

const writeWb = (sheets, file) => {
  const wb = xlsx.utils.book_new();
  for (const [name, aoa] of sheets) {
    xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(aoa), name);
  }
  xlsx.writeFile(wb, path.join(OUT, file));
  console.log('wrote', file);
};
const writeText = (file, text) => {
  fs.writeFileSync(path.join(OUT, file), text);
  console.log('wrote', file);
};

/* --------------------------------------------------------------------------
 * 1. Z-REPORT  (SMExport 4.99 layout, identical shape to the real samples)
 *    Date: 2026-06-05. POS day. Drives POS verification + drawer gap.
 * ------------------------------------------------------------------------ */
{
  // CARDCODE CUSTOMER DATE RECEIPT OPERATOR TOTAL GOODS VAT ACCOUNT CASH CHANGE CCARD CHEQUE COMMENT
  const H = ['CARDCODE','CUSTOMER','DATE','RECEIPT','OPERATOR','TOTAL','GOODS','VAT','ACCOUNT','CASH','CHANGE','CCARD','CHEQUE','COMMENT'];
  const D = '6/5/26';
  const receipts = [
    ['C9999','vente comptoir',D,'266501','RO1', 63.19, 59.90, 3.29, 0, 70,   -6.81, 0,      0,     ''],
    ['C9999','vente comptoir',D,'266502','RO1', 25.31, 23.99, 1.32, 0, 30,   -4.69, 0,      0,     ''],
    ['C2336','O.F.C',         D,'266503','RO1', 271.40,257.25,14.15,0, 0,     0,    0,      271.40,''],
    ['C2983','FIRAT',         D,'266504','RO1', 61.88, 58.65, 3.23, 0, 65,   -3.12, 0,      0,     ''],
    ['C2422','YUNUS',         D,'266505','RO1', 110.19,104.45,5.74, 0, 0,     0,    110.19, 0,     ''],
    ['C9999','vente comptoir',D,'266506','RO1', 46.09, 40.94, 5.15, 0, 50,   -3.91, 0,      0,     ''],
    ['C2622','CHICKEN ASIA',  D,'266507','RO1', 246.63,233.61,13.02,246.63,0, 0,    0,      0,     'paiement sur compte'],
  ];
  // ARINV totals = sum of receipts
  const sum = (i) => receipts.reduce((a, r) => a + (Number(r[i]) || 0), 0);
  const round2 = (n) => Math.round(n * 100) / 100;
  const arinv = ['ARINV TOTALS',null,null,null,null,
    round2(sum(5)), round2(sum(6)), round2(sum(7)), round2(sum(8)),
    round2(sum(9)), round2(sum(10)), round2(sum(11)), round2(sum(12))];

  const float = [null,'CASH ADD FLOAT',D,'3','RO1',0,0,0,0,600,0,0,0];
  const exp1  = [null,'loyer juin acompte',D,'1601','RO1',0,0,0,0,-178.99,0,0,0];
  const exp2  = [null,'acompte employe yahya',D,'1874','RO1',0,0,0,0,-120,0,0,0];
  const pettyCash = round2(600 - 178.99 - 120);
  const petty = ['PETTY TOTALS',null,null,null,null,0,0,0,0,pettyCash,0,0,0];
  // TOTALS cash = net sales cash (matches Z-Summary "In Audit" for cash); the
  // float/expenses live in the PETTY block and Z-Summary, not double-counted here.
  const totals = ['TOTALS',null,null,null,null,arinv[5],arinv[6],arinv[7],arinv[8],arinv[9],arinv[10],arinv[11],arinv[12]];

  const aoa = [
    [null,'Sales Summary Report'],
    [null,'From Date: 05/06/2026'],
    [null,'To Date: 05/06/2026'],
    [null,'Shop: S001'],
    [null,' '],
    H,
    ...receipts,
    [],[],[],[],
    arinv,
    ['ORDER TOTALS'],
    ['PAYALLOC TOTALS'],
    float, exp1, exp2,
    [],[],[],[],
    petty,
    totals,
    [null,'Z Summary'],
    [null,' '],
    [null,'  Cash'],
    [null,'    In Audit    : 196.47'],
    [null,'    In Drawer   : 190.00'],
    [null,'    Discrepancy : -6.47'],
    [null,' '],
    [null,'  Card'],
    [null,'    In Audit    : 110.19'],
    [null,'    In Drawer   : 110.19'],
    [null,'    Discrepancy : 0'],
    [null,' '],
    [null,'  Cheque'],
    [null,'    In Audit    : 271.40'],
    [null,'    In Drawer   : 271.40'],
    [null,'    Discrepancy : 0'],
    [null,' '],
    [null,'  Net Discrepancy : -6.47'],
  ];
  writeWb([['SMExport 4.99', aoa], ['Sheet1', [[]]]], '050626 ZREPORT JUIN.XLSX');
}

/* --------------------------------------------------------------------------
 * 2. DAYBOOK  "Feuille de solde Juin 2026.xlsx"
 *    One sheet per day; sheet name = day number. Top-of-day block + LIVRAISONS.
 * ------------------------------------------------------------------------ */
{
  const dow = { 2:'Tuesday', 3:'Wednesday', 4:'Thursday', 5:'Friday' };
  // Per-day delivery payments mirror the seeded PaymentEntry set.
  const deliveriesByDay = {
    2: { cheques: [['C2622','CHICKEN ASIA',1240.50,'bred','8801234']], virements: [['C4494','MCV DAUMESNIL',284.64,'VIR-MCV-0602']] },
    3: { cbSite:  [['C6819','UGUR SARL',980.00,'R20260604']], },
    4: { especes: [['C2422','YUNUS',432.75,'enveloppe NO00042']], cbPhone: [['C3050','KEBAB HOUSE',610.20,'R20260605']] },
    5: { nonPaye: [['C6819','UGUR SARL',1110.00,'facture en attente']] },
  };

  const r2 = (n) => Math.round(n * 100) / 100;
  const daySheet = (day) => {
    const dv = deliveriesByDay[day] || {};
    const sumAmt = (list) => r2((list || []).reduce((a, x) => a + Number(x[2] || 0), 0));
    const especes = sumAmt(dv.especes);
    const cheques = sumAmt(dv.cheques);
    const carteCredit = r2(sumAmt(dv.cbSite) + sumAmt(dv.cbPhone));
    const virement = sumAmt(dv.virements);
    const rows = [];
    const set = (r, c, v) => {
      while (rows.length <= r) rows.push([]);
      while (rows[r].length <= c) rows[r].push(null);
      rows[r][c] = v;
    };
    // Top-of-day header / EXCEL (right) + Remise Bancaire (SAP) block — per-day.
    set(0, 8, 'DATE'); set(0, 10, `${dow[day]} ${day} June 2026`);
    set(2, 4, 'Remise Bancaire (SAP)'); set(2, 8, 'EXCEL');
    set(3, 4, 'Espèces');  set(3, 5, especes); set(3, 8, 'ESPECES');       set(3, 10, especes);
    set(4, 4, 'Chèques');  set(4, 5, cheques); set(4, 8, 'CHEQUES');        set(4, 10, cheques);
    set(5, 4, 'Monnaie non déposée'); set(5, 5, 0); set(5, 8, 'CARTE CREDIT'); set(5, 10, carteCredit);
    set(6, 8, 'VIREMENT'); set(6, 10, virement);
    // Caisse blocks — kept consistent with the per-day deposit totals.
    set(7, 1, 'Caisse Espèces'); set(7, 3, 'Caisse chèques'); set(7, 5, 'Caisse CB');
    set(8, 1, 'Billets de 50'); set(8, 2, especes); set(8, 3, 'Client'); set(8, 4, 'Montant'); set(8, 5, 'Till'); set(8, 6, carteCredit);
    set(8, 8, 'Dépenses'); set(8, 11, 'Montant');
    set(9, 1, 'Billets de 20'); set(9, 2, 0);
    set(13, 1, 'Total'); set(13, 2, especes);
    set(14, 1, 'Fond de caisse'); set(14, 2, 250); set(14, 3, 'Total'); set(14, 4, cheques); set(14, 5, 'Total'); set(14, 6, carteCredit);

    // LIVRAISONS
    set(18, 0, 'LIVRAISONS');
    let r = 19;
    const section = (label, header, list, mapRow) => {
      set(r, 0, 'CODE CLIENT'); set(r, 1, label); r++;
      header.forEach((h, i) => set(r - 1, i, r - 1 === r - 1 ? rows[r-1][i] : h)); // keep CODE CLIENT label
      for (const item of list) { mapRow(r, item); r++; }
      r++; // gap row
    };
    if (dv.cheques) section('Paiements Chèques', [], dv.cheques, (rr, [code, name, amt, bank, num]) => {
      set(rr, 0, code); set(rr, 1, name); set(rr, 4, amt); set(rr, 5, bank); set(rr, 6, num); set(rr, 11, 'ok');
    });
    if (dv.especes) section('Paiements Espèces', [], dv.especes, (rr, [code, name, amt, note]) => {
      set(rr, 0, code); set(rr, 1, name); set(rr, 4, amt); set(rr, 5, note); set(rr, 11, 'ok');
    });
    if (dv.cbSite) section('Paiements CB Site', [], dv.cbSite, (rr, [code, name, amt, ref]) => {
      set(rr, 0, code); set(rr, 1, name); set(rr, 4, amt); set(rr, 5, ref); set(rr, 11, 'ok');
    });
    if (dv.cbPhone) section('Paiements CB Téléphone', [], dv.cbPhone, (rr, [code, name, amt, ref]) => {
      set(rr, 0, code); set(rr, 1, name); set(rr, 4, amt); set(rr, 5, ref); set(rr, 11, 'ok');
    });
    if (dv.virements) section('Virements', [], dv.virements, (rr, [code, name, amt, ref]) => {
      set(rr, 0, code); set(rr, 1, name); set(rr, 4, amt); set(rr, 5, ref); set(rr, 11, 'ok');
    });
    if (dv.nonPaye) section('Livraisons non payées', [], dv.nonPaye, (rr, [code, name, amt, note]) => {
      set(rr, 0, code); set(rr, 1, name); set(rr, 4, amt); set(rr, 5, note);
    });
    return rows;
  };

  const sheets = [2, 3, 4, 5].map((d) => [String(d), daySheet(d)]);
  writeWb(sheets, 'Feuille de solde Juin 2026.xlsx');
}

/* --------------------------------------------------------------------------
 * 3. BANK STATEMENT  (CSV, ';' delimited, FR decimals)  bankKey=bred
 *    Deposit lines match SAP daily method totals from seed-june2026.ts:
 *      02/06 cheque 1240.50 | 02/06 bank 284.64
 *      03/06 card 1136.30   | 04/06 cash 432.75 | 04/06 card 610.20
 *    Plus exceptions: an unexplained credit + a bank-fee debit.
 *    (Seeded SAP also has a 03/06 bank transfer 175.00 with NO bank line ->
 *     "missing in bank".)
 * ------------------------------------------------------------------------ */
{
  const rows = [
    ["Date d'opération", 'Libellé', 'Montant', 'Solde'],
    ['02/06/2026', 'REMISE CHEQUE 8801234 CHICKEN ASIA', '1240,50', '21240,50'],
    ['02/06/2026', 'VIREMENT RECU MCV DAUMESNIL',        '284,64',  '21525,14'],
    ['03/06/2026', 'REMISE CB SOGECOMMERCE',             '1136,30', '22661,44'],
    ['04/06/2026', 'REMISE ESPECES NO00042',             '432,75',  '23094,19'],
    ['04/06/2026', 'REMISE CB',                          '610,20',  '23704,39'],
    ['05/06/2026', 'COMMISSION CARTE BANCAIRE',          '-12,40',  '23691,99'],
    ['06/06/2026', 'VIREMENT RECU SCI HORIZON',          '500,00',  '24191,99'],
  ];
  writeText('BANK JUIN 2026.csv', rows.map((r) => r.join(';')).join('\r\n') + '\r\n');
}

/* --------------------------------------------------------------------------
 * 4. PAYPAL  (CSV, comma delimited, FR decimals, FR headers)  provider=paypal
 *    One customer payment (FIRAT -> invoice 5004 / C2983) + a bank sweep.
 * ------------------------------------------------------------------------ */
{
  const header = ['Date','Heure','Nom','Type','État','Devise','Avant commission','Commission','Net','Numéro de transaction','De l\'adresse email','À l\'adresse email'];
  const rows = [
    header,
    ['03/06/2026','10:14:22','FIRAT','Paiement DCC','Terminé','EUR','156,30','-5,41','150,89','9AB12345CD678901E','firat-paris@example.com','tresorerie@msfhalal.fr'],
    ['03/06/2026','10:14:22','','Paiement standard','Terminé','EUR','-5,41','0,00','-5,41','9AB12345CD678901F','','tresorerie@msfhalal.fr'],
    ['05/06/2026','23:00:00','','Virement standard','Terminé','EUR','-150,89','0,00','-150,89','9ZZ99887766554433A','','tresorerie@msfhalal.fr'],
  ];
  // CSV with comma delimiter; quote fields containing commas (none here use comma decimals -> FR uses ',' so quote amounts)
  const esc = (v) => /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
  writeText('PAYPAL JUIN 2026.CSV', rows.map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n');
}

/* --------------------------------------------------------------------------
 * 5. SOGECOMMERCE TRANSACTIONS  (xlsx) provider=sogecommerce-site
 *    UGUR -> invoice 5003 (CB-Site) ; KEBAB -> invoice 5006 (CB-Phone).
 * ------------------------------------------------------------------------ */
{
  const H = ['Transaction','Commande','Type','Date du paiement','Statut','Montant du paiement','Date remise','N° remise','Moyen de paiement','Numéro de carte','E-mail acheteur'];
  const rows = [
    H,
    ['TX20260603001','UGUR SARL','Débit','03/06/2026','Accepté','980,00','04/06/2026','R20260604','CB','513778XXXXXX3558','contact@ugur.fr'],
    ['TX20260604002','KEBAB HOUSE','Débit','04/06/2026','Accepté','610,20','05/06/2026','R20260605','CB','497010XXXXXX1122','compta@kebabhouse.fr'],
    ['TX20260604003','CLIENT REJETE','Débit','04/06/2026','Rejeté','75,00','','','CB','411111XXXXXX9999','rejet@example.com'],
  ];
  writeWb([['Transactions', rows]], 'Listing_transactions_remisees_juin.xlsx');
}

/* --------------------------------------------------------------------------
 * 6. SOGECOMMERCE REMISES  (xlsx)  -> /card-imports/upload-remises
 * ------------------------------------------------------------------------ */
{
  const H = ['N° remise','Date de remise','Réseau','Débit','Crédit','Statut'];
  const rows = [
    H,
    ['R20260604','04/06/2026','CB','0,00','980,00','Validé'],
    ['R20260605','05/06/2026','CB','0,00','610,20','Validé'],
  ];
  writeWb([['Remises', rows]], 'Listing_remises_juin.xlsx');
}

console.log('\nAll June 2026 import files written to', OUT);
