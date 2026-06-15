import { parse } from 'csv-parse/sync';
import * as XLSX from 'xlsx';
import { getTenantModelsFor } from '../../db/tenant';
import { audit } from '../../lib/audit';
import { BadRequestError, NotFoundError } from '../../lib/errors';

interface ActorMeta {
  userId: string;
  email: string;
  ip: string;
}

interface UploadFile {
  originalname: string;
  buffer: Buffer;
  size: number;
}

/**
 * Bulk historical cost-price upload.
 *
 * Idris (14/05/2026): SAP's batch-level cost has historically been unreliable,
 * so for KPI / profitability reports we maintain a per-period overlay. The
 * accountant uploads a CSV or workbook once with: ItemCode, From, To, AvgCost
 * (optionally Notes), and the file populates `Item.costHistory[]`.
 *
 * Expected columns (case-insensitive, accent-insensitive):
 *   - `ItemCode` / `Code` / `SKU`
 *   - `From` / `DateFrom` / `Début`
 *   - `To`   / `DateTo`   / `Fin`
 *   - `AvgCost` / `Cost` / `PrixCoût`
 *   - `Notes` / `Comment` (optional)
 */

interface ParsedCostRow {
  itemCode: string;
  from: Date;
  to: Date;
  avgCost: number;
  notes: string;
}

interface ParseResult {
  rows: ParsedCostRow[];
  warnings: string[];
}

const norm = (s: unknown): string =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();

function parseAmount(raw: unknown): number {
  if (raw === null || raw === undefined || raw === '') return NaN;
  if (typeof raw === 'number') return raw;
  const n = Number(
    String(raw)
      .replace(/[€$\s]/g, '')
      .replace(/(?<=\d),(?=\d{3}(\D|$))/g, '')
      .replace(',', '.'),
  );
  return Number.isFinite(n) ? n : NaN;
}

function parseDate(raw: unknown): Date | null {
  if (!raw) return null;
  if (raw instanceof Date) return raw;
  const s = String(raw).trim();
  let m = s.match(/^(\d{2})[/-](\d{2})[/-](\d{4})$/);
  if (m) return new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])));
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return null;
}

function parseRows(buffer: Buffer, originalname: string): ParseResult {
  const isExcel = /\.xlsx?$/i.test(originalname);
  let records: string[][];
  if (isExcel) {
    const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
    const ws = wb.Sheets[wb.SheetNames[0]];
    records = (XLSX.utils.sheet_to_json<string[]>(ws, {
      header: 1,
      raw: false,
      defval: '',
    }) as unknown) as string[][];
  } else {
    const text = buffer.toString('utf8');
    records = parse(text, {
      delimiter: [',', ';', '\t'],
      relax_column_count: true,
      skip_empty_lines: true,
    }) as string[][];
  }
  if (records.length === 0) return { rows: [], warnings: ['Empty file'] };

  const header = records[0];
  const col = (...names: string[]): number => {
    for (let i = 0; i < header.length; i++) {
      const h = norm(header[i]);
      if (names.some((n) => h === n)) return i;
    }
    return -1;
  };
  const idx = {
    itemCode: col('itemcode', 'code', 'sku'),
    from: col('from', 'datefrom', 'date from', 'debut', 'début'),
    to: col('to', 'dateto', 'date to', 'fin'),
    avgCost: col('avgcost', 'cost', 'prixcout', 'prix coût', 'prix cout', 'cout', 'coût'),
    notes: col('notes', 'comment', 'commentaire'),
  };
  const warnings: string[] = [];
  if (idx.itemCode === -1) warnings.push('Missing ItemCode column');
  if (idx.from === -1) warnings.push('Missing From column');
  if (idx.to === -1) warnings.push('Missing To column');
  if (idx.avgCost === -1) warnings.push('Missing AvgCost column');
  if (warnings.length > 0) return { rows: [], warnings };

  const rows: ParsedCostRow[] = [];
  for (let i = 1; i < records.length; i++) {
    const r = records[i] ?? [];
    if (r.every((c) => String(c ?? '').trim() === '')) continue;
    const itemCode = String(r[idx.itemCode] ?? '').trim();
    if (!itemCode) continue;
    const from = parseDate(r[idx.from]);
    const to = parseDate(r[idx.to]);
    const avgCost = parseAmount(r[idx.avgCost]);
    if (!from || !to || !Number.isFinite(avgCost)) {
      warnings.push(`Row ${i + 1}: skipped (bad dates or cost) — itemCode=${itemCode}`);
      continue;
    }
    if (to < from) {
      warnings.push(`Row ${i + 1}: skipped — "to" < "from" for itemCode=${itemCode}`);
      continue;
    }
    if (avgCost < 0) {
      warnings.push(`Row ${i + 1}: skipped — negative cost for itemCode=${itemCode}`);
      continue;
    }
    const notes = idx.notes >= 0 ? String(r[idx.notes] ?? '').trim() : '';
    rows.push({ itemCode, from, to, avgCost, notes });
  }
  return { rows, warnings };
}

