import * as XLSX from 'xlsx';

/**
 * Parser for the "Feuille de solde" monthly workbook.
 *
 * Top-of-day blocks (rows 1–16) — see `be/scripts/inspect-feuille.ts`:
 *
 *   row 1  | I="DATE", J="Wednesday 1 April 2026"; G holds bank-deposit slip refs (NO00…)
 *   row 3  | E="Remise Bancaire (SAP)" header,   I="EXCEL" header
 *   row 4  | E="Espèces",  F=amount, G=slip ref;  I="ESPECES",  K=amount
 *   row 5  | E="Chèques",  F=amount, G=slip ref;  I="CHEQUES",  K=amount
 *   row 6  | E="Monnaie non déposée", F=amount;   I="CARTE CREDIT", K=amount
 *   row 7  |                                       I="VIREMENT", K=amount
 *   row 8  | B="Caisse Espèces", D="Caisse chèques", F="Caisse CB"
 *   row 9  | B="Billets de 50", C=amount; D="Client", E="Montant"; F="Client", G="Montant"; I="Dépenses", L="Montant"
 *   row 10-13 | bills 50/20/10/5/coins; POS cheques (D=client, E=amount); POS CB (F=Till/sancont, G=amount); expenses (I=label, L=amount)
 *   row 14 | B="Total", C=cash bills total
 *   row 15 | B="Fond de caisse", C=float; D="Total", E=POS-cheques total; F="Total", G=POS-CB total; I="Différence Fond Caisse", L=diff
 *   row 16 | K="Total", L=expenses total
 *
 * LIVRAISONS — six stacked sections, each preceded by a "CODE CLIENT" header
 * whose second column names the section:
 *
 *   row 18 | A="LIVRAISONS"
 *   row 19 | A="CODE CLIENT", B="Paiements Chèques", E="Montant", F="Banque", G="Numero", H="Remarques", L="SAP"
 *   rows ↓ | cheque rows: A=codeClient, B=clientName, E=montant, F=banque, G=numero, H=remarques, L=sap
 *
 *          | A="CODE CLIENT", B="Paiements Espèces",     E="Montant", F="Remarques", L="SAP"
 *          | A="CODE CLIENT", B="Paiements CB Site",     E="Montant", F="Remarques", L="SAP"
 *          | A="CODE CLIENT", B="Paiements CB Téléphone",E="Montant", F="Remarques", L="SAP"
 *          | A="CODE CLIENT", B="Virements",             E="Montant", F="Remarques", L="SAP"
 *          | A="CODE CLIENT", B="Livraisons non payées", E="Montant", F="Remarques", L="SAP"
 *
 * Data rows in any section have codeClient in col A and clientName in
 * EITHER col B or col C (whichever is non-empty). Montant is always col E.
 * Sections are separated by stretches of empty rows — the parser walks to
 * the bottom of the sheet, switching state on each header, and stops on
 * "TOTAL …" rows that summarize the day at the very bottom.
 */

const FRENCH_MONTHS: Record<string, number> = {
  janvier: 1,
  fevrier: 2,
  février: 2,
  mars: 3,
  avril: 4,
  mai: 5,
  juin: 6,
  juillet: 7,
  aout: 8,
  août: 8,
  septembre: 9,
  octobre: 10,
  novembre: 11,
  decembre: 12,
  décembre: 12,
};

export function parseMonthYearFromFilename(
  filename: string,
): { month: number; year: number; label: string } | null {
  // Match e.g. "Feuille de solde Avril 2026.xlsx", case- and accent-insensitive.
  const cleaned = filename
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
  const match = cleaned.match(/(janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre)\s+(\d{4})/);
  if (!match) return null;
  const month = FRENCH_MONTHS[match[1]];
  const year = Number(match[2]);
  if (!month || !year) return null;
  // Build a label using the original (accented) filename for nicer display.
  const original = filename.match(
    /(Janvier|Février|Fevrier|Mars|Avril|Mai|Juin|Juillet|Août|Aout|Septembre|Octobre|Novembre|Décembre|Decembre)\s+(\d{4})/i,
  );
  const label = original ? `${original[1]} ${original[2]}` : `${match[1]} ${match[2]}`;
  return { month, year, label };
}

const NUMBER_RE = /-?\d[\d\s.,]*/;

/**
 * Parse a French-formatted money/number cell. Examples it accepts:
 *   "9,640.00 €"  → 9640
 *   "1.500,75 €"  → 1500.75   (FR thousands)
 *   "530.06"      → 530.06
 *   "-177.00 €"   → -177
 *   "461.00 €"    → 461
 * Returns `null` for empty/non-numeric cells.
 */
