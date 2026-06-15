import * as XLSX from 'xlsx';

/**
 * Regenerates a "Feuille de solde" workbook from stored DaybookDay rows.
 *
 * Cell layout mirrors the parser's input precisely (see
 * `daybook.parser.ts`) so a round-trip (upload → export → re-upload) is
 * lossless: every block goes back to the same cell coordinate it came from.
 *
 * Sheets:
 *   - `empty sheet` — template header for visual parity with Idris's file
 *   - `1`…`31`     — one per day (skips days that don't exist in the data)
 */

interface DaybookDayLike {
  date: Date;
  dayOfMonth: number;
  totals?: {
    especes?: number | null;
    cheques?: number | null;
    carteCredit?: number | null;
    virement?: number | null;
  } | null;
  remiseBancaire?: {
    especes?: number | null;
    cheques?: number | null;
    monnaieNonDeposee?: number | null;
    bankSlipRefs?: string[];
    bankSlips?: Array<{
      ref: string;
      amount?: number | null;
      kind: 'cash' | 'cheques' | 'mixed';
    }>;
  } | null;
  caisseEspeces?: {
    billets50?: number | null;
    billets20?: number | null;
    billets10?: number | null;
    billets5?: number | null;
    monnaie?: number | null;
    total?: number | null;
    fondCaisse?: number | null;
  } | null;
  caisseCheques?: Array<{ client?: string; montant?: number | null }>;
  caisseChequesTotal?: number | null;
  caisseCB?: {
    till?: number | null;
    sansContact?: number | null;
    total?: number | null;
  } | null;
  differenceFondCaisse?: number | null;
  depenses?: Array<{ label?: string; amount?: number | null }>;
  depensesTotal?: number | null;
  livraisons?: Array<{
    codeClient?: string;
    clientName?: string;
    montant?: number | null;
    banque?: string;
    numero?: string;
    remarques?: string;
    sapStatusRaw?: string;
    montantEspeces?: number | null;
    montantCBSite?: number | null;
    montantCBPhone?: number | null;
    montantVirement?: number | null;
    referenceVirement?: string;
    nonPaye?: boolean;
  }>;
}

const FRENCH_WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];
const FRENCH_MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function fmtMoney(n: number | null | undefined): string {
  if (n === null || n === undefined) return '';
  return n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }) + ' €';
}

function setCell(
  ws: XLSX.WorkSheet,
  row: number,
  col: number,
  value: string | number | null | undefined,
): void {
  if (value === null || value === undefined || value === '') return;
  const ref = XLSX.utils.encode_cell({ r: row, c: col });
  ws[ref] = typeof value === 'number'
    ? { v: value, t: 'n' }
    : { v: String(value), t: 's' };
}

function dateLabel(d: Date): string {
  const wd = FRENCH_WEEKDAYS[d.getUTCDay()];
  const dm = d.getUTCDate();
  const mo = FRENCH_MONTHS[d.getUTCMonth()];
  const yr = d.getUTCFullYear();
  return `${wd} ${dm} ${mo} ${yr}`;
}

