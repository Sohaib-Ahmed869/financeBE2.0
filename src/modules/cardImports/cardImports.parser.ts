import { parse } from 'csv-parse/sync';
import * as XLSX from 'xlsx';

/**
 * Parsers for the three third-party payment export files Idris's team
 * receives monthly:
 *
 *   - **Sogecommerce per-transaction** (`Listing_transactions_remisees.xls`):
 *     one customer card transaction per row, with masked PAN, payer name,
 *     amount, and the daily remise (settlement) number. Used to reconcile
 *     each card payment against an open invoice.
 *
 *   - **Sogecommerce daily remises** (`Listing_remises.xls`): one daily
 *     settlement per row — these settlement totals match the corresponding
 *     bank-statement credit line one-to-one (date + amount). Useful for
 *     bank-statement reconciliation.
 *
 *   - **PayPal** (`PAYPAL FEB.CSV`): UTF-8 BOM, semicolon-quoted CSV with
 *     interleaved "Paiement DCC" (customer payment), "Paiement standard"
 *     (PayPal fee deduction), and "Virement standard" (sweep to bank) rows.
 *     We extract only the customer payment rows.
 */

export interface CardImportRow {
  /** Stable id from the provider — drives idempotency on re-uploads. */
  transactionId: string;
  date: string; // ISO YYYY-MM-DD
  /** Settled net amount in EUR (positive). */
  amount: number;
  /** "VISA" / "MASTERCARD" / "CB" / "PayPal" etc — provider-side classification. */
  method: string;
  payerName: string;
  payerEmail: string;
  /** Masked PAN for card payments (e.g. "513778XXXXXX3558") — null for PayPal. */
  maskedPan: string | null;
  /** Daily settlement / batch reference — null when not applicable. */
  remiseNumber: string | null;
  /** Original row payload — kept for the UI to show alongside the normalised view. */
  raw: Record<string, unknown>;
}

export interface CardImportParseResult {
  provider: 'sogecommerce-site' | 'sogecommerce-phone' | 'paypal';
  rows: CardImportRow[];
  warnings: string[];
  periodStart: string | null;
  periodEnd: string | null;
  totalAmount: number;
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
    .replace(/(?<=\d),(?=\d{3}(\D|$))/g, '')
    .replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function parseDateFr(raw: unknown): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  let m = s.match(/^(\d{2})[/-](\d{2})[/-](\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

/* -------------------------------------------------------------------------
 * Sogecommerce — per-transaction listing
 * -----------------------------------------------------------------------*/

/**
 * Columns in the file:
 *   Transaction, Commande, Type, Date du paiement, Statut, Montant du paiement,
 *   Date remise, N° remise, Rang (NLSA), Statut rapprochement, Motif impayé,
 *   Moyen de paiement, Wallet, Numéro de carte, Date d'expiration, ...
 */
export function parseSogecommerceTransactions(
  buffer: Buffer,
  options: { defaultChannel?: 'site' | 'phone' } = {},
): CardImportParseResult {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) {
    return {
      provider: options.defaultChannel === 'phone' ? 'sogecommerce-phone' : 'sogecommerce-site',
      rows: [],
      warnings: ['Workbook has no sheets'],
      periodStart: null,
      periodEnd: null,
      totalAmount: 0,
    };
  }
  const rows = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[sheetName], {
    header: 1,
    raw: false,
    defval: '',
  }) as unknown as string[][];

  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    if (rows[i]?.some((c) => norm(c) === 'transaction') && rows[i]?.some((c) => norm(c) === 'commande')) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) {
    return {
      provider: options.defaultChannel === 'phone' ? 'sogecommerce-phone' : 'sogecommerce-site',
      rows: [],
      warnings: ['Sogecommerce header row not found'],
      periodStart: null,
      periodEnd: null,
      totalAmount: 0,
    };
  }
  const header = rows[headerIdx];
  const col = (name: string) => header.findIndex((h) => norm(h) === name);
  const idx = {
    transaction: col('transaction'),
    commande: col('commande'),
    type: col('type'),
    paymentDate: col('date du paiement'),
    status: col('statut'),
    amount: col('montant du paiement'),
    remiseDate: col('date remise'),
    remiseNumber: col('n° remise'),
    method: col('moyen de paiement'),
    cardNumber: col('numero de carte'),
    payerEmail: col('e-mail acheteur'),
  };

