import * as XLSX from 'xlsx';
import path from 'path';

const file = path.resolve(__dirname, '../data/Feuille de solde Avril 2026.xlsx');
const wb = XLSX.readFile(file, { cellDates: true });

console.log('=== SHEETS ===');
console.log(wb.SheetNames);

for (const name of wb.SheetNames) {
  const ws = wb.Sheets[name];
  if (!ws['!ref']) continue;
  const range = XLSX.utils.decode_range(ws['!ref']);
  console.log(`\n=== Sheet: ${name} === range: ${ws['!ref']} (${range.e.r + 1} rows × ${range.e.c + 1} cols)`);
  // Dump first ~25 rows of all cells (raw values) to map structure.
  const rows: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: false });
  const limit = Math.min(rows.length, 35);
  for (let r = 0; r < limit; r++) {
    const row = rows[r];
    // trim trailing nulls for display
    let lastNonNull = row.length - 1;
    while (lastNonNull >= 0 && (row[lastNonNull] === null || row[lastNonNull] === '')) lastNonNull--;
    const trimmed = row.slice(0, lastNonNull + 1);
    console.log(`R${String(r + 1).padStart(3, '0')}:`, JSON.stringify(trimmed));
  }
  if (rows.length > limit) console.log(`... +${rows.length - limit} more rows`);
}