export function parseAmount(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const text = String(raw).trim();
  if (!text) return null;
  const match = text.match(NUMBER_RE);
  if (!match) return null;
  let s = match[0].replace(/\s/g, '');
  // If both '.' and ',' appear, the LAST occurring one is the decimal sep.
  // If only ',' appears AND it's followed by exactly 2 digits at the end,
  // treat it as decimal; otherwise treat ',' as thousands.
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot !== -1 && lastComma !== -1) {
    if (lastDot > lastComma) {
      s = s.replace(/,/g, '');
    } else {
      s = s.replace(/\./g, '').replace(',', '.');
    }
  } else if (lastComma !== -1) {
    const tail = s.length - lastComma - 1;
    if (tail === 2 && !/,/.test(s.slice(0, lastComma))) {
      s = s.replace(',', '.');
    } else {
      s = s.replace(/,/g, '');
    }
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function cell(rows: unknown[][], r: number, c: number): unknown {
  const row = rows[r];
  if (!row) return null;
  return row[c] ?? null;
}

function trimText(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  return String(raw).trim();
}

function normalizeText(raw: unknown): string {
  return String(raw ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, '');
}

export interface ParsedDay {
  sheetName: string;
  dayOfMonth: number;
  date: Date;
  totals: {
    especes: number | null;
    cheques: number | null;
    carteCredit: number | null;
    virement: number | null;
  };
  remiseBancaire: {
    especes: number | null;
    cheques: number | null;
    monnaieNonDeposee: number | null;
    bankSlipRefs: string[];
  };
  caisseEspeces: {
    billets50: number | null;
    billets20: number | null;
    billets10: number | null;
    billets5: number | null;
    monnaie: number | null;
    total: number | null;
    fondCaisse: number | null;
  };
  caisseCheques: Array<{ client: string; montant: number | null }>;
  caisseChequesTotal: number | null;
  caisseCB: {
    till: number | null;
    sansContact: number | null;
    total: number | null;
  };
  differenceFondCaisse: number | null;
  depenses: Array<{ label: string; amount: number | null }>;
  depensesTotal: number | null;
  livraisons: Array<{
    codeClient: string;
    clientName: string;
    montant: number | null;
    banque: string;
    numero: string;
    remarques: string;
    sapStatusRaw: string;
    montantEspeces: number | null;
    montantCBSite: number | null;
    montantCBPhone: number | null;
    montantVirement: number | null;
    referenceVirement: string;
    nonPaye: boolean;
  }>;
  parseWarnings: string[];
}

function parseDay(
  rows: unknown[][],
  sheetName: string,
  year: number,
  month: number,
): ParsedDay | null {
  const dayOfMonth = Number(sheetName);
  if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) {
    return null;
  }
  const date = new Date(Date.UTC(year, month - 1, dayOfMonth));
  if (
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== dayOfMonth
  ) {
    return null; // e.g. day 31 in a 30-day month
  }

  const warnings: string[] = [];

  // Bank deposit slip refs scattered in column G across rows 1–4 (and occasionally
  // a couple of rows above/below). Collect anything that looks like NO… or no…
  const bankSlipRefs: string[] = [];
  for (let r = 0; r <= 5; r++) {
    const v = trimText(cell(rows, r, 6));
    if (v && /^no\d/i.test(v)) bankSlipRefs.push(v);
  }

  // Caisse Espèces — bills (rows 9–13, col B label, col C amount; 0-indexed: rows 8–12, cols 1/2)
  const billets50 = parseAmount(cell(rows, 8, 2));
  const billets20 = parseAmount(cell(rows, 9, 2));
  const billets10 = parseAmount(cell(rows, 10, 2));
  const billets5 = parseAmount(cell(rows, 11, 2));
  const monnaie = parseAmount(cell(rows, 12, 2));
  const cashTotal = parseAmount(cell(rows, 13, 2));
  const fondCaisse = parseAmount(cell(rows, 14, 2));

  // Caisse Chèques (POS) — rows 10–14, col D=client, col E=amount; total at row 15 col E
  const caisseCheques: Array<{ client: string; montant: number | null }> = [];
  for (let r = 9; r <= 13; r++) {
    const client = trimText(cell(rows, r, 3));
    const montantRaw = cell(rows, r, 4);
    if (!client && montantRaw === null) continue;
    if (!client) continue;
    caisseCheques.push({ client, montant: parseAmount(montantRaw) });
  }
  const caisseChequesTotal = parseAmount(cell(rows, 14, 4));

  // Caisse CB (POS) — col F label, col G amount; rows 10/11 = Till / sancont, row 15 col G total
  const cbLabelTill = trimText(cell(rows, 9, 5));
  const cbAmtTill = parseAmount(cell(rows, 9, 6));
  const cbLabelSansCont = trimText(cell(rows, 10, 5));
  const cbAmtSansCont = parseAmount(cell(rows, 10, 6));
  const caisseCBTotal = parseAmount(cell(rows, 14, 6));
  const till = /till/i.test(cbLabelTill) ? cbAmtTill : null;
  const sansContact = /sancont|sanscont/i.test(cbLabelSansCont) ? cbAmtSansCont : null;

  // Différence Fond Caisse — col L row 15 (0-indexed: row 14, col 11)
  const differenceFondCaisse = parseAmount(cell(rows, 14, 11));

  // Dépenses — rows 10–14, col I=label, col L=amount; total at row 16 col L.
  // Stop one row before row 15: that row holds the "Différence Fond Caisse"
  // label in col I, which is captured separately above and shouldn't be
  // double-counted as an expense.
  const depenses: Array<{ label: string; amount: number | null }> = [];
  for (let r = 9; r <= 13; r++) {
    const label = trimText(cell(rows, r, 8));
    const amountRaw = cell(rows, r, 11);
    if (!label && amountRaw === null) continue;
    if (!label) continue;
    if (/^total$/i.test(label)) continue;
    if (/diff[ée]rence/i.test(label)) continue;
    depenses.push({ label, amount: parseAmount(amountRaw) });
  }
  const depensesTotal = parseAmount(cell(rows, 15, 11));

  // EXCEL totals (right block) — rows 4–7 col K
  const totals = {
    especes: parseAmount(cell(rows, 3, 10)),
    cheques: parseAmount(cell(rows, 4, 10)),
    carteCredit: parseAmount(cell(rows, 5, 10)),
    virement: parseAmount(cell(rows, 6, 10)),
  };

  // Remise Bancaire (SAP) — rows 4–6 col F
  const remiseBancaire = {
    especes: parseAmount(cell(rows, 3, 5)),
    cheques: parseAmount(cell(rows, 4, 5)),
    monnaieNonDeposee: parseAmount(cell(rows, 5, 5)),
    bankSlipRefs,
  };

  // LIVRAISONS — six sections stacked vertically, each prefixed by a
  // "CODE CLIENT | <section name>" header. Walks the entire LIVRAISONS area
  // (from the first header through the bottom of the sheet), switching the
  // active method on each header, and stops at trailing "TOTAL …" summary
  // rows that some sheets carry at the bottom.
  const livraisons: ParsedDay['livraisons'] = [];
  type Method =
    | 'cheque'
    | 'especes'
    | 'cbsite'
    | 'cbphone'
    | 'virement'
    | 'nonpaye';
  let currentMethod: Method = 'cheque';
  for (let r = 18; r < rows.length; r++) {
    const a = trimText(cell(rows, r, 0));
    const b = trimText(cell(rows, r, 1));

    // Section header: A="CODE CLIENT" + B identifies the method.
    if (/^code\s*client$/i.test(a)) {
      const id = normalizeText(b);
      if (id === 'paiementscheques') currentMethod = 'cheque';
      else if (id === 'paiementsespeces') currentMethod = 'especes';
      else if (id === 'paiementscbsite') currentMethod = 'cbsite';
      else if (id === 'paiementscbtelephone') currentMethod = 'cbphone';
      else if (id === 'virements') currentMethod = 'virement';
      else if (id === 'livraisonsnonpayees') currentMethod = 'nonpaye';
      // Unknown header — stay on the previous method; warn so a missing
      // mapping surfaces in the UI instead of silently misclassifying rows.
      else if (b) warnings.push(`Unknown LIVRAISONS section header "${b}" at row ${r + 1}`);
      continue;
    }

    // Bottom-of-sheet "TOTAL ESPECES / TOTAL CHEQUES / TOTAL CB Internet & Phone".
    // The cells often arrive without spaces ("TOTALESPECES"), so we can't rely
    // on a word boundary after "total".
    if (/^total/i.test(b)) break;

    const c = trimText(cell(rows, r, 2));
    const codeClient = a;
    const clientName = b || c;
    const montantRaw = cell(rows, r, 4); // col E
    const montant = parseAmount(montantRaw);
    const sapStatusRaw = trimText(cell(rows, r, 11)); // col L

    // Skip noise: blank rows (big gaps between sections), rows with no
    // identifier at all, or rows whose montant didn't parse (CB Phone in
    // particular sometimes carries date-formatted leftovers — they aren't
    // payments).
    if (!codeClient && !clientName) continue;
    if (montant === null) continue;

    const line: ParsedDay['livraisons'][number] = {
      codeClient,
      clientName,
      montant: null,
      banque: '',
      numero: '',
      remarques: '',
      sapStatusRaw,
      montantEspeces: null,
      montantCBSite: null,
      montantCBPhone: null,
      montantVirement: null,
      referenceVirement: '',
      nonPaye: false,
    };

    switch (currentMethod) {
      case 'cheque':
        line.montant = montant;
        line.banque = trimText(cell(rows, r, 5));
        line.numero = trimText(cell(rows, r, 6));
        line.remarques = trimText(cell(rows, r, 7));
        break;
      case 'especes':
        line.montantEspeces = montant;
        line.remarques = trimText(cell(rows, r, 5));
        break;
      case 'cbsite':
        line.montantCBSite = montant;
        line.remarques = trimText(cell(rows, r, 5));
        break;
      case 'cbphone':
        line.montantCBPhone = montant;
        line.remarques = trimText(cell(rows, r, 5));
        break;
      case 'virement':
        line.montantVirement = montant;
        line.referenceVirement = trimText(cell(rows, r, 5));
        line.remarques = line.referenceVirement;
        break;
      case 'nonpaye':
        // Non-payé carries the expected invoice amount in `montant` plus
        // the nonPaye flag. The flag (not the amount column) is what tells
        // downstream code "no payment row, no push, no Cheque tile".
        line.montant = montant;
        line.nonPaye = true;
        line.remarques = trimText(cell(rows, r, 5));
        break;
    }

    livraisons.push(line);
  }

  // Sanity warning — sum of POS cheques vs reported total.
  if (caisseChequesTotal !== null && caisseCheques.length > 0) {
    const sum = caisseCheques.reduce((a, c) => a + (c.montant ?? 0), 0);
    if (Math.abs(sum - caisseChequesTotal) > 0.05) {
      warnings.push(
        `Caisse Chèques sum ${sum.toFixed(2)} doesn't match printed total ${caisseChequesTotal.toFixed(2)}`,
      );
    }
  }

  return {
    sheetName,
    dayOfMonth,
    date,
    totals,
    remiseBancaire,
    caisseEspeces: {
      billets50,
      billets20,
      billets10,
      billets5,
      monnaie,
      total: cashTotal,
      fondCaisse,
    },
    caisseCheques,
    caisseChequesTotal,
    caisseCB: { till, sansContact, total: caisseCBTotal },
    differenceFondCaisse,
    depenses,
    depensesTotal,
    livraisons,
    parseWarnings: warnings,
  };
}

