import { parse } from 'csv-parse/sync';
import * as XLSX from 'xlsx';

/**
 * Z-report parser. Two file shapes are supported:
 *
 *  1. **XLSX export** (the till's new format — confirmed against Idris's
 *     14/05/2026 sample). One row per receipt with separate CASH / CHANGE /
 *     ACCOUNT / CCARD / CHEQUE columns, then a TOTALS row, then a "Z Summary"
 *     block carrying `In Audit` / `In Drawer` / `Discrepancy` per method and
 *     a final `Net Discrepancy`.
 *  2. **Legacy CSV** (one receipt per line with a `method` column). Kept for
 *     back-compat with older till exports.
 *
 * The two paths converge on the same `ParsedZReport` shape so downstream
 * consumers don't care which file landed.
 */

export interface ZReportRow {
  receiptRef: string;
  time: string;
  cardCode: string;
  cardName: string;
  method: 'cash' | 'cheque' | 'card' | 'other';
  amount: number;
  raw: Record<string, unknown>;
}

/** A POS receipt where part of the total was posted to the customer's SAP
 * A/R account (e.g. credit-on-account given at the till). Not a POS receipt
 * per se — we surface them so the daybook can flag them separately. */
export interface ZReportAccountReceipt {
  receiptRef: string;
  cardCode: string;
  cardName: string;
  amount: number;
}

export interface DrawerByMethod {
  cash: number | null;
  card: number | null;
  cheque: number | null;
}

export interface ParsedZReport {
  /** "YYYY-MM-DD" — best-effort detection from the file. */
  date: string | null;
  /** Per-method totals of POS receipts (audit numbers). */
  totals: {
    cash: number;
    cheque: number;
    card: number;
    other: number;
  };
  /**
   * Legacy single-field counted cash — equals `drawerCounted.cash`. Retained so
   * the rest of the codebase (counted-cash editor, drawerGap calc) keeps
   * working unchanged.
   */
  countedCash: number | null;
  float: number | null;
  expenses: number;
  expenseBreakdown: Array<{ label: string; amount: number }>;
  rows: ZReportRow[];
  warnings: string[];

  /** What the till's audit says was received per method. */
  drawerAudit: DrawerByMethod;
  /** What was physically counted in the drawer per method. */
  drawerCounted: DrawerByMethod;
  /** counted − audit per method. Negative = short. */
  drawerDiscrepancy: DrawerByMethod;
  /** Net discrepancy across all methods (from the Z summary footer). */
  netDiscrepancy: number | null;
  /** Customers whose receipts included an A/R "ACCOUNT" portion. */
  accountReceipts: ZReportAccountReceipt[];
}

const norm = (s: unknown): string =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();

