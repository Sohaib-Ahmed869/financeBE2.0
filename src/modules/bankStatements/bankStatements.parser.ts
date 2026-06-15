import { parse } from 'csv-parse/sync';
import * as XLSX from 'xlsx';
import crypto from 'crypto';

/**
 * Generic CSV bank-statement parser. Banks publish wildly different CSVs;
 * we look for canonical column names (case- and accent-insensitive) and
 * fall back to a positional heuristic when none match.
 *
 * Output:
 *   - operationDate (date)
 *   - amount (signed; positive = credit, negative = debit)
 *   - description / counterparty / reference
 *   - balanceAfter when present
 *   - envelopeNumber — extracted from description ("NO00…" deposit-slip refs)
 *
 * When you have actual statements from BRED / LCL / BNP / SG / CIC etc,
 * add bank-specific fast paths keyed off a header signature.
 */

export interface ParsedBankLine {
  operationDate: string; // YYYY-MM-DD
  valueDate: string | null;
  amount: number;
  direction: 'credit' | 'debit';
  description: string;
  counterparty: string;
  reference: string;
  balanceAfter: number | null;
  envelopeNumber: string | null;
  fingerprint: string;
}

export interface ParsedBankStatement {
  lines: ParsedBankLine[];
  warnings: string[];
  detectedDelimiter: string;
}

const norm = (s: unknown): string =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();

function parseAmount(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') return raw;
  let s = String(raw).trim();
  if (!s) return null;
  const negative = /^[(-]/.test(s) || /\)$/.test(s);
  s = s
    .replace(/[€$()]/g, '')
    .replace(/\s/g, '')
    .replace(/(?<=\d),(?=\d{3}(\D|$))/g, '')
    .replace(',', '.');
  let n = Number(s);
  if (!Number.isFinite(n)) return null;
  if (negative && n > 0) n = -n;
  return n;
}