  const out: CardImportRow[] = [];
  let total = 0;
  let minDate: string | null = null;
  let maxDate: string | null = null;

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i] ?? [];
    const txId = String(r[idx.transaction] ?? '').trim();
    if (!txId) continue;
    const type = idx.type >= 0 ? String(r[idx.type] ?? '').trim() : '';
    // 'Débit' = customer payment we're cashing; 'Crédit' = refund. Keep debits only.
    if (type && !/d[ée]bit/i.test(type)) continue;
    const status = idx.status >= 0 ? String(r[idx.status] ?? '').trim() : '';
    if (status && /impay[eé]|rejet[eé]/i.test(status)) continue; // unpaid / rejected
    const date = parseDateFr(r[idx.paymentDate]);
    const amount = parseAmount(r[idx.amount]);
    if (!date || amount <= 0) continue;
    const method = idx.method >= 0 ? String(r[idx.method] ?? '').trim() : '';
    const maskedPan = idx.cardNumber >= 0 ? String(r[idx.cardNumber] ?? '').trim() : '';
    const remiseNumber = idx.remiseNumber >= 0 ? String(r[idx.remiseNumber] ?? '').trim() : '';
    const payerEmail = idx.payerEmail >= 0 ? String(r[idx.payerEmail] ?? '').trim() : '';
    const commandeName = idx.commande >= 0 ? String(r[idx.commande] ?? '').trim() : '';

    out.push({
      transactionId: txId,
      date,
      amount,
      method: method || 'CB',
      payerName: commandeName,
      payerEmail,
      maskedPan: maskedPan || null,
      remiseNumber: remiseNumber || null,
      raw: header.reduce<Record<string, unknown>>((acc, h, j) => {
        if (h) acc[h] = r[j];
        return acc;
      }, {}),
    });

    total += amount;
    if (!minDate || date < minDate) minDate = date;
    if (!maxDate || date > maxDate) maxDate = date;
  }

  return {
    provider: options.defaultChannel === 'phone' ? 'sogecommerce-phone' : 'sogecommerce-site',
    rows: out,
    warnings: [],
    periodStart: minDate,
    periodEnd: maxDate,
    totalAmount: +total.toFixed(2),
  };
}

/* -------------------------------------------------------------------------
 * Sogecommerce — daily remises (settlements)
 * -----------------------------------------------------------------------*/

export interface RemiseRow {
  remiseNumber: string;
  date: string;
  amount: number; // signed: credit positive, debit negative
  network: string;
  status: string;
  raw: Record<string, unknown>;
}

export function parseSogecommerceRemises(buffer: Buffer): {
  rows: RemiseRow[];
  warnings: string[];
  periodStart: string | null;
  periodEnd: string | null;
  totalAmount: number;
} {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) {
    return { rows: [], warnings: ['Workbook has no sheets'], periodStart: null, periodEnd: null, totalAmount: 0 };
  }
  const rows = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[sheetName], {
    header: 1,
    raw: false,
    defval: '',
  }) as unknown as string[][];

  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    if (rows[i]?.some((c) => norm(c) === 'n° remise')) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) {
    return { rows: [], warnings: ['Remises header row not found'], periodStart: null, periodEnd: null, totalAmount: 0 };
  }
  const header = rows[headerIdx];
  const col = (name: string) => header.findIndex((h) => norm(h) === name);
  const idx = {
    remise: col('n° remise'),
    date: col('date de remise'),
    network: col('reseau'),
    debit: col('debit'),
    credit: col('credit'),
    status: col('statut'),
  };

  const out: RemiseRow[] = [];
  let total = 0;
  let minDate: string | null = null;
  let maxDate: string | null = null;
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i] ?? [];
    const num = String(r[idx.remise] ?? '').trim();
    if (!num) continue;
    const date = parseDateFr(r[idx.date]);
    if (!date) continue;
    const debit = idx.debit >= 0 ? parseAmount(r[idx.debit]) : 0;
    const credit = idx.credit >= 0 ? parseAmount(r[idx.credit]) : 0;
    const amount = debit - credit;
    if (amount === 0) continue;
    out.push({
      remiseNumber: num,
      date,
      amount: +amount.toFixed(2),
      network: idx.network >= 0 ? String(r[idx.network] ?? '').trim() : '',
      status: idx.status >= 0 ? String(r[idx.status] ?? '').trim() : '',
      raw: header.reduce<Record<string, unknown>>((acc, h, j) => {
        if (h) acc[h] = r[j];
        return acc;
      }, {}),
    });
    total += amount;
    if (!minDate || date < minDate) minDate = date;
    if (!maxDate || date > maxDate) maxDate = date;
  }
  return { rows: out, warnings: [], periodStart: minDate, periodEnd: maxDate, totalAmount: +total.toFixed(2) };
}

/* -------------------------------------------------------------------------
 * PayPal — monthly transaction CSV
 * -----------------------------------------------------------------------*/