function parseAmount(raw: unknown): number {
  if (raw === null || raw === undefined || raw === '') return 0;
  if (typeof raw === 'number') return raw;
  const s = String(raw)
    .replace(/[€$\s]/g, '')
    .replace(/(?<=\d),(?=\d{3}(\D|$))/g, '') // 1,234.56 thousands
    .replace(',', '.'); // FR decimal
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function detectMethod(raw: string): ZReportRow['method'] {
  const v = norm(raw);
  if (/cash|espece|cb cash/.test(v)) return 'cash';
  if (/cheque|chq/.test(v)) return 'cheque';
  if (/card|carte|cb|visa|amex|mastercard/.test(v)) return 'card';
  return 'other';
}

function detectDateFromString(s: string): string | null {
  const fr = s.match(/(\d{2})[/-](\d{2})[/-](\d{4})/);
  if (fr) return `${fr[3]}-${fr[2]}-${fr[1]}`;
  const iso = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  return null;
}

function emptyDrawer(): DrawerByMethod {
  return { cash: null, card: null, cheque: null };
}

function emptyResult(warnings: string[]): ParsedZReport {
  return {
    date: null,
    totals: { cash: 0, cheque: 0, card: 0, other: 0 },
    countedCash: null,
    float: null,
    expenses: 0,
    expenseBreakdown: [],
    rows: [],
    warnings,
    drawerAudit: emptyDrawer(),
    drawerCounted: emptyDrawer(),
    drawerDiscrepancy: emptyDrawer(),
    netDiscrepancy: null,
    accountReceipts: [],
  };
}

/** XLSX (zipped) or legacy XLS (OLE2 compound) — both go through the `xlsx` lib. */
function isExcelBuffer(buf: Buffer): boolean {
  if (buf.length < 4) return false;
  if (buf[0] === 0x50 && buf[1] === 0x4b) return true; // PK\x03\x04 / PK\x05\x06
  if (buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) return true;
  return false;
}

export function parseZReport(buffer: Buffer): ParsedZReport {
  if (isExcelBuffer(buffer)) return parseExcel(buffer);
  return parseCsvLegacy(buffer);
}

/* -------------------------------------------------------------------------
 * XLSX path — Idris's new format (14/05/2026 sample)
 * -----------------------------------------------------------------------*/

function parseExcel(buffer: Buffer): ParsedZReport {
  const warnings: string[] = [];
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`XLSX read failed: ${msg}`);
    return emptyResult(warnings);
  }

  // Pick the first non-empty sheet.
  let sheetName: string | undefined;
  for (const n of wb.SheetNames) {
    const ws = wb.Sheets[n];
    if (ws && ws['!ref'] && ws['!ref'] !== 'A1') {
      sheetName = n;
      break;
    }
  }
  if (!sheetName) {
    warnings.push('Workbook has no populated sheets');
    return emptyResult(warnings);
  }
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<string[]>(ws, {
    header: 1,
    raw: false,
    defval: '',
  }) as unknown as string[][];

  // Date — typically "From Date: DD/MM/YYYY" in the file's preamble.
  let date: string | null = null;
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    for (const cell of rows[i] ?? []) {
      const d = detectDateFromString(String(cell ?? ''));
      if (d) {
        date = d;
        break;
      }
    }
    if (date) break;
  }

  // Find the column header row — contains CARDCODE *and* RECEIPT.
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const r = rows[i] ?? [];
    const cells = r.map((c) => norm(c));
    if (cells.includes('cardcode') && cells.includes('receipt')) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) {
    warnings.push('Header row (CARDCODE / RECEIPT) not found — nothing to parse');
    return { ...emptyResult(warnings), date };
  }
  const header = rows[headerIdx];
  const col = (name: string): number => header.findIndex((h) => norm(h) === name);
  const idx = {
    cardCode: col('cardcode'),
    customer: col('customer'),
    date: col('date'),
    receipt: col('receipt'),
    operator: col('operator'),
    total: col('total'),
    cash: col('cash'),
    change: col('change'),
    account: col('account'),
    ccard: col('ccard'),
    cheque: col('cheque'),
  };

  const zrows: ZReportRow[] = [];
  const accountReceipts: ZReportAccountReceipt[] = [];

  // The receipts block ends at the first "*TOTALS" subtotal row (`ARINV TOTALS`,
  // `ORDER TOTALS`, `PAYALLOC TOTALS`, etc). The till also injects float /
  // expense lines (`CASH ADD FLOAT`, expense memos with negative cash) between
  // the subtotal block and the final `TOTALS` row. After receipts, we walk
  // forward to find the bare `TOTALS` row — that's the till's authoritative
  // post-float-and-expenses audit.
  let receiptsEndIdx = rows.length;
  let totalsRowIdx = -1;
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i] ?? [];
    const firstCell = norm(r[0]);
    if (/\btotals?\b/.test(firstCell)) {
      receiptsEndIdx = i;
      break;
    }
    if (r.every((c) => String(c ?? '').trim() === '')) continue;

    const cardCode = idx.cardCode >= 0 ? String(r[idx.cardCode] ?? '').trim() : '';
    if (!cardCode) continue; // not a receipt row
    const cardName = idx.customer >= 0 ? String(r[idx.customer] ?? '').trim() : '';
    const receiptRef =
      idx.receipt >= 0 ? String(r[idx.receipt] ?? '').trim() || `row-${i}` : `row-${i}`;

    const cash = idx.cash >= 0 ? parseAmount(r[idx.cash]) : 0;
    const change = idx.change >= 0 ? parseAmount(r[idx.change]) : 0;
    const card = idx.ccard >= 0 ? parseAmount(r[idx.ccard]) : 0;
    const cheque = idx.cheque >= 0 ? parseAmount(r[idx.cheque]) : 0;
    const account = idx.account >= 0 ? parseAmount(r[idx.account]) : 0;

    // CHANGE is negative when given back; cash actually received = CASH + CHANGE.
    const cashReceived = +(cash + change).toFixed(2);
    if (cashReceived > 0.005) {
      zrows.push({
        receiptRef,
        time: '',
        cardCode,
        cardName,
        method: 'cash',
        amount: cashReceived,
        raw: { cashTendered: cash, change },
      });
    }
    if (card > 0.005) {
      zrows.push({
        receiptRef,
        time: '',
        cardCode,
        cardName,
        method: 'card',
        amount: +card.toFixed(2),
        raw: {},
      });
    }
    if (cheque > 0.005) {
      zrows.push({
        receiptRef,
        time: '',
        cardCode,
        cardName,
        method: 'cheque',
        amount: +cheque.toFixed(2),
        raw: {},
      });
    }
    if (account > 0.005) {
      accountReceipts.push({
        receiptRef,
        cardCode,
        cardName,
        amount: +account.toFixed(2),
      });
    }
  }

  // Locate the bare TOTALS row (after all the *_TOTALS siblings) so we can
  // (a) bound the float / expenses scan and (b) read the till's audit.
  for (let i = receiptsEndIdx; i < rows.length; i++) {
    if (/^totals?$/.test(norm(rows[i]?.[0]))) {
      totalsRowIdx = i;
      break;
    }
  }

  // Walk the rows between the receipts block and the final TOTALS line for
  // float ("CASH ADD FLOAT") and expense memos (negative cash, with a label
  // in CUSTOMER).
  let float: number | null = null;
  let expenses = 0;
  const expenseBreakdown: Array<{ label: string; amount: number }> = [];
  if (idx.cash >= 0) {
    const stopAt = totalsRowIdx > receiptsEndIdx ? totalsRowIdx : rows.length;
    for (let i = receiptsEndIdx + 1; i < stopAt; i++) {
      const r = rows[i] ?? [];
      const firstCell = norm(r[0]);
      if (/\btotals?\b/.test(firstCell)) continue; // skip sibling subtotal rows
      const label = String(r[idx.customer >= 0 ? idx.customer : 1] ?? '').trim();
      const cashVal = parseAmount(r[idx.cash]);
      if (!label) continue;
      if (/float|fond\s*caisse|add\s*float/i.test(label)) {
        if (cashVal !== 0) float = (float ?? 0) + cashVal;
        continue;
      }
      if (cashVal < 0) {
        expenses += -cashVal;
        expenseBreakdown.push({ label, amount: +(-cashVal).toFixed(2) });
      }
    }
    if (float !== null) float = +float.toFixed(2);
    expenses = +expenses.toFixed(2);
  }

  // Totals — prefer the TOTALS row's numbers (the till's authoritative audit
  // net of float and expenses). Falls back to a roll-up of receipt rows when
  // the TOTALS row is missing.
  const totals = { cash: 0, cheque: 0, card: 0, other: 0 };
  for (const r of zrows) totals[r.method] += r.amount;
  if (totalsRowIdx >= 0) {
    const tr = rows[totalsRowIdx];
    const tCash = (idx.cash >= 0 ? parseAmount(tr[idx.cash]) : 0)
      + (idx.change >= 0 ? parseAmount(tr[idx.change]) : 0);
    const tCard = idx.ccard >= 0 ? parseAmount(tr[idx.ccard]) : 0;
    const tCheque = idx.cheque >= 0 ? parseAmount(tr[idx.cheque]) : 0;
    if (tCash || tCard || tCheque) {
      totals.cash = +tCash.toFixed(2);
      totals.card = +tCard.toFixed(2);
      totals.cheque = +tCheque.toFixed(2);
    }
  }

  // Z Summary block — single-string labels like `"    In Audit    : 8017.38"`.
  // Walk every cell looking for them so we don't depend on a specific column.
  const audit: DrawerByMethod = emptyDrawer();
  const counted: DrawerByMethod = emptyDrawer();
  const disc: DrawerByMethod = emptyDrawer();
  let net: number | null = null;
  let section: 'cash' | 'card' | 'cheque' | null = null;
  const startSummary = totalsRowIdx >= 0 ? totalsRowIdx + 1 : headerIdx + 1;
  for (let i = startSummary; i < rows.length; i++) {
    for (const cell of rows[i] ?? []) {
      const s = String(cell ?? '').trim();
      if (!s) continue;
      if (/^z\s*summary$/i.test(s)) {
        section = null;
        continue;
      }
      if (/^cash$/i.test(s)) {
        section = 'cash';
        continue;
      }
      if (/^card$/i.test(s)) {
        section = 'card';
        continue;
      }
      if (/^cheque$/i.test(s)) {
        section = 'cheque';
        continue;
      }
      const netM = s.match(/^net\s+discrepancy\s*:\s*(-?[\d.,]+)/i);
      if (netM) {
        net = parseAmount(netM[1]);
        continue;
      }
      if (!section) continue;
      const auditM = s.match(/^in\s+audit\s*:\s*(-?[\d.,]+)/i);
      if (auditM) {
        audit[section] = parseAmount(auditM[1]);
        continue;
      }
      const drawerM = s.match(/^in\s+drawer\s*:\s*(-?[\d.,]+)/i);
      if (drawerM) {
        counted[section] = parseAmount(drawerM[1]);
        continue;
      }
      const discM = s.match(/^discrepancy\s*:\s*(-?[\d.,]+)/i);
      if (discM) {
        disc[section] = parseAmount(discM[1]);
        continue;
      }
    }
  }

  // If the Z Summary block was missing, fall back to totals.
  if (audit.cash === null) audit.cash = totals.cash || null;
  if (audit.card === null) audit.card = totals.card || null;
  if (audit.cheque === null) audit.cheque = totals.cheque || null;

  return {
    date,
    totals,
    countedCash: counted.cash,
    float,
    expenses,
    expenseBreakdown,
    rows: zrows,
    warnings,
    drawerAudit: audit,
    drawerCounted: counted,
    drawerDiscrepancy: disc,
    netDiscrepancy: net,
    accountReceipts,
  };
}