function parseDate(raw: unknown): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  // FR
  let m = s.match(/^(\d{2})[/-](\d{2})[/-](\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  // ISO
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

const EXTRACT_ENVELOPE_RE = /\bNO\s*\d{2,}[\d.,]*\b/i;

function extractEnvelope(desc: string): string | null {
  const m = desc.match(EXTRACT_ENVELOPE_RE);
  return m ? m[0].replace(/\s+/g, '') : null;
}

const COL = {
  date: /^(date|operation\s*date|booking\s*date)/,
  valueDate: /^(value\s*date|date\s*valeur)/,
  description: /^(description|libelle|libellé|memo|details?)/,
  counterparty: /^(counterparty|beneficiary|tiers|emetteur|payee|payer)/,
  reference: /^(reference|ref|transaction\s*id)/,
  amount: /^(amount|montant|operation)/,
  credit: /^(credit|cr|deposits?)/,
  debit: /^(debit|dr|withdraw)/,
  balance: /^(balance|solde)/,
};

function pickColumn(header: string[], pattern: RegExp): number {
  for (let i = 0; i < header.length; i++) {
    if (pattern.test(norm(header[i]))) return i;
  }
  return -1;
}

function fingerprint(line: Omit<ParsedBankLine, 'fingerprint'>): string {
  return crypto
    .createHash('sha256')
    .update(
      [
        line.operationDate,
        line.amount.toFixed(2),
        line.description.trim(),
        line.reference.trim(),
      ].join('|'),
    )
    .digest('hex');
}

export function parseBankStatementCsv(buffer: Buffer): ParsedBankStatement {
  const text = buffer.toString('utf8');
  const warnings: string[] = [];
  let records: string[][] = [];
  let detectedDelimiter = ',';
  for (const delim of [';', ',', '\t']) {
    try {
      const parsed = parse(text, {
        delimiter: delim,
        relax_column_count: true,
        skip_empty_lines: true,
      }) as string[][];
      if (parsed.length > 0 && parsed[0].length > 1) {
        records = parsed;
        detectedDelimiter = delim;
        break;
      }
    } catch {
      // try next delimiter
    }
  }

  if (records.length === 0) {
    warnings.push('CSV could not be parsed with any common delimiter.');
    return { lines: [], warnings, detectedDelimiter };
  }

  // Find header row.
  let headerIdx = -1;
  for (let i = 0; i < Math.min(records.length, 10); i++) {
    const r = records[i];
    const hits =
      [COL.date, COL.amount, COL.credit, COL.debit, COL.balance]
        .reduce((a, p) => a + (r.some((c) => p.test(norm(c))) ? 1 : 0), 0);
    if (hits >= 2) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) {
    warnings.push('No header row recognized — falling back to positional parsing (first 4 columns).');
    headerIdx = -1;
  }

  const header = headerIdx >= 0 ? records[headerIdx] : [];
  const idx = {
    date: pickColumn(header, COL.date),
    valueDate: pickColumn(header, COL.valueDate),
    description: pickColumn(header, COL.description),
    counterparty: pickColumn(header, COL.counterparty),
    reference: pickColumn(header, COL.reference),
    amount: pickColumn(header, COL.amount),
    credit: pickColumn(header, COL.credit),
    debit: pickColumn(header, COL.debit),
    balance: pickColumn(header, COL.balance),
  };

  const lines: ParsedBankLine[] = [];
  for (let i = headerIdx + 1; i < records.length; i++) {
    const r = records[i];
    if (!r) continue;

    const dateRaw = idx.date >= 0 ? r[idx.date] : r[0];
    const operationDate = parseDate(dateRaw);
    if (!operationDate) continue; // not a data row

    const description =
      idx.description >= 0
        ? String(r[idx.description] ?? '').trim()
        : (r[1] ?? '').toString().trim();

    let amount: number | null = null;
    if (idx.amount >= 0) {
      amount = parseAmount(r[idx.amount]);
    } else if (idx.credit >= 0 || idx.debit >= 0) {
      const cr = idx.credit >= 0 ? parseAmount(r[idx.credit]) : null;
      const dr = idx.debit >= 0 ? parseAmount(r[idx.debit]) : null;
      if (cr && cr !== 0) amount = Math.abs(cr);
      else if (dr && dr !== 0) amount = -Math.abs(dr);
    } else {
      // Last numeric column heuristic.
      for (let j = r.length - 1; j >= 0; j--) {
        const v = parseAmount(r[j]);
        if (v !== null && v !== 0) {
          amount = v;
          break;
        }
      }
    }
    if (amount === null) continue;

    const counterparty =
      idx.counterparty >= 0 ? String(r[idx.counterparty] ?? '').trim() : '';
    const reference = idx.reference >= 0 ? String(r[idx.reference] ?? '').trim() : '';
    const balance = idx.balance >= 0 ? parseAmount(r[idx.balance]) : null;
    const valueDate = idx.valueDate >= 0 ? parseDate(r[idx.valueDate]) : null;

    const partial: Omit<ParsedBankLine, 'fingerprint'> = {
      operationDate,
      valueDate,
      amount,
      direction: amount >= 0 ? 'credit' : 'debit',
      description,
      counterparty,
      reference,
      balanceAfter: balance,
      envelopeNumber: extractEnvelope(description),
    };
    lines.push({ ...partial, fingerprint: fingerprint(partial) });
  }

  return { lines, warnings, detectedDelimiter };
}

/* -------------------------------------------------------------------------- */
/* OFX (SGML) — BRED / SG export                                              */
/* -------------------------------------------------------------------------- */

/** Pull an unclosed OFX-SGML tag value (runs until the next `<` or newline). */
function ofxTag(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}>([^<\\r\\n]*)`, 'i'));
  return m ? m[1].trim() : '';
}

/** YYYYMMDD[hhmmss…] → YYYY-MM-DD */
function ofxDate(raw: string): string | null {
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** Best-effort counterparty from an OFX memo: the name after POUR:/DE:/BENEF. */
function counterpartyFromMemo(text: string): string {
  const m = text.match(
    /\b(?:POUR|DE|BENEF(?:ICIAIRE)?|EMETTEUR)\s*:?\s*([^:]+?)(?:\s{2,}|\s+(?:REF|DATE|MOTIF|ID|REMISE|CPT|BQ|SG|BNPA)\b|$)/i,
  );
  return m ? m[1].replace(/\s+/g, ' ').trim().slice(0, 80) : '';
}

/**
 * Parse a BRED / SG OFX-SGML statement. Tags are unclosed; transactions live in
 * <STMTTRN> blocks under <BANKTRANLIST>. TRNAMT is already signed.
 */
export function parseBankStatementOfx(buffer: Buffer): ParsedBankStatement {
  // OFX header here is CHARSET:1252 — latin1 is the closest Node built-in.
  const text = buffer.toString('latin1');
  const warnings: string[] = [];
  const blocks = text.split(/<STMTTRN>/i).slice(1);
  if (blocks.length === 0) {
    warnings.push('No <STMTTRN> transactions found — is this a valid OFX file?');
    return { lines: [], warnings, detectedDelimiter: 'ofx' };
  }

  const lines: ParsedBankLine[] = [];
  for (const raw of blocks) {
    const block = raw.split(/<\/STMTTRN>/i)[0];
    const operationDate = ofxDate(ofxTag(block, 'DTPOSTED'));
    if (!operationDate) continue;
    const amount = parseAmount(ofxTag(block, 'TRNAMT'));
    if (amount === null) continue;

    const name = ofxTag(block, 'NAME');
    const memo = ofxTag(block, 'MEMO');
    const description = [name, memo].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    const reference = ofxTag(block, 'FITID') || ofxTag(block, 'CHECKNUM');
    const counterparty = counterpartyFromMemo(memo) || counterpartyFromMemo(name);

    const partial: Omit<ParsedBankLine, 'fingerprint'> = {
      operationDate,
      valueDate: ofxDate(ofxTag(block, 'DTUSER')) || null,
      amount,
      direction: amount >= 0 ? 'credit' : 'debit',
      description,
      counterparty,
      reference,
      balanceAfter: null,
      envelopeNumber: extractEnvelope(description),
    };
    lines.push({ ...partial, fingerprint: fingerprint(partial) });
  }

  if (lines.length === 0) warnings.push('OFX parsed but yielded no usable transactions.');
  return { lines, warnings, detectedDelimiter: 'ofx' };
}

/* -------------------------------------------------------------------------- */
/* XLS / XLSX — BRED / SG "Operations" export                                 */
/* -------------------------------------------------------------------------- */

/**
 * Parse a BRED / SG account statement exported as .xls/.xlsx. The "Operations"
 * sheet has columns: Date d'opération | Référence | Type de l'opération |
 * Montant (signed, FR format) | Commentaire | Détail 1..8. The operation type
 * and detail lines are folded into the description so the categoriser can read
 * them ("VERSEMENT D'ESPECE", "REMISE CHEQUE(S)", "REMISE CARTE BANCAIRE", …).
 */
export function parseBankStatementXls(buffer: Buffer): ParsedBankStatement {
  const warnings: string[] = [];
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) {
    warnings.push('Workbook has no sheets.');
    return { lines: [], warnings, detectedDelimiter: 'xls' };
  }
  const rows = XLSX.utils.sheet_to_json<string[]>(sheet, {
    header: 1,
    raw: false,
    defval: '',
  });

  // Locate the header row (must carry a date column and an amount column).
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const r = rows[i] ?? [];
    const hasDate = r.some((c) => COL.date.test(norm(c)));
    const hasAmount = r.some((c) => COL.amount.test(norm(c)));
    if (hasDate && hasAmount) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) {
    warnings.push('No recognizable header row (need a date + amount column).');
    return { lines: [], warnings, detectedDelimiter: 'xls' };
  }

  const header = rows[headerIdx].map((c) => norm(c));
  const findCol = (pat: RegExp): number => header.findIndex((h) => pat.test(h));
  const TYPE_RE = /^type\b/;
  const idx = {
    date: findCol(COL.date),
    valueDate: findCol(COL.valueDate),
    reference: findCol(COL.reference),
    type: findCol(TYPE_RE),
    amount: findCol(COL.amount),
    balance: findCol(COL.balance),
  };
  // Detail/comment columns: everything that looks like a free-text label.
  const detailCols: number[] = [];
  header.forEach((h, i) => {
    if (/^(commentaire|detail|libelle|libelle|description|memo)/.test(h)) detailCols.push(i);
  });

  const lines: ParsedBankLine[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const operationDate = parseDate(idx.date >= 0 ? r[idx.date] : r[0]);
    if (!operationDate) continue;
    const amount = parseAmount(idx.amount >= 0 ? r[idx.amount] : '');
    if (amount === null) continue;

    const type = idx.type >= 0 ? String(r[idx.type] ?? '').trim() : '';
    const details = detailCols
      .map((c) => String(r[c] ?? '').trim())
      .filter(Boolean);
    const description = [type, ...details].join(' | ').replace(/\s+/g, ' ').trim();
    // First non-empty detail is the counterparty name on BRED/SG exports.
    const counterparty = (details[0] ?? '').slice(0, 80);
    const reference = idx.reference >= 0 ? String(r[idx.reference] ?? '').trim() : '';
    const balance = idx.balance >= 0 ? parseAmount(r[idx.balance]) : null;

    const partial: Omit<ParsedBankLine, 'fingerprint'> = {
      operationDate,
      valueDate: idx.valueDate >= 0 ? parseDate(r[idx.valueDate]) : null,
      amount,
      direction: amount >= 0 ? 'credit' : 'debit',
      description,
      counterparty,
      reference,
      balanceAfter: balance,
      envelopeNumber: extractEnvelope(description),
    };
    lines.push({ ...partial, fingerprint: fingerprint(partial) });
  }

  if (lines.length === 0) warnings.push('XLS parsed but yielded no usable rows.');
  return { lines, warnings, detectedDelimiter: 'xls' };
}

/* -------------------------------------------------------------------------- */
/* Dispatcher — pick a parser by extension / content sniff                    */
/* -------------------------------------------------------------------------- */

export function parseBankStatement(file: {
  originalname: string;
  buffer: Buffer;
}): ParsedBankStatement {
  const name = (file.originalname || '').toLowerCase();
  const head = file.buffer.subarray(0, 256).toString('latin1');
  if (name.endsWith('.ofx') || /OFXHEADER|<OFX>/i.test(head)) {
    return parseBankStatementOfx(file.buffer);
  }
  // XLSX = ZIP (PK\x03\x04); legacy XLS = OLE2 (\xD0\xCF\x11\xE0).
  const isZip = file.buffer[0] === 0x50 && file.buffer[1] === 0x4b;
  const isOle = file.buffer[0] === 0xd0 && file.buffer[1] === 0xcf;
  if (name.endsWith('.xls') || name.endsWith('.xlsx') || isZip || isOle) {
    return parseBankStatementXls(file.buffer);
  }
  return parseBankStatementCsv(file.buffer);
}