export function parsePaypalCsv(buffer: Buffer): CardImportParseResult {
  // Strip BOM and any CRLF normalisation issues.
  let text = buffer.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const warnings: string[] = [];
  let records: string[][];
  try {
    records = parse(text, {
      delimiter: ',',
      relax_column_count: true,
      skip_empty_lines: true,
    }) as string[][];
  } catch (err) {
    return {
      provider: 'paypal',
      rows: [],
      warnings: [`PayPal CSV parse failed: ${err instanceof Error ? err.message : String(err)}`],
      periodStart: null,
      periodEnd: null,
      totalAmount: 0,
    };
  }
  if (records.length === 0) {
    return { provider: 'paypal', rows: [], warnings: ['Empty file'], periodStart: null, periodEnd: null, totalAmount: 0 };
  }

  const header = records[0];
  const col = (name: string) =>
    header.findIndex((h) => norm(h) === norm(name));
  const idx = {
    date: col('Date'),
    name: col('Nom'),
    type: col('Type'),
    status: col('État'),
    gross: col('Avant commission'),
    net: col('Net'),
    fee: col('Commission'),
    txId: col('Numéro de transaction'),
    payerEmail: col("De l'adresse email"),
    receiverEmail: col("À l'adresse email"),
  };

  const out: CardImportRow[] = [];
  let total = 0;
  let minDate: string | null = null;
  let maxDate: string | null = null;

  for (let i = 1; i < records.length; i++) {
    const r = records[i];
    if (!r) continue;
    const type = idx.type >= 0 ? String(r[idx.type] ?? '').trim() : '';
    // Customer payments use "Paiement DCC" or "Paiement Express Checkout".
    // The accompanying "Paiement standard" / "Virement standard" rows are PayPal
    // fee / bank-sweep mirrors and aren't customer transactions.
    if (!/^paiement\b/i.test(type) || /standard/i.test(type)) continue;
    const status = idx.status >= 0 ? String(r[idx.status] ?? '').trim() : '';
    if (status && !/termin[eé]/i.test(status)) continue;
    const date = parseDateFr(r[idx.date]);
    const gross = parseAmount(r[idx.gross]);
    const net = parseAmount(r[idx.net]);
    const amount = gross > 0 ? gross : net > 0 ? net : 0;
    if (!date || amount <= 0) continue;
    const payerName = idx.name >= 0 ? String(r[idx.name] ?? '').trim() : '';
    const payerEmail = idx.payerEmail >= 0 ? String(r[idx.payerEmail] ?? '').trim() : '';
    const txId = idx.txId >= 0 ? String(r[idx.txId] ?? '').trim() : '';
    if (!txId) continue;

    out.push({
      transactionId: txId,
      date,
      amount: +amount.toFixed(2),
      method: 'PayPal',
      payerName,
      payerEmail,
      maskedPan: null,
      remiseNumber: null,
      raw: header.reduce<Record<string, unknown>>((acc, h, j) => {
        if (h) acc[h] = r[j];
        return acc;
      }, {}),
    });
    total += amount;
    if (!minDate || date < minDate) minDate = date;
    if (!maxDate || date > maxDate) maxDate = date;
  }

  // Second pass: "Virement standard" rows are PayPal-to-bank sweep transfers.
  // Net is negative on the PayPal side, but corresponds to a bank credit
  // 1-2 days later — the bank-statement matcher needs them by amount + date.
  for (let i = 1; i < records.length; i++) {
    const r = records[i];
    if (!r) continue;
    const type = idx.type >= 0 ? String(r[idx.type] ?? '').trim() : '';
    if (!/^virement\s+standard/i.test(type)) continue;
    const status = idx.status >= 0 ? String(r[idx.status] ?? '').trim() : '';
    if (status && !/termin[eé]/i.test(status)) continue;
    const date = parseDateFr(r[idx.date]);
    const net = parseAmount(r[idx.net]);
    const txId = idx.txId >= 0 ? String(r[idx.txId] ?? '').trim() : '';
    if (!date || net >= 0 || !txId) {
      warnings.push(`Skipped malformed Virement standard row at line ${i + 1}`);
      continue;
    }
    const sweepAmount = +Math.abs(net).toFixed(2);
    out.push({
      transactionId: txId,
      date,
      amount: sweepAmount,
      method: 'PayPal sweep',
      payerName: '',
      payerEmail: '',
      maskedPan: null,
      remiseNumber: null,
      raw: header.reduce<Record<string, unknown>>((acc, h, j) => {
        if (h) acc[h] = r[j];
        return acc;
      }, {}),
    });
    total += sweepAmount;
    if (!minDate || date < minDate) minDate = date;
    if (!maxDate || date > maxDate) maxDate = date;
  }

  return { provider: 'paypal', rows: out, warnings, periodStart: minDate, periodEnd: maxDate, totalAmount: +total.toFixed(2) };
}