/* -------------------------------------------------------------------------
 * Legacy CSV path
 * -----------------------------------------------------------------------*/

const COL_PATTERNS = {
  receipt: /^(receipt|recu|ticket|num|n[°o])/,
  time: /^(time|heure)/,
  cardCode: /^(cardcode|code\s*client|client\s*code|cust)/,
  cardName: /^(cardname|client|customer|name)/,
  method: /^(method|paiement|payment|type|mode)/,
  amount: /^(amount|montant|total|sum)/,
};

function pickColumn(header: string[], pattern: RegExp): number {
  for (let i = 0; i < header.length; i++) {
    if (pattern.test(norm(header[i]))) return i;
  }
  return -1;
}

function parseCsvLegacy(buffer: Buffer): ParsedZReport {
  const text = buffer.toString('utf8');
  const warnings: string[] = [];

  let records: string[][];
  try {
    records = parse(text, {
      delimiter: [',', ';', '\t'],
      relax_column_count: true,
      skip_empty_lines: true,
    }) as string[][];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warnings.push(`CSV parse failed: ${message}`);
    return { ...emptyResult(warnings), date: detectDateFromString(text) };
  }

  let headerIdx = -1;
  for (let i = 0; i < Math.min(records.length, 30); i++) {
    const r = records[i];
    if (!r) continue;
    const hits = Object.values(COL_PATTERNS).reduce(
      (a, p) => a + (r.some((c) => p.test(norm(c))) ? 1 : 0),
      0,
    );
    if (hits >= 3) {
      headerIdx = i;
      break;
    }
  }

  const header = headerIdx >= 0 ? records[headerIdx] : [];
  const idx = {
    receipt: pickColumn(header, COL_PATTERNS.receipt),
    time: pickColumn(header, COL_PATTERNS.time),
    cardCode: pickColumn(header, COL_PATTERNS.cardCode),
    cardName: pickColumn(header, COL_PATTERNS.cardName),
    method: pickColumn(header, COL_PATTERNS.method),
    amount: pickColumn(header, COL_PATTERNS.amount),
  };

  const rows: ZReportRow[] = [];
  if (headerIdx >= 0) {
    for (let i = headerIdx + 1; i < records.length; i++) {
      const r = records[i];
      if (!r) continue;
      const receiptRef = idx.receipt >= 0 ? String(r[idx.receipt] ?? '').trim() : '';
      const firstCell = norm(r[0]);
      if (/^(total|depense|fond\s*caisse|float|count(ed)?)/.test(firstCell)) break;
      if (!receiptRef && !r.some((c) => parseAmount(c) > 0)) continue;

      rows.push({
        receiptRef: receiptRef || `row-${i}`,
        time: idx.time >= 0 ? String(r[idx.time] ?? '').trim() : '',
        cardCode: idx.cardCode >= 0 ? String(r[idx.cardCode] ?? '').trim() : '',
        cardName: idx.cardName >= 0 ? String(r[idx.cardName] ?? '').trim() : '',
        method: idx.method >= 0 ? detectMethod(String(r[idx.method] ?? '')) : 'other',
        amount: idx.amount >= 0 ? parseAmount(r[idx.amount]) : 0,
        raw: header.reduce<Record<string, unknown>>((acc, h, j) => {
          if (h) acc[h] = r[j];
          return acc;
        }, {}),
      });
    }
  } else {
    warnings.push('No header row recognized — treating every numeric row as a generic line.');
  }

  const totals = { cash: 0, cheque: 0, card: 0, other: 0 };
  for (const r of rows) totals[r.method] += r.amount;

  let countedCash: number | null = null;
  let float: number | null = null;
  let expenses = 0;
  const expenseBreakdown: Array<{ label: string; amount: number }> = [];
  for (const r of records) {
    if (!r) continue;
    const k = norm(r[0]);
    const numeric = r.slice(1).map((c) => parseAmount(c)).find((n) => n !== 0);
    if (numeric === undefined) continue;
    if (/count(ed)?(\s*cash)?|esp[èe]ces?\s*compt/.test(k)) countedCash = numeric;
    else if (/float|fond\s*caisse/.test(k)) float = numeric;
    else if (/depense|expense|essence|gasoil/.test(k)) {
      expenses += numeric;
      expenseBreakdown.push({ label: String(r[0]).trim(), amount: numeric });
    } else if (/^total\s*cash|esp[èe]ces?\s*total/.test(k)) totals.cash = numeric;
    else if (/^total\s*cheque|cheques?\s*total/.test(k)) totals.cheque = numeric;
    else if (/^total\s*(card|cb|carte)/.test(k)) totals.card = numeric;
  }

  return {
    date: detectDateFromString(text),
    totals,
    countedCash,
    float,
    expenses,
    expenseBreakdown,
    rows,
    warnings,
    drawerAudit: {
      cash: totals.cash || null,
      card: totals.card || null,
      cheque: totals.cheque || null,
    },
    drawerCounted: { cash: countedCash, card: null, cheque: null },
    drawerDiscrepancy:
      countedCash !== null && totals.cash
        ? { cash: +(countedCash - totals.cash).toFixed(2), card: null, cheque: null }
        : emptyDrawer(),
    netDiscrepancy:
      countedCash !== null && totals.cash !== null
        ? +(countedCash - totals.cash).toFixed(2)
        : null,
    accountReceipts: [],
  };
}
