import fs from 'fs';
import path from 'path';
import { parseDaybookWorkbook } from '../src/modules/daybook/daybook.parser';
import { buildDaybookWorkbook } from '../src/modules/daybook/daybook.exporter';

const inFile = path.resolve(__dirname, '../data/Feuille de solde Avril 2026.xlsx');
const buf = fs.readFileSync(inFile);
const parsed = parseDaybookWorkbook(buf, path.basename(inFile));

console.log(`Parsed ${parsed.days.length} days from input.`);

const out = buildDaybookWorkbook({
  monthLabel: parsed.monthLabel,
  year: parsed.year ?? 2026,
  month: parsed.month ?? 4,
  days: parsed.days.map((d) => ({
    date: d.date,
    dayOfMonth: d.dayOfMonth,
    totals: d.totals,
    remiseBancaire: d.remiseBancaire,
    caisseEspeces: d.caisseEspeces,
    caisseCheques: d.caisseCheques,
    caisseChequesTotal: d.caisseChequesTotal,
    caisseCB: d.caisseCB,
    differenceFondCaisse: d.differenceFondCaisse,
    depenses: d.depenses,
    depensesTotal: d.depensesTotal,
    livraisons: d.livraisons,
  })),
});

const outPath = path.resolve(__dirname, '../data/exported.xlsx');
fs.writeFileSync(outPath, out);
console.log(`Exported ${out.length} bytes → ${outPath}`);

// Round-trip: parse what we just wrote.
const reparsed = parseDaybookWorkbook(out, 'Feuille de solde Avril 2026.xlsx');
console.log(`Re-parsed ${reparsed.days.length} days from export.`);
const lossy = parsed.days.length !== reparsed.days.length;
console.log(`Round-trip day count match: ${!lossy ? 'YES' : 'NO'}`);

// Spot check day 1.
const d1in = parsed.days[0];
const d1out = reparsed.days[0];
if (d1in && d1out) {
  console.log('\nDay 1 totals.especes:', d1in.totals.especes, '→', d1out.totals.especes);
  console.log('Day 1 livraisons:', d1in.livraisons.length, '→', d1out.livraisons.length);
  console.log(
    'Day 1 caisseCB.till:',
    d1in.caisseCB.till,
    '→',
    d1out.caisseCB.till,
  );
}