export async function uploadItemCosts(
  companyKey: string,
  file: UploadFile,
  actor: ActorMeta,
) {
  if (!file?.buffer || file.size === 0) throw new BadRequestError('Empty upload');
  const parsed = parseRows(file.buffer, file.originalname);
  if (parsed.rows.length === 0) {
    throw new BadRequestError(
      `No usable rows. Warnings: ${parsed.warnings.join('; ') || '(none)'}`,
    );
  }

  const models = await getTenantModelsFor(companyKey);

  // Group rows by ItemCode so we can $push them in one update per item.
  const byItem = new Map<string, ParsedCostRow[]>();
  for (const r of parsed.rows) {
    const list = byItem.get(r.itemCode) ?? [];
    list.push(r);
    byItem.set(r.itemCode, list);
  }

  let updated = 0;
  let missing = 0;
  const now = new Date();
  for (const [itemCode, list] of byItem) {
    const item = await models.Item.findOne({ ItemCode: itemCode }).select({ _id: 1 });
    if (!item) {
      missing++;
      continue;
    }
    await models.Item.updateOne(
      { _id: item._id },
      {
        $push: {
          costHistory: {
            $each: list.map((r) => ({
              from: r.from,
              to: r.to,
              avgCost: r.avgCost,
              currency: 'EUR',
              source: file.originalname,
              uploadedAt: now,
              uploadedByEmail: actor.email,
              notes: r.notes,
            })),
          },
        },
      },
    );
    updated++;
  }

  await audit({
    action: 'itemCosts.upload',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    subjectType: 'Item',
    subjectId: 'bulk',
    companyKey,
    after: { filename: file.originalname, rows: parsed.rows.length, updated, missing },
    ip: actor.ip,
  });

  return {
    filename: file.originalname,
    rows: parsed.rows.length,
    itemsUpdated: updated,
    itemsMissing: missing,
    warnings: parsed.warnings,
  };
}

export async function getItemCostHistory(companyKey: string, itemCode: string) {
  const models = await getTenantModelsFor(companyKey);
  const item = await models.Item.findOne({ ItemCode: itemCode })
    .select({ ItemCode: 1, ItemName: 1, costHistory: 1 })
    .lean();
  if (!item) throw new NotFoundError(`Item ${itemCode}`);
  return {
    itemCode: item.ItemCode,
    itemName: item.ItemName,
    costHistory: (item.costHistory ?? []).slice().sort((a, b) => +a.from - +b.from),
  };
}

/**
 * Lookup the avg cost for an item on a given date. Returns the most recent
 * entry whose [from, to] inclusive range contains the date. Falls back to the
 * latest entry before the date if none directly contain it.
 */
export async function lookupCostAt(
  companyKey: string,
  itemCode: string,
  date: Date,
): Promise<number | null> {
  const models = await getTenantModelsFor(companyKey);
  const item = await models.Item.findOne({ ItemCode: itemCode })
    .select({ costHistory: 1 })
    .lean();
  if (!item) return null;
  const entries = (item.costHistory ?? []).slice().sort((a, b) => +b.from - +a.from);
  for (const e of entries) {
    if (date >= e.from && date <= e.to) return e.avgCost;
  }
  for (const e of entries) {
    if (date >= e.from) return e.avgCost;
  }
  return null;
}