export interface WorkbookParseResult {
  monthLabel: string | null;
  year: number | null;
  month: number | null;
  days: ParsedDay[];
  errors: string[];
}

const SKIP_SHEETS = new Set(['empty sheet', 'TOTAL', 'TOTAL 2']);

export function parseDaybookWorkbook(
  buffer: Buffer,
  filename: string,
): WorkbookParseResult {
  const errors: string[] = [];
  const meta = parseMonthYearFromFilename(filename);
  if (!meta) {
    errors.push(
      `Couldn't infer month/year from filename "${filename}". Expected something like "Feuille de solde Avril 2026.xlsx".`,
    );
  }

  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const days: ParsedDay[] = [];

  for (const sheetName of wb.SheetNames) {
    if (SKIP_SHEETS.has(sheetName)) continue;
    const dayNum = Number(sheetName);
    if (!Number.isInteger(dayNum)) continue;
    const ws = wb.Sheets[sheetName];
    if (!ws || !ws['!ref']) continue;
    const rows = XLSX.utils.sheet_to_json(ws, {
      header: 1,
      defval: null,
      raw: false,
    }) as unknown[][];

    if (!meta) continue;
    const day = parseDay(rows, sheetName, meta.year, meta.month);
    if (!day) {
      errors.push(`Sheet "${sheetName}": invalid day for ${meta.label}.`);
      continue;
    }
    days.push(day);
  }

  return {
    monthLabel: meta?.label ?? null,
    year: meta?.year ?? null,
    month: meta?.month ?? null,
    days,
    errors,
  };
}
