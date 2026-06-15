import fs from 'fs';
import path from 'path';
import { parseDaybookWorkbook } from '../src/modules/daybook/daybook.parser';

const file = path.resolve(__dirname, '../data/Feuille de solde Avril 2026.xlsx');
const buf = fs.readFileSync(file);
const result = parseDaybookWorkbook(buf, path.basename(file));

console.log('Month:', result.monthLabel, result.month, result.year);
console.log('Days parsed:', result.days.length);
console.log('Errors:', result.errors);
console.log('---');

const target = process.argv[2];
const days = target
  ? result.days.filter((d) => d.dayOfMonth === Number(target))
  : result.days.slice(0, 3);

for (const d of days) {
  console.log(`\n=== Day ${d.dayOfMonth} (${d.sheetName}) — ${d.date.toISOString().slice(0, 10)} ===`);
  console.log('  totals:', d.totals);
  console.log('  remiseBancaire:', d.remiseBancaire);
  console.log('  caisseEspeces:', d.caisseEspeces);
  console.log('  caisseCheques:', d.caisseCheques, 'total=', d.caisseChequesTotal);
  console.log('  caisseCB:', d.caisseCB);
  console.log('  differenceFondCaisse:', d.differenceFondCaisse);
  console.log('  depenses:', d.depenses, 'total=', d.depensesTotal);

  // Per-method livraisons breakdown
  const by = {
    cheque: d.livraisons.filter((l) => !l.nonPaye && l.montant !== null && l.montant > 0),
    especes: d.livraisons.filter((l) => l.montantEspeces !== null),
    cbsite: d.livraisons.filter((l) => l.montantCBSite !== null),
    cbphone: d.livraisons.filter((l) => l.montantCBPhone !== null),
    virement: d.livraisons.filter((l) => l.montantVirement !== null),
    nonpaye: d.livraisons.filter((l) => l.nonPaye),
  };
  console.log(`  livraisons total: ${d.livraisons.length} rows`);
  console.log(`    cheque  : ${by.cheque.length}`);
  console.log(`    especes : ${by.especes.length}`);
  console.log(`    cbSite  : ${by.cbsite.length}`);
  console.log(`    cbPhone : ${by.cbphone.length}`);
  console.log(`    virement: ${by.virement.length}`);
  console.log(`    nonPaye : ${by.nonpaye.length}`);

  if (target) {
    for (const [method, rows] of Object.entries(by)) {
      if (rows.length === 0) continue;
      console.log(`\n  --- ${method} ---`);
      for (const l of rows) console.log('   ', l);
    }
  }

  if (d.parseWarnings.length) console.log('  warnings:', d.parseWarnings);
}