function renderDaySheet(day: DaybookDayLike): XLSX.WorkSheet {
  const ws: XLSX.WorkSheet = {};

  // Row 1: I="DATE", J=date string. Bank slips emitted one row per slip
  // starting row 0, cols G=ref, H=amount, M=kind. When the new amount-carrying
  // shape is absent, fall back to writing just the legacy refs in col G —
  // round-trip with the legacy parser stays intact.
  setCell(ws, 0, 8, 'DATE');
  setCell(ws, 0, 9, dateLabel(day.date));
  const bankSlips = day.remiseBancaire?.bankSlips ?? [];
  const legacyRefs = day.remiseBancaire?.bankSlipRefs ?? [];
  if (bankSlips.length > 0) {
    for (let i = 0; i < bankSlips.length; i++) {
      const s = bankSlips[i];
      if (!s.ref && (s.amount === null || s.amount === undefined)) continue;
      setCell(ws, i, 6, s.ref);
      setCell(ws, i, 7, fmtMoney(s.amount));
      setCell(ws, i, 12, s.kind);
    }
  } else {
    if (legacyRefs[0]) setCell(ws, 0, 6, legacyRefs[0]);
    if (legacyRefs[1]) setCell(ws, 1, 6, legacyRefs[1]);
    if (legacyRefs[2]) setCell(ws, 2, 6, legacyRefs[2]);
  }

  // Row 3: section headers
  setCell(ws, 2, 4, 'Remise Bancaire (SAP)');
  setCell(ws, 2, 8, 'EXCEL');

  // Row 4-7: Remise Bancaire + EXCEL totals
  setCell(ws, 3, 4, 'Espèces');
  setCell(ws, 3, 5, fmtMoney(day.remiseBancaire?.especes));
  if (bankSlips.length === 0 && legacyRefs[3]) {
    setCell(ws, 3, 6, legacyRefs[3]);
  }
  setCell(ws, 3, 8, 'ESPECES');
  setCell(ws, 3, 10, fmtMoney(day.totals?.especes));

  setCell(ws, 4, 4, 'Chèques');
  setCell(ws, 4, 5, fmtMoney(day.remiseBancaire?.cheques));
  if (bankSlips.length === 0 && legacyRefs[4]) {
    setCell(ws, 4, 6, legacyRefs[4]);
  }
  setCell(ws, 4, 8, 'CHEQUES');
  setCell(ws, 4, 10, fmtMoney(day.totals?.cheques));

  setCell(ws, 5, 4, 'Monnaie non déposée');
  setCell(ws, 5, 5, fmtMoney(day.remiseBancaire?.monnaieNonDeposee));
  setCell(ws, 5, 8, 'CARTE CREDIT');
  setCell(ws, 5, 10, fmtMoney(day.totals?.carteCredit));

  setCell(ws, 6, 8, 'VIREMENT');
  setCell(ws, 6, 10, fmtMoney(day.totals?.virement));

  // Row 8: Caisse section headers
  setCell(ws, 7, 1, 'Caisse Espèces');
  setCell(ws, 7, 3, 'Caisse chèques');
  setCell(ws, 7, 5, 'Caisse CB');

  // Row 9: bills + cheque/CB headers + expenses header
  setCell(ws, 8, 1, 'Billets de 50');
  setCell(ws, 8, 2, fmtMoney(day.caisseEspeces?.billets50));
  setCell(ws, 8, 3, 'Client');
  setCell(ws, 8, 4, 'Montant');
  setCell(ws, 8, 5, 'Client');
  setCell(ws, 8, 6, 'Montant');
  setCell(ws, 8, 8, 'Dépenses: Essence, Divers');
  setCell(ws, 8, 11, 'Montant');

  // Rows 10-13: bills + chèques POS + CB POS + expenses
  const billRows: Array<[number, string, number | null | undefined]> = [
    [9, 'Billets de 20', day.caisseEspeces?.billets20],
    [10, 'Billets de 10', day.caisseEspeces?.billets10],
    [11, 'Billets de 5', day.caisseEspeces?.billets5],
    [12, 'Monnaie', day.caisseEspeces?.monnaie],
  ];
  for (const [r, label, amt] of billRows) {
    setCell(ws, r, 1, label);
    setCell(ws, r, 2, fmtMoney(amt));
  }

  // Caisse Chèques rows (D=client, E=amount), starting row 10 (idx 9), max 5.
  const caisseCheques = day.caisseCheques ?? [];
  for (let i = 0; i < Math.min(caisseCheques.length, 5); i++) {
    const r = 9 + i;
    const c = caisseCheques[i];
    setCell(ws, r, 3, c.client ?? '');
    setCell(ws, r, 4, c.montant ?? null);
  }

  // Caisse CB rows: row 10 = Till + amount, row 11 = sancont + amount
  setCell(ws, 9, 5, 'Till');
  setCell(ws, 9, 6, fmtMoney(day.caisseCB?.till));
  setCell(ws, 10, 5, 'sancont');
  setCell(ws, 10, 6, fmtMoney(day.caisseCB?.sansContact));

  // Expenses (col I label, col L amount), rows 10-13.
  const depenses = day.depenses ?? [];
  for (let i = 0; i < Math.min(depenses.length, 5); i++) {
    const r = 9 + i;
    const e = depenses[i];
    setCell(ws, r, 8, e.label ?? '');
    setCell(ws, r, 11, fmtMoney(e.amount));
  }

  // Row 14: Total cash bills
  setCell(ws, 13, 1, 'Total');
  setCell(ws, 13, 2, fmtMoney(day.caisseEspeces?.total));

  // Row 15: Fond de caisse + POS chèques total + POS CB total + diff
  setCell(ws, 14, 1, 'Fond de caisse');
  setCell(ws, 14, 2, fmtMoney(day.caisseEspeces?.fondCaisse));
  setCell(ws, 14, 3, 'Total');
  setCell(ws, 14, 4, fmtMoney(day.caisseChequesTotal));
  setCell(ws, 14, 5, 'Total');
  setCell(ws, 14, 6, fmtMoney(day.caisseCB?.total));
  setCell(ws, 14, 8, 'Différence Fond Caisse');
  setCell(ws, 14, 11, fmtMoney(day.differenceFondCaisse));

  // Row 16: expenses total
  setCell(ws, 15, 10, 'Total');
  setCell(ws, 15, 11, fmtMoney(day.depensesTotal));

  // Row 18: LIVRAISONS section header
  setCell(ws, 17, 0, 'LIVRAISONS');

  // LIVRAISONS — six stacked sections, one per payment method (mirrors the
  // input file's actual layout). Each section starts with a "CODE CLIENT"
  // header row whose col B identifies the method.
  const livraisons = day.livraisons ?? [];
  type Section =
    | { kind: 'cheque'; rows: typeof livraisons }
    | { kind: 'especes'; rows: typeof livraisons }
    | { kind: 'cbsite'; rows: typeof livraisons }
    | { kind: 'cbphone'; rows: typeof livraisons }
    | { kind: 'virement'; rows: typeof livraisons }
    | { kind: 'nonpaye'; rows: typeof livraisons };

  const sections: Section[] = [
    {
      kind: 'cheque',
      rows: livraisons.filter(
        (l) => !l.nonPaye && l.montant !== null && l.montant !== undefined,
      ),
    },
    {
      kind: 'especes',
      rows: livraisons.filter(
        (l) => l.montantEspeces !== null && l.montantEspeces !== undefined,
      ),
    },
    {
      kind: 'cbsite',
      rows: livraisons.filter(
        (l) => l.montantCBSite !== null && l.montantCBSite !== undefined,
      ),
    },
    {
      kind: 'cbphone',
      rows: livraisons.filter(
        (l) => l.montantCBPhone !== null && l.montantCBPhone !== undefined,
      ),
    },
    {
      kind: 'virement',
      rows: livraisons.filter(
        (l) => l.montantVirement !== null && l.montantVirement !== undefined,
      ),
    },
    { kind: 'nonpaye', rows: livraisons.filter((l) => l.nonPaye) },
  ];

  let r = 18;
  for (const section of sections) {
    if (section.rows.length === 0) continue;

    // Header row
    setCell(ws, r, 0, 'CODE CLIENT');
    if (section.kind === 'cheque') {
      setCell(ws, r, 1, 'Paiements Chèques');
      setCell(ws, r, 4, 'Montant');
      setCell(ws, r, 5, 'Banque');
      setCell(ws, r, 6, 'Numero');
      setCell(ws, r, 7, 'Remarques');
    } else {
      setCell(
        ws,
        r,
        1,
        section.kind === 'especes'
          ? 'Paiements Espèces'
          : section.kind === 'cbsite'
            ? 'Paiements CB Site'
            : section.kind === 'cbphone'
              ? 'Paiements CB Téléphone'
              : section.kind === 'virement'
                ? 'Virements'
                : 'Livraisons non payées',
      );
      setCell(ws, r, 4, 'Montant');
      setCell(ws, r, 5, 'Remarques');
    }
    setCell(ws, r, 11, 'SAP');
    r++;

    for (const l of section.rows) {
      setCell(ws, r, 0, l.codeClient ?? '');
      setCell(ws, r, 1, l.clientName ?? '');
      switch (section.kind) {
        case 'cheque':
          setCell(ws, r, 4, fmtMoney(l.montant));
          setCell(ws, r, 5, l.banque ?? '');
          setCell(ws, r, 6, l.numero ?? '');
          setCell(ws, r, 7, l.remarques ?? '');
          break;
        case 'especes':
          setCell(ws, r, 4, fmtMoney(l.montantEspeces));
          setCell(ws, r, 5, l.remarques ?? '');
          break;
        case 'cbsite':
          setCell(ws, r, 4, fmtMoney(l.montantCBSite));
          setCell(ws, r, 5, l.remarques ?? '');
          break;
        case 'cbphone':
          setCell(ws, r, 4, fmtMoney(l.montantCBPhone));
          setCell(ws, r, 5, l.remarques ?? '');
          break;
        case 'virement':
          setCell(ws, r, 4, fmtMoney(l.montantVirement));
          setCell(ws, r, 5, l.referenceVirement ?? l.remarques ?? '');
          break;
        case 'nonpaye':
          setCell(ws, r, 4, fmtMoney(l.montant));
          setCell(ws, r, 5, l.remarques ?? '');
          break;
      }
      setCell(ws, r, 11, l.sapStatusRaw ?? '');
      r++;
    }

    // One blank spacer row between sections — matches the input file.
    r++;
  }

  // Set the worksheet's used range so XLSX honors all written cells.
  const lastRow = Math.max(r, 20);
  ws['!ref'] = XLSX.utils.encode_range({
    s: { r: 0, c: 0 },
    e: { r: lastRow, c: 14 },
  });

  return ws;
}

export interface ExportInput {
  monthLabel: string | null;
  year: number;
  month: number;
  days: DaybookDayLike[];
}

export function buildDaybookWorkbook(input: ExportInput): Buffer {
  const wb = XLSX.utils.book_new();
  // Mirror the original file's "empty sheet" template at the start.
  XLSX.utils.book_append_sheet(wb, {}, 'empty sheet');

  // One sheet per day, named by day-of-month (matches the input file).
  const sorted = [...input.days].sort((a, b) => a.dayOfMonth - b.dayOfMonth);
  for (const d of sorted) {
    const ws = renderDaySheet(d);
    XLSX.utils.book_append_sheet(wb, ws, String(d.dayOfMonth));
  }

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
