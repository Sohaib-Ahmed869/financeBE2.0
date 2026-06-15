import crypto from 'crypto';
import { Types, type Model } from 'mongoose';
import { getTenantModelsFor } from '../../db/tenant';
import { audit } from '../../lib/audit';
import { BadRequestError, NotFoundError } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { parseDaybookWorkbook, type ParsedDay } from './daybook.parser';
import type { UpsertDayInput } from './daybook.validators';
import {
  buildContext,
  decideMatch,
  livraisonPaidAmount,
  livraisonMethod,
  AUTO_MATCH_THRESHOLD,
  type MatchCandidate,
  type MatchExceptionKind,
  type LivraisonMethod,
} from './daybook.matcher';
import { pushMatchedLivraisons, type PushSummary } from './daybook.pusher';
import {
  pushPosExtrasForDay,
  type PosExtraSummary,
} from './daybook.posExtraPusher';
import { buildDaybookWorkbook } from './daybook.exporter';
import { preReconcileSync, type PreReconcileSyncResult } from './daybook.preReconcile';
import { runDiscrepancyCheck, type DiscrepancyReport } from './daybook.discrepancy';
import { getOwnCompanyCardCodes, tagDeliveryChannel } from './daybook.channelTagger';
import type { IPaymentEntry, PaymentMethod } from '../../models/tenant/PaymentEntry';
import {
  buildContext as buildPaymentContext,
  decideMatch as decidePaymentMatch,
  type PaymentInput,
  type MatchCandidate as PaymentMatchCandidate,
  type MatchExceptionKind as PaymentExceptionKind,
} from '../payments/payments.matcher';
import { reconcilePayment, pushPayment } from '../payments/payments.service';
import type { ReconcileInput } from '../payments/payments.validators';

/** sourceTypes of card/PayPal payments that the daybook surfaces & drives. */
const IMPORTED_SOURCE_TYPES = ['paypal-import', 'sogecommerce-import'] as const;
import { getMonthKpis as _getMonthKpis, type MonthKpis } from './daybook.kpis';

export { type MonthKpis } from './daybook.kpis';

/** Pass-through so the controller can keep importing from `daybook.service`. */
export async function getMonthKpis(
  companyKey: string,
  year: number,
  month: number,
): Promise<MonthKpis> {
  return _getMonthKpis(companyKey, year, month);
}

interface ActorMeta {
  userId: string;
  email: string;
  ip: string;
}

export interface UploadResult {
  fileId: string;
  filename: string;
  monthLabel: string | null;
  year: number | null;
  month: number | null;
  daysParsed: number;
  reused: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Persists a ParsedDay onto its DaybookDay row. One row per (companyKey × date).
 * Re-running for the same date overwrites — we want the latest upload to win.
 */
/**
 * A line's identity key for the purpose of preserving match decisions across
 * edits. If (codeClient + numero + montant) is unchanged, the line is
 * "the same row" and any prior match decision survives.
 */
function livraisonIdentity(l: {
  codeClient?: string;
  numero?: string;
  montant?: number | null;
}): string {
  const code = (l.codeClient ?? '').trim().toUpperCase();
  const num = (l.numero ?? '').trim().toLowerCase();
  const amt =
    l.montant === null || l.montant === undefined ? '' : l.montant.toFixed(2);
  return `${code}|${num}|${amt}`;
}

interface ExistingMatch {
  status?: 'unmatched' | 'auto' | 'manual' | 'rejected';
  invoiceDocEntry?: number | null;
  invoiceDocNum?: number | null;
  invoiceTotal?: number | null;
  invoiceBalance?: number | null;
  invoiceDate?: Date | null;
  matchScore?: number | null;
  matchReason?: string;
  matchedByEmail?: string;
  matchedAt?: Date | null;
  notes?: string;
}

function carryMatchOrEmpty(
  oldByIdentity: Map<string, ExistingMatch>,
  newLine: { codeClient: string; numero: string; montant: number | null },
): ExistingMatch {
  const id = livraisonIdentity(newLine);
  const prior = oldByIdentity.get(id);
  if (!prior) return { status: 'unmatched' };
  return prior;
}

async function upsertParsedDay(
  models: Awaited<ReturnType<typeof getTenantModelsFor>>,
  fileId: Types.ObjectId,
  day: ParsedDay,
  ownCompanyCardCodes: Set<string>,
): Promise<void> {
  // Don't clobber manual edits with a fresh Excel re-import. If a day's
  // `source` is already 'manual', upsert leaves it alone — the user edited it
  // after the import and that wins.
  const existing = await models.DaybookDay.findOne(
    { date: day.date },
    { source: 1, livraisons: 1 },
  ).lean();
  if (existing && existing.source === 'manual') return;

  // Carry any prior match decisions onto rows whose identity didn't change.
  const oldByIdentity = new Map<string, ExistingMatch>();
  for (const ol of existing?.livraisons ?? []) {
    if (!ol.match) continue;
    oldByIdentity.set(livraisonIdentity(ol), ol.match as ExistingMatch);
  }

  await models.DaybookDay.updateOne(
    { date: day.date },
    {
      $set: {
        source: 'excel',
        fileId,
        date: day.date,
        dayOfMonth: day.dayOfMonth,
        sheetName: day.sheetName,
        totals: day.totals,
        remiseBancaire: day.remiseBancaire,
        caisseEspeces: day.caisseEspeces,
        caisseCheques: day.caisseCheques,
        caisseChequesTotal: day.caisseChequesTotal,
        caisseCB: day.caisseCB,
        differenceFondCaisse: day.differenceFondCaisse,
        depenses: day.depenses,
        depensesTotal: day.depensesTotal,
        livraisons: day.livraisons.map((l) => ({
          ...l,
          deliveryChannel: tagDeliveryChannel(
            { cardCode: l.codeClient ?? '' },
            ownCompanyCardCodes,
          ),
          match: carryMatchOrEmpty(oldByIdentity, l),
        })),
        parseWarnings: day.parseWarnings,
      },
    },
    { upsert: true },
  );

  await writeThroughPaymentEntries(models, day.date, day.livraisons, 'system');
}

/**
 * Mirror each livraison line into PaymentEntry rows so the unified
 * /payments/days/:date view sees the same data as the daybook. One livraison
 * may produce up to four entries (one per non-null method amount); the
 * non-payé flag does not produce a row — the daybook line itself carries that
 * fact.
 *
 * Idempotent: deterministic (sourceFileId=DaybookDay._id, sourceLineRef=`${index}:${method}`)
 * means re-uploading or re-saving the same day updates existing rows in place
 * rather than duplicating. Rows that no longer correspond to any current
 * (index, method) pair are removed.
 */
async function writeThroughPaymentEntries(
  models: Awaited<ReturnType<typeof getTenantModelsFor>>,
  date: Date,
  livraisons: Array<{
    codeClient?: string;
    clientName?: string;
    montant?: number | null;
    banque?: string;
    numero?: string;
    montantEspeces?: number | null;
    montantCBSite?: number | null;
    montantCBPhone?: number | null;
    montantVirement?: number | null;
    referenceVirement?: string;
    remarques?: string;
    nonPaye?: boolean;
  }>,
  enteredByEmail: string,
): Promise<void> {
  // Find or upsert a synthetic Document anchor for this day so we can use
  // sourceFileId for uniqueness. We use the DaybookDay._id once it's saved.
  const dayDoc = await models.DaybookDay.findOne({ date }, { _id: 1 }).lean();
  if (!dayDoc) return; // shouldn't happen — upsert ran before this
  const dayId = dayDoc._id as Types.ObjectId;

  type MethodKey = 'Cheque' | 'Cash' | 'CB-Site' | 'CB-Phone' | 'Bank';
  const wanted: Array<{
    method: MethodKey;
    sourceLineRef: string;
    payload: Record<string, unknown>;
  }> = [];

  for (let i = 0; i < livraisons.length; i++) {
    const l = livraisons[i];
    // Non-payé rows carry an expected amount but no payment — they stay on
    // the daybook line and never become a PaymentEntry.
    if (l.nonPaye) continue;
    const cardCode = (l.codeClient ?? '').trim().toUpperCase();
    if (!cardCode) continue;
    const baseNotes = `Daybook ${date.toISOString().slice(0, 10)} livraison #${i + 1}${
      l.clientName ? ` (${l.clientName})` : ''
    }${l.remarques ? ` — ${l.remarques}` : ''}`;

    if (l.montant !== null && l.montant !== undefined && l.montant > 0) {
      wanted.push({
        method: 'Cheque',
        sourceLineRef: `${i}:Cheque`,
        payload: {
          cardCode,
          cardName: l.clientName ?? '',
          date,
          method: 'Cheque',
          amount: l.montant,
          currency: 'EUR',
          cheque: {
            chequeNumber: l.numero ?? '',
            bankCode: l.banque ?? '',
          },
          notes: baseNotes,
        },
      });
    }
    if (
      l.montantEspeces !== null &&
      l.montantEspeces !== undefined &&
      l.montantEspeces > 0
    ) {
      wanted.push({
        method: 'Cash',
        sourceLineRef: `${i}:Cash`,
        payload: {
          cardCode,
          cardName: l.clientName ?? '',
          date,
          method: 'Cash',
          amount: l.montantEspeces,
          currency: 'EUR',
          notes: baseNotes,
        },
      });
    }
    if (
      l.montantCBSite !== null &&
      l.montantCBSite !== undefined &&
      l.montantCBSite > 0
    ) {
      wanted.push({
        method: 'CB-Site',
        sourceLineRef: `${i}:CB-Site`,
        payload: {
          cardCode,
          cardName: l.clientName ?? '',
          date,
          method: 'CB-Site',
          amount: l.montantCBSite,
          currency: 'EUR',
          card: { processor: 'sogecommerce-site' },
          notes: baseNotes,
        },
      });
    }
    if (
      l.montantCBPhone !== null &&
      l.montantCBPhone !== undefined &&
      l.montantCBPhone > 0
    ) {
      wanted.push({
        method: 'CB-Phone',
        sourceLineRef: `${i}:CB-Phone`,
        payload: {
          cardCode,
          cardName: l.clientName ?? '',
          date,
          method: 'CB-Phone',
          amount: l.montantCBPhone,
          currency: 'EUR',
          card: { processor: 'sogecommerce-phone' },
          notes: baseNotes,
        },
      });
    }
    if (
      l.montantVirement !== null &&
      l.montantVirement !== undefined &&
      l.montantVirement > 0
    ) {
      wanted.push({
        method: 'Bank',
        sourceLineRef: `${i}:Bank`,
        payload: {
          cardCode,
          cardName: l.clientName ?? '',
          date,
          method: 'Bank',
          amount: l.montantVirement,
          currency: 'EUR',
          bank: { transferReference: l.referenceVirement ?? '' },
          notes: baseNotes,
        },
      });
    }
  }

  const wantedRefs = new Set(wanted.map((w) => w.sourceLineRef));

  // Delete any prior daybook-import rows on this day that no longer correspond
  // to a current (index, method) pair. Don't touch already-pushed rows — those
  // are real SAP postings and must be reversed in SAP.
  await models.PaymentEntry.deleteMany({
    sourceFileId: dayId,
    sourceType: 'daybook-import',
    status: { $in: ['draft', 'matched', 'failed'] },
    sourceLineRef: { $nin: Array.from(wantedRefs) },
  });

  for (const w of wanted) {
    await models.PaymentEntry.updateOne(
      {
        sourceFileId: dayId,
        sourceLineRef: w.sourceLineRef,
      },
      {
        $set: {
          ...w.payload,
          sourceType: 'daybook-import',
        },
        $setOnInsert: {
          status: 'draft',
          enteredByEmail,
          enteredAt: new Date(),
        },
      },
      { upsert: true },
    );
  }
}

export async function uploadAndParse(
  companyKey: string,
  file: { originalname: string; buffer: Buffer; size: number },
  actor: ActorMeta,
): Promise<UploadResult> {
  if (!file?.buffer || file.size === 0) {
    throw new BadRequestError('Empty upload');
  }
  const sha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');

  const models = await getTenantModelsFor(companyKey);

  // If the same workbook was uploaded earlier, surface the existing record.
  // We still re-run the parse so any parser fix lands on existing rows.
  const existing = await models.DaybookFile.findOne({ sha256 });

  let parsed;
  try {
    parsed = parseDaybookWorkbook(file.buffer, file.originalname);
  } catch (err) {
    logger.error(
      { err, filename: file.originalname, companyKey },
      'daybook.parse_failed',
    );
    throw new BadRequestError(
      `Couldn't parse "${file.originalname}". The workbook might be corrupted or have a different layout.`,
    );
  }

  const status: 'parsed' | 'partial' | 'failed' =
    parsed.days.length === 0
      ? 'failed'
      : parsed.errors.length > 0
        ? 'partial'
        : 'parsed';

  const fileDoc = existing
    ? await models.DaybookFile.findOneAndUpdate(
        { _id: existing._id },
        {
          $set: {
            originalFilename: file.originalname,
            fileSize: file.size,
            monthLabel: parsed.monthLabel,
            year: parsed.year,
            month: parsed.month,
            uploadedByUserId: new Types.ObjectId(actor.userId),
            uploadedByEmail: actor.email,
            status,
            daysParsed: parsed.days.length,
            parseErrors: parsed.errors,
          },
        },
        { new: true },
      )
    : await models.DaybookFile.create({
        storedFilename: `${sha256}.xlsx`,
        originalFilename: file.originalname,
        sha256,
        fileSize: file.size,
        monthLabel: parsed.monthLabel,
        year: parsed.year,
        month: parsed.month,
        uploadedByUserId: new Types.ObjectId(actor.userId),
        uploadedByEmail: actor.email,
        status,
        daysParsed: parsed.days.length,
        parseErrors: parsed.errors,
      });

  if (!fileDoc) throw new BadRequestError('Failed to persist daybook file');

  const ownCompanyCardCodes = await getOwnCompanyCardCodes(companyKey);
  for (const day of parsed.days) {
    await upsertParsedDay(models, fileDoc._id, day, ownCompanyCardCodes);
  }

  await audit({
    action: existing ? 'daybook.reupload' : 'daybook.upload',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    subjectType: 'DaybookFile',
    subjectId: fileDoc._id.toString(),
    companyKey,
    after: {
      filename: file.originalname,
      monthLabel: parsed.monthLabel,
      daysParsed: parsed.days.length,
      status,
    },
    ip: actor.ip,
  });

  const allWarnings = parsed.days.flatMap((d) =>
    d.parseWarnings.map((w) => `${d.sheetName}: ${w}`),
  );

  return {
    fileId: fileDoc._id.toString(),
    filename: file.originalname,
    monthLabel: parsed.monthLabel,
    year: parsed.year,
    month: parsed.month,
    daysParsed: parsed.days.length,
    reused: Boolean(existing),
    errors: parsed.errors,
    warnings: allWarnings,
  };
}

export async function listFiles(companyKey: string) {
  const models = await getTenantModelsFor(companyKey);
  const files = await models.DaybookFile.find({}).sort({ year: -1, month: -1 }).lean();
  return files.map((f) => ({
    id: f._id.toString(),
    originalFilename: f.originalFilename,
    monthLabel: f.monthLabel,
    year: f.year,
    month: f.month,
    daysParsed: f.daysParsed,
    status: f.status,
    fileSize: f.fileSize,
    uploadedByEmail: f.uploadedByEmail,
    uploadedAt: f.createdAt,
    parseErrors: f.parseErrors,
  }));
}

export async function getFile(companyKey: string, fileId: string) {
  const models = await getTenantModelsFor(companyKey);
  const id = new Types.ObjectId(fileId);
  const file = await models.DaybookFile.findById(id).lean();
  if (!file) throw new NotFoundError('DaybookFile');

  // Show every day in the file's month — including manual entries created
  // outside this Excel — so the month view is the complete picture.
  let dayQuery: Record<string, unknown> = { fileId: id };
  if (file.year && file.month) {
    const monthStart = new Date(Date.UTC(file.year, file.month - 1, 1));
    const monthEnd = new Date(Date.UTC(file.year, file.month, 1));
    dayQuery = { date: { $gte: monthStart, $lt: monthEnd } };
  }
  const days = await models.DaybookDay.find(dayQuery)
    .sort({ dayOfMonth: 1 })
    .lean();
  return {
    file: {
      id: file._id.toString(),
      originalFilename: file.originalFilename,
      monthLabel: file.monthLabel,
      year: file.year,
      month: file.month,
      daysParsed: file.daysParsed,
      status: file.status,
      fileSize: file.fileSize,
      uploadedByEmail: file.uploadedByEmail,
      uploadedAt: file.createdAt,
      parseErrors: file.parseErrors,
    },
    days: days.map((d) => ({
      id: d._id.toString(),
      date: d.date,
      dayOfMonth: d.dayOfMonth,
      sheetName: d.sheetName,
      source: d.source,
      totals: d.totals,
      remiseBancaire: d.remiseBancaire,
      caisseEspeces: d.caisseEspeces,
      caisseCheques: d.caisseCheques,
      caisseChequesTotal: d.caisseChequesTotal,
      caisseCB: d.caisseCB,
      differenceFondCaisse: d.differenceFondCaisse,
      depenses: d.depenses,
      depensesTotal: d.depensesTotal,
      livraisonsCount: d.livraisons.length,
      livraisonsAmount: d.livraisons.reduce(
        (sum, l) => sum + (l.montant ?? 0),
        0,
      ),
      parseWarnings: d.parseWarnings,
    })),
  };
}

/**
 * Returns every day in a given (year, month), regardless of whether an Excel
 * was ever uploaded for it. Used by the manual-month detail page.
 */
export async function getMonthByYM(
  companyKey: string,
  year: number,
  month: number,
) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new BadRequestError('Invalid year/month');
  }
  const models = await getTenantModelsFor(companyKey);
  const monthStart = new Date(Date.UTC(year, month - 1, 1));
  const monthEnd = new Date(Date.UTC(year, month, 1));
  const days = await models.DaybookDay.find({
    date: { $gte: monthStart, $lt: monthEnd },
  })
    .sort({ dayOfMonth: 1 })
    .lean();
  if (days.length === 0) {
    throw new NotFoundError(`No daybook days for ${year}-${String(month).padStart(2, '0')}`);
  }
  // Try to surface a file for this month if one exists, even though the
  // route was reached without an explicit fileId.
  const file = await models.DaybookFile.findOne({ year, month }).lean();
  return {
    file: file
      ? {
          id: file._id.toString(),
          originalFilename: file.originalFilename,
          monthLabel: file.monthLabel,
          year: file.year,
          month: file.month,
          daysParsed: file.daysParsed,
          status: file.status,
          fileSize: file.fileSize,
          uploadedByEmail: file.uploadedByEmail,
          uploadedAt: file.createdAt,
          parseErrors: file.parseErrors,
        }
      : {
          id: null as string | null,
          originalFilename: null as string | null,
          monthLabel: null as string | null,
          year,
          month,
          daysParsed: days.length,
          status: 'parsed' as const,
          fileSize: 0,
          uploadedByEmail: '',
          uploadedAt: null as Date | null,
          parseErrors: [] as string[],
        },
    days: days.map((d) => ({
      id: d._id.toString(),
      date: d.date,
      dayOfMonth: d.dayOfMonth,
      sheetName: d.sheetName,
      source: d.source,
      totals: d.totals,
      remiseBancaire: d.remiseBancaire,
      caisseEspeces: d.caisseEspeces,
      caisseCheques: d.caisseCheques,
      caisseChequesTotal: d.caisseChequesTotal,
      caisseCB: d.caisseCB,
      differenceFondCaisse: d.differenceFondCaisse,
      depenses: d.depenses,
      depensesTotal: d.depensesTotal,
      livraisonsCount: d.livraisons.length,
      livraisonsAmount: d.livraisons.reduce((s, l) => s + (l.montant ?? 0), 0),
      parseWarnings: d.parseWarnings,
    })),
  };
}

/**
 * Lists every (year, month) tuple that has at least one DaybookDay row,
 * with day counts and a fileId pointer when an Excel for that month exists.
 * The Daybook landing page uses this to surface months created via manual
 * entry that don't have a corresponding upload.
 */
export async function listMonths(companyKey: string) {
  const models = await getTenantModelsFor(companyKey);
  type Bucket = {
    _id: { year: number; month: number };
    days: number;
    daysExcel: number;
    daysManual: number;
    livraisonsAmount: number;
    minDate: Date;
    maxDate: Date;
  };
  const groupResult = await models.DaybookDay.aggregate<Bucket>([
    {
      $project: {
        year: { $year: '$date' },
        month: { $month: '$date' },
        date: 1,
        source: 1,
        livraisons: 1,
      },
    },
    {
      $group: {
        _id: { year: '$year', month: '$month' },
        days: { $sum: 1 },
        daysExcel: {
          $sum: { $cond: [{ $eq: ['$source', 'excel'] }, 1, 0] },
        },
        daysManual: {
          $sum: { $cond: [{ $eq: ['$source', 'manual'] }, 1, 0] },
        },
        livraisonsAmount: {
          $sum: {
            $reduce: {
              input: '$livraisons',
              initialValue: 0,
              in: { $add: ['$$value', { $ifNull: ['$$this.montant', 0] }] },
            },
          },
        },
        minDate: { $min: '$date' },
        maxDate: { $max: '$date' },
      },
    },
    { $sort: { '_id.year': -1, '_id.month': -1 } },
  ]);

  const files = await models.DaybookFile.find({
    year: { $ne: null },
    month: { $ne: null },
  })
    .select({ year: 1, month: 1, monthLabel: 1, originalFilename: 1 })
    .lean();
  const fileByYM = new Map<string, (typeof files)[number]>();
  for (const f of files) fileByYM.set(`${f.year}-${f.month}`, f);

  return {
    items: groupResult.map((b) => {
      const f = fileByYM.get(`${b._id.year}-${b._id.month}`);
      return {
        year: b._id.year,
        month: b._id.month,
        days: b.days,
        daysExcel: b.daysExcel,
        daysManual: b.daysManual,
        livraisonsAmount: b.livraisonsAmount,
        minDate: b.minDate,
        maxDate: b.maxDate,
        fileId: f ? (f._id as Types.ObjectId).toString() : null,
        monthLabel: f?.monthLabel ?? null,
        originalFilename: f?.originalFilename ?? null,
      };
    }),
  };
}

export async function getDayByDate(companyKey: string, isoDate: string) {
  // isoDate = "YYYY-MM-DD" — match the day boundary stored at UTC 00:00.
  const m = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new BadRequestError('Use YYYY-MM-DD');
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const models = await getTenantModelsFor(companyKey);
  const day = await models.DaybookDay.findOne({ date }).lean();
  if (!day) throw new NotFoundError('DaybookDay');

  // Pair with the same-day Z-report so the UI can render its account-receipts
  // block + drawer audit inline on the daybook day view. Null when no Z-report
  // was uploaded for this date (Idris records the daybook and the Z-report
  // separately and the daybook is the more frequently filled of the two).
  const zr = await models.ZReport.findOne({ branch: companyKey, date }).lean();
  const zReport = zr
    ? {
        id: zr._id.toString(),
        totals: zr.totals,
        drawerAudit: zr.drawerAudit,
        drawerCounted: zr.drawerCounted,
        drawerDiscrepancy: zr.drawerDiscrepancy,
        netDiscrepancy: zr.netDiscrepancy,
        accountReceipts: zr.accountReceipts ?? [],
      }
    : null;

  return {
    id: day._id.toString(),
    fileId: day.fileId ? day.fileId.toString() : null,
    source: day.source,
    date: day.date,
    dayOfMonth: day.dayOfMonth,
    sheetName: day.sheetName,
    totals: day.totals,
    remiseBancaire: day.remiseBancaire,
    caisseEspeces: day.caisseEspeces,
    caisseCheques: day.caisseCheques,
    caisseChequesTotal: day.caisseChequesTotal,
    caisseCB: day.caisseCB,
    differenceFondCaisse: day.differenceFondCaisse,
    depenses: day.depenses,
    depensesTotal: day.depensesTotal,
    livraisons: day.livraisons,
    posExtraPayments: day.posExtraPayments ?? [],
    parseWarnings: day.parseWarnings,
    zReport,
  };
}

function isoDateToUTC(isoDate: string): Date {
  const m = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new BadRequestError('Use YYYY-MM-DD');
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (
    date.getUTCFullYear() !== Number(m[1]) ||
    date.getUTCMonth() !== Number(m[2]) - 1 ||
    date.getUTCDate() !== Number(m[3])
  ) {
    throw new BadRequestError(`Invalid calendar date: ${isoDate}`);
  }
  return date;
}

export async function upsertManualDay(
  companyKey: string,
  isoDate: string,
  input: UpsertDayInput,
  actor: ActorMeta,
) {
  const date = isoDateToUTC(isoDate);
  const dayOfMonth = date.getUTCDate();
  const models = await getTenantModelsFor(companyKey);
  const ownCompanyCardCodes = await getOwnCompanyCardCodes(companyKey);

  const existing = await models.DaybookDay.findOne({ date }).lean();

  const oldByIdentity = new Map<string, ExistingMatch>();
  for (const ol of existing?.livraisons ?? []) {
    if (!ol.match) continue;
    oldByIdentity.set(livraisonIdentity(ol), ol.match as ExistingMatch);
  }

  // Strip undefined values so $set doesn't blow away nested fields when the
  // client only sends a partial section.
  const totals = {
    especes: input.totals?.especes ?? null,
    cheques: input.totals?.cheques ?? null,
    carteCredit: input.totals?.carteCredit ?? null,
    virement: input.totals?.virement ?? null,
  };
  // Bank slips: prefer the new amount-carrying shape; fall back to the legacy
  // string list if only that was sent. Keeping both in sync simplifies the
  // bank-statement matcher's reverse lookup.
  const bankSlips =
    input.remiseBancaire?.bankSlips
    ?? (input.remiseBancaire?.bankSlipRefs ?? []).map((ref) => ({
      ref,
      amount: null,
      kind: 'cash' as const,
    }));
  const bankSlipRefs =
    input.remiseBancaire?.bankSlipRefs
    ?? bankSlips.map((s) => s.ref).filter((r) => r.length > 0);
  const remiseBancaire = {
    especes: input.remiseBancaire?.especes ?? null,
    cheques: input.remiseBancaire?.cheques ?? null,
    monnaieNonDeposee: input.remiseBancaire?.monnaieNonDeposee ?? null,
    bankSlipRefs,
    bankSlips,
  };
  const caisseEspeces = {
    billets50: input.caisseEspeces?.billets50 ?? null,
    billets20: input.caisseEspeces?.billets20 ?? null,
    billets10: input.caisseEspeces?.billets10 ?? null,
    billets5: input.caisseEspeces?.billets5 ?? null,
    monnaie: input.caisseEspeces?.monnaie ?? null,
    total: input.caisseEspeces?.total ?? null,
    fondCaisse: input.caisseEspeces?.fondCaisse ?? null,
  };
  const caisseCB = {
    till: input.caisseCB?.till ?? null,
    sansContact: input.caisseCB?.sansContact ?? null,
    total: input.caisseCB?.total ?? null,
  };

  await models.DaybookDay.updateOne(
    { date },
    {
      $set: {
        source: 'manual',
        date,
        dayOfMonth,
        // Keep fileId on existing docs (traceability). New docs get null.
        ...(existing ? {} : { fileId: null, sheetName: '' }),
        totals,
        remiseBancaire,
        caisseEspeces,
        caisseCheques: input.caisseCheques ?? [],
        caisseChequesTotal: input.caisseChequesTotal ?? null,
        caisseCB,
        differenceFondCaisse: input.differenceFondCaisse ?? null,
        depenses: input.depenses ?? [],
        depensesTotal: input.depensesTotal ?? null,
        livraisons: (input.livraisons ?? []).map((l) => {
          const line = {
            codeClient: l.codeClient ?? '',
            clientName: l.clientName ?? '',
            montant: l.montant ?? null,
            banque: l.banque ?? '',
            numero: l.numero ?? '',
            remarques: l.remarques ?? '',
            sapStatusRaw: l.sapStatusRaw ?? '',
            montantEspeces: l.montantEspeces ?? null,
            montantCBSite: l.montantCBSite ?? null,
            montantCBPhone: l.montantCBPhone ?? null,
            montantVirement: l.montantVirement ?? null,
            referenceVirement: l.referenceVirement ?? '',
            nonPaye: l.nonPaye ?? false,
            deliveryChannel: tagDeliveryChannel(
              { cardCode: l.codeClient ?? '', userChoice: l.deliveryChannel },
              ownCompanyCardCodes,
            ),
          };
          return { ...line, match: carryMatchOrEmpty(oldByIdentity, line) };
        }),
        // POS over-payments: preserve push outcome on existing rows keyed by
        // (codeClient + method + amount).
        posExtraPayments: (input.posExtraPayments ?? []).map((p) => {
          const key = `${(p.codeClient ?? '').toUpperCase()}|${p.method}|${p.amount ?? ''}`;
          const prior = (existing?.posExtraPayments ?? []).find(
            (e) =>
              `${(e.codeClient ?? '').toUpperCase()}|${e.method}|${e.amount ?? ''}` === key,
          );
          return {
            codeClient: p.codeClient ?? '',
            clientName: p.clientName ?? '',
            method: p.method ?? 'card',
            amount: p.amount ?? null,
            notes: p.notes ?? '',
            status: prior?.status ?? 'unpushed',
            paymentEntryId: prior?.paymentEntryId ?? null,
            sapDocEntry: prior?.sapDocEntry ?? null,
            sapDocNum: prior?.sapDocNum ?? null,
            pushedAt: prior?.pushedAt ?? null,
            pushError: prior?.pushError ?? '',
            pushErrorAt: prior?.pushErrorAt ?? null,
          };
        }),
        parseWarnings: [],
        lastEditedByUserId: new Types.ObjectId(actor.userId),
        lastEditedByEmail: actor.email,
      },
    },
    { upsert: true },
  );

  await writeThroughPaymentEntries(models, date, input.livraisons ?? [], actor.email);

  await audit({
    action: existing ? 'daybook.day.edit' : 'daybook.day.create',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    subjectType: 'DaybookDay',
    subjectId: isoDate,
    companyKey,
    after: {
      date: isoDate,
      livraisonsCount: input.livraisons?.length ?? 0,
      depensesCount: input.depenses?.length ?? 0,
    },
    ip: actor.ip,
  });

  return getDayByDate(companyKey, isoDate);
}

export async function deleteFile(
  companyKey: string,
  fileId: string,
  actor: ActorMeta,
) {
  const models = await getTenantModelsFor(companyKey);
  const id = new Types.ObjectId(fileId);
  const file = await models.DaybookFile.findById(id);
  if (!file) throw new NotFoundError('DaybookFile');
  // Only drop days that are still pristine from this file. Days that the
  // user has since edited (source = 'manual') survive and become orphaned —
  // their `fileId` still points at the deleted file for traceability, but
  // they're no longer reachable via the file detail page.
  await models.DaybookDay.deleteMany({ fileId: id, source: 'excel' });
  await models.DaybookFile.deleteOne({ _id: id });
  await audit({
    action: 'daybook.delete',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    subjectType: 'DaybookFile',
    subjectId: fileId,
    companyKey,
    before: {
      filename: file.originalFilename,
      monthLabel: file.monthLabel,
      daysParsed: file.daysParsed,
    },
    ip: actor.ip,
  });
}

/**
 * Generate a "Feuille de solde" workbook for a given (year, month). Pulls
 * every DaybookDay row in the month — Excel-sourced AND manual — and writes
 * them back into a workbook with the same shape as the parser's input.
 * The download filename includes the month label for readability.
 */
export async function exportMonthWorkbook(
  companyKey: string,
  year: number,
  month: number,
): Promise<{ buffer: Buffer; filename: string }> {
  const models = await getTenantModelsFor(companyKey);
  const monthStart = new Date(Date.UTC(year, month - 1, 1));
  const monthEnd = new Date(Date.UTC(year, month, 1));
  const days = await models.DaybookDay.find({
    date: { $gte: monthStart, $lt: monthEnd },
  })
    .sort({ dayOfMonth: 1 })
    .lean();
  if (days.length === 0) {
    throw new NotFoundError(`No daybook days in ${year}-${String(month).padStart(2, '0')}`);
  }
  const file = await models.DaybookFile.findOne({ year, month })
    .select({ monthLabel: 1 })
    .lean();
  const buffer = buildDaybookWorkbook({
    monthLabel: file?.monthLabel ?? null,
    year,
    month,
    days: days.map((d) => ({
      date: d.date,
      dayOfMonth: d.dayOfMonth,
      totals: d.totals,
      remiseBancaire: d.remiseBancaire,
      caisseEspeces: d.caisseEspeces,
      caisseCheques: d.caisseCheques ?? [],
      caisseChequesTotal: d.caisseChequesTotal ?? null,
      caisseCB: d.caisseCB,
      differenceFondCaisse: d.differenceFondCaisse ?? null,
      depenses: d.depenses ?? [],
      depensesTotal: d.depensesTotal ?? null,
      livraisons: d.livraisons ?? [],
    })),
  });
  const safe = (file?.monthLabel ?? `${year}-${String(month).padStart(2, '0')}`)
    .replace(/[^\w\d -]/g, '_');
  return { buffer, filename: `Feuille de solde ${safe}.xlsx` };
}

/* -------------------------------------------------------------------------
 * Reconciliation — Phase 3
 * -----------------------------------------------------------------------*/

interface ReconciliationLineOut {
  index: number;
  codeClient: string;
  clientName: string;
  /** Cheque amount only (legacy column) — kept for the cheque-# display. */
  montant: number | null | undefined;
  /** Total paid across all methods — what the row reconciles against. */
  amount: number | null;
  /** Which payment method this delivery carries (cheque/cash/cb/transfer/mixed). */
  method: LivraisonMethod;
  banque: string;
  numero: string;
  remarques: string;
  sapStatusRaw: string;
  match: {
    status: 'unmatched' | 'auto' | 'manual' | 'rejected';
    invoiceDocEntry: number | null;
    invoiceDocNum: number | null;
    invoiceTotal: number | null;
    invoiceBalance: number | null;
    invoiceDate: Date | null;
    matchScore: number | null;
    matchReason: string;
    matchedByEmail: string;
    matchedAt: Date | null;
    notes: string;
  };
  candidates: MatchCandidate[];
  proposed: MatchCandidate | null;
  exception: MatchExceptionKind;
  exceptionDetail?: string;
}

/**
 * A card / PayPal payment that entered via the card-import flow (not the Excel
 * daybook). These reconcile and push to SAP through the cardImports pipeline,
 * so the daybook surfaces them read-only — purely so the accountant sees every
 * method for the day in one place rather than only cheque/cash/CB/transfer.
 */
interface ImportedPaymentOut {
  id: string;
  cardCode: string;
  cardName: string;
  method: PaymentMethod;
  amount: number;
  status: IPaymentEntry['status'];
  sourceType: IPaymentEntry['sourceType'];
  sapDocNum: number | null;
  sapPushedAt: Date | null;
  transactionId: string | null;
  notes: string;
  /** Invoice this payment is reconciled to (active PaymentMatch), if any. */
  matchedInvoiceDocEntry: number | null;
  matchedInvoiceDocNum: number | null;
  /** Live match suggestion + alternatives from the payments matcher. */
  proposed: PaymentMatchCandidate | null;
  candidates: PaymentMatchCandidate[];
  exception: PaymentExceptionKind;
  autoEligible: boolean;
}

export interface ReconciliationResult {
  date: Date;
  dayOfMonth: number;
  livraisons: ReconciliationLineOut[];
  /** Card / PayPal payments imported for this day (read-only here). */
  importedPayments: ImportedPaymentOut[];
  totals: {
    rows: number;
    matched: number;
    auto: number;
    manual: number;
    rejected: number;
    unmatched: number;
    exceptions: number;
    totalAmount: number;
    matchedAmount: number;
    /** Count of imported card/PayPal payments shown alongside the livraisons. */
    importedCount: number;
    /** Sum of those imported card/PayPal payments. */
    importedAmount: number;
    /** Imported payments that are reconciled to an invoice (or already pushed). */
    importedMatched: number;
  };
  autoMatchThreshold: number;
}

/**
 * Refresh the local SAP cache for every customer that appears on a day's
 * livraisons + posExtraPayments. Run before opening the reconcile screen so
 * the matcher never sees stale invoices / credit notes / on-account payments.
 */
export async function syncSapForDay(
  companyKey: string,
  isoDate: string,
  actor: ActorMeta,
): Promise<PreReconcileSyncResult> {
  const models = await getTenantModelsFor(companyKey);
  const result = await preReconcileSync(companyKey, models, isoDate);
  await audit({
    action: 'daybook.pre_reconcile_sync',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    subjectType: 'DaybookDay',
    subjectId: isoDate,
    companyKey,
    after: {
      cards: result.cardCodes.length,
      invoices: result.invoices.fetched,
      creditNotes: result.creditNotes.fetched,
      payments: result.payments.fetched,
      customers: result.customers.fetched,
      durationMs: result.durationMs,
    },
    ip: actor.ip,
  });
  return result;
}

export async function getDiscrepancyReport(
  companyKey: string,
  isoDate: string,
): Promise<DiscrepancyReport> {
  const models = await getTenantModelsFor(companyKey);
  return runDiscrepancyCheck(models, isoDate);
}

export async function getReconciliation(
  companyKey: string,
  isoDate: string,
): Promise<ReconciliationResult> {
  const date = isoDateToUTC(isoDate);
  const models = await getTenantModelsFor(companyKey);
  const day = await models.DaybookDay.findOne({ date }).lean();
  if (!day) throw new NotFoundError('DaybookDay');

  const ctx = await buildContext(models, day.livraisons);

  const out: ReconciliationLineOut[] = day.livraisons.map((l, i) => {
    const decision = decideMatch(l, ctx);
    const persisted = (l.match ?? {}) as ReconciliationLineOut['match'];
    return {
      index: i,
      codeClient: l.codeClient,
      clientName: l.clientName,
      montant: l.montant,
      amount: livraisonPaidAmount(l),
      method: livraisonMethod(l),
      banque: l.banque,
      numero: l.numero,
      remarques: l.remarques,
      sapStatusRaw: l.sapStatusRaw,
      match: {
        status: persisted.status ?? 'unmatched',
        invoiceDocEntry: persisted.invoiceDocEntry ?? null,
        invoiceDocNum: persisted.invoiceDocNum ?? null,
        invoiceTotal: persisted.invoiceTotal ?? null,
        invoiceBalance: persisted.invoiceBalance ?? null,
        invoiceDate: persisted.invoiceDate ?? null,
        matchScore: persisted.matchScore ?? null,
        matchReason: persisted.matchReason ?? '',
        matchedByEmail: persisted.matchedByEmail ?? '',
        matchedAt: persisted.matchedAt ?? null,
        notes: persisted.notes ?? '',
      },
      candidates: decision.candidates,
      proposed: decision.proposed,
      exception: decision.exception,
      exceptionDetail: decision.exceptionDetail,
    };
  });

  // Card / PayPal payments imported for this day reconcile through the
  // cardImports → SAP pipeline, not the Excel daybook. Surface them read-only
  // so the accountant sees every method for the day in one place.
  const dayEnd = new Date(date.getTime() + 24 * 60 * 60 * 1000);
  const importedDocs = await models.PaymentEntry.find({
    date: { $gte: date, $lt: dayEnd },
    sourceType: { $in: IMPORTED_SOURCE_TYPES },
    status: { $ne: 'voided' },
  })
    .sort({ date: 1 })
    .lean();

  // Reuse the method-agnostic payments matcher so PayPal / CB rows get the same
  // invoice candidates + scoring as a manually-entered payment. Active matches
  // tell us which ones are already reconciled to an invoice.
  const importedInputs: PaymentInput[] = importedDocs.map((p) => ({
    cardCode: p.cardCode,
    amount: p.amount,
    method: p.method as PaymentMethod,
    reference: p.card?.transactionId,
  }));
  const importedCtx = importedDocs.length
    ? await buildPaymentContext(models, importedInputs)
    : null;
  const importedActiveMatches = importedDocs.length
    ? await models.PaymentMatch.find({
        paymentEntryId: { $in: importedDocs.map((p) => p._id) },
        reverted: false,
      }).lean()
    : [];
  const matchByEntry = new Map(
    importedActiveMatches.map((m) => [String(m.paymentEntryId), m]),
  );

  const importedPayments: ImportedPaymentOut[] = importedDocs.map((p, i) => {
    const decision = importedCtx
      ? decidePaymentMatch(importedInputs[i], importedCtx)
      : null;
    const active = matchByEntry.get(String(p._id));
    const matchedDocEntry = (active?.invoiceDocEntry as number | undefined) ?? null;
    // Resolve the human DocNum from the candidate set when the invoice is still
    // open; falls back to null if it has since been cleared from the cache.
    const matchedDocNum =
      matchedDocEntry != null
        ? (decision?.candidates.find((c) => c.invoiceDocEntry === matchedDocEntry)
            ?.invoiceDocNum ?? null)
        : null;
    return {
      id: String(p._id),
      cardCode: p.cardCode,
      cardName: p.cardName ?? '',
      method: p.method as PaymentMethod,
      amount: p.amount,
      status: p.status,
      sourceType: p.sourceType,
      sapDocNum: p.sapDocNum ?? null,
      sapPushedAt: p.sapPushedAt ?? null,
      transactionId: p.card?.transactionId ?? null,
      notes: p.notes ?? '',
      matchedInvoiceDocEntry: matchedDocEntry,
      matchedInvoiceDocNum: matchedDocNum,
      proposed: decision?.proposed ?? null,
      candidates: decision?.candidates ?? [],
      exception: decision?.exception ?? null,
      autoEligible: decision?.autoEligible ?? false,
    };
  });

  const totals = {
    rows: out.length,
    matched: 0,
    auto: 0,
    manual: 0,
    rejected: 0,
    unmatched: 0,
    exceptions: 0,
    totalAmount: 0,
    matchedAmount: 0,
    importedCount: importedPayments.length,
    importedAmount: 0,
    importedMatched: 0,
  };
  for (const r of out) {
    totals.totalAmount += r.amount ?? 0;
    if (r.match.status === 'auto') totals.auto++;
    else if (r.match.status === 'manual') totals.manual++;
    else if (r.match.status === 'rejected') totals.rejected++;
    else totals.unmatched++;
    if (r.match.status === 'auto' || r.match.status === 'manual') {
      totals.matched++;
      totals.matchedAmount += r.amount ?? 0;
    }
    if (r.exception) totals.exceptions++;
  }
  for (const p of importedPayments) {
    totals.importedAmount += p.amount;
    if (p.matchedInvoiceDocEntry != null || p.status === 'pushed') {
      totals.importedMatched++;
    }
  }
  totals.importedAmount = +totals.importedAmount.toFixed(2);

  return {
    date: day.date,
    dayOfMonth: day.dayOfMonth,
    livraisons: out,
    importedPayments,
    totals,
    autoMatchThreshold: AUTO_MATCH_THRESHOLD,
  };
}

/**
 * Auto-match the day's imported card / PayPal payments to open invoices,
 * scoped to the cardImports-sourced entries only so it never touches the
 * Excel daybook write-through rows (those are matched + pushed by the daybook
 * pusher and double-handling them would risk a duplicate SAP posting).
 *
 * Reuses the payments matcher; persists a `PaymentMatch` for each
 * auto-eligible row exactly like `payments.autoMatchDay`, so the same push
 * pipeline (RCT4 + invoice link) applies afterwards.
 */
export async function autoMatchImportedPayments(
  companyKey: string,
  isoDate: string,
  actor: ActorMeta,
): Promise<{ date: string; matched: number; skipped: number }> {
  const date = isoDateToUTC(isoDate);
  const models = await getTenantModelsFor(companyKey);
  const dayEnd = new Date(date.getTime() + 24 * 60 * 60 * 1000);

  const entries = await models.PaymentEntry.find({
    date: { $gte: date, $lt: dayEnd },
    sourceType: { $in: IMPORTED_SOURCE_TYPES },
    // Card imports land as 'matched' (= ready) but without an invoice link,
    // so include them alongside draft/failed; we skip any with a live match.
    status: { $in: ['draft', 'failed', 'matched'] },
  });

  const ids = entries.map((e) => e._id);
  const existing = ids.length
    ? await models.PaymentMatch.find({
        paymentEntryId: { $in: ids },
        reverted: false,
      }).lean()
    : [];
  const alreadyMatched = new Set(existing.map((m) => String(m.paymentEntryId)));

  const inputs: PaymentInput[] = entries.map((e) => ({
    cardCode: e.cardCode,
    amount: e.amount,
    method: e.method as PaymentMethod,
    reference: e.card?.transactionId,
  }));
  const ctx = await buildPaymentContext(models, inputs);

  let matched = 0;
  let skipped = 0;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (alreadyMatched.has(String(entry._id))) {
      skipped++;
      continue;
    }
    const decision = decidePaymentMatch(inputs[i], ctx);
    if (!decision.proposed || !decision.autoEligible) {
      skipped++;
      continue;
    }
    await models.PaymentMatch.create({
      paymentEntryId: entry._id,
      invoiceDocEntry: decision.proposed.invoiceDocEntry,
      appliedAmount: entry.amount,
      appliedCurrency: entry.currency || 'EUR',
      confidence: decision.proposed.score,
      matchedBy: 'system',
      matchedVia: 'rule',
      matchedByUserEmail: actor.email,
    });
    if (entry.status !== 'matched') {
      entry.status = 'matched';
      await entry.save();
    }
    matched++;
  }

  await audit({
    action: 'daybook.imported.auto_match',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    subjectType: 'DaybookDay',
    subjectId: isoDate,
    companyKey,
    after: { matched, skipped },
    ip: actor.ip,
  });

  return { date: isoDate, matched, skipped };
}

/** Guard: a daybook "imported" action may only touch a card/PayPal import. */
async function loadImportedEntry(companyKey: string, id: string) {
  const models = await getTenantModelsFor(companyKey);
  const entry = await models.PaymentEntry.findById(id).lean();
  if (!entry) throw new NotFoundError('Payment');
  if (!IMPORTED_SOURCE_TYPES.includes(entry.sourceType as (typeof IMPORTED_SOURCE_TYPES)[number])) {
    throw new BadRequestError('Not an imported card/PayPal payment');
  }
  return entry;
}

/** Reconcile an imported payment to an invoice — delegates to the payments
 * service so the PaymentMatch + lifecycle stay identical to the Payments screen. */
export async function matchImportedPayment(
  companyKey: string,
  id: string,
  input: ReconcileInput,
  actor: ActorMeta,
) {
  await loadImportedEntry(companyKey, id);
  return reconcilePayment(companyKey, id, input, actor);
}

/** Push an imported payment to SAP (ORCT + RCT4 + invoice link) — delegates to
 * the shared payments push so there's a single SAP-write path. */
export async function pushImportedPayment(
  companyKey: string,
  id: string,
  invoiceDocEntryOverride: number | undefined,
  actor: ActorMeta,
) {
  await loadImportedEntry(companyKey, id);
  return pushPayment(companyKey, id, invoiceDocEntryOverride, actor);
}

/**
 * Runs the matcher across every cheque on the day and persists `auto`
 * decisions for high-confidence rows. Doesn't touch rows already at
 * `manual` or `rejected` (the user's call survives) — only re-evaluates
 * `unmatched` and `auto` rows.
 */
export async function autoMatchDay(
  companyKey: string,
  isoDate: string,
  actor: ActorMeta,
) {
  const date = isoDateToUTC(isoDate);
  const models = await getTenantModelsFor(companyKey);
  const day = await models.DaybookDay.findOne({ date });
  if (!day) throw new NotFoundError('DaybookDay');

  const ctx = await buildContext(models, day.livraisons);

  let autoSet = 0;
  let cleared = 0;
  const updatedAt = new Date();

  day.livraisons.forEach((l, i) => {
    const persisted = (l.match ?? {}) as ExistingMatch;
    if (persisted.status === 'manual' || persisted.status === 'rejected') return;

    const decision = decideMatch(l, ctx);
    if (decision.autoEligible && decision.proposed) {
      day.livraisons[i].match = {
        status: 'auto',
        invoiceDocEntry: decision.proposed.invoiceDocEntry,
        invoiceDocNum: decision.proposed.invoiceDocNum,
        invoiceTotal: decision.proposed.docTotal,
        invoiceBalance: decision.proposed.balance,
        invoiceDate: decision.proposed.docDate,
        matchScore: decision.proposed.score,
        matchReason: decision.proposed.reason,
        matchedByEmail: 'system',
        matchedAt: updatedAt,
        notes: '',
      } as never;
      autoSet++;
    } else if (persisted.status === 'auto') {
      // Previously auto-matched but no longer eligible (e.g. SAP cache moved on).
      day.livraisons[i].match = { status: 'unmatched' } as never;
      cleared++;
    }
  });

  await day.save();

  await audit({
    action: 'daybook.match.auto',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    subjectType: 'DaybookDay',
    subjectId: isoDate,
    companyKey,
    after: { rows: day.livraisons.length, autoSet, cleared },
    ip: actor.ip,
  });

  return getReconciliation(companyKey, isoDate);
}

/**
 * Push matched (auto/manual) LIVRAISONS cheques to SAP as IncomingPayments.
 * Skips already-pushed rows so a re-click is idempotent. Returns a per-row
 * outcome list plus aggregate counts. After the push, the caller should
 * re-fetch the reconciliation view to see updated statuses.
 */
export async function pushDay(
  companyKey: string,
  isoDate: string,
  actor: ActorMeta,
  onlyIndexes?: number[],
): Promise<PushSummary & { postPushSync: PreReconcileSyncResult | null }> {
  const date = isoDateToUTC(isoDate);
  const models = await getTenantModelsFor(companyKey);
  const exists = await models.DaybookDay.findOne({ date }).select({ _id: 1 }).lean();
  if (!exists) throw new NotFoundError('DaybookDay');
  const summary = await pushMatchedLivraisons({
    companyKey,
    isoDate,
    models,
    actor,
    onlyIndexes,
  });

  // Narrow re-sync so the cross-source discrepancy check doesn't flag our own
  // freshly-pushed rows as "missing from the daybook". Best-effort: a sync
  // failure mustn't mask a successful push outcome — log and continue.
  let postPushSync: PreReconcileSyncResult | null = null;
  try {
    postPushSync = await preReconcileSync(companyKey, models, isoDate);
  } catch (err) {
    logger.warn(
      { err, companyKey, isoDate },
      'daybook.push.post_sync_failed',
    );
  }

  return { ...summary, postPushSync };
}

/**
 * Push POS over-payments to SAP as on-account payments. Returns a per-row
 * outcome plus aggregate counts, and runs the same narrow post-push re-sync
 * as `pushDay` so the discrepancy view stays consistent.
 */
export async function pushPosExtras(
  companyKey: string,
  isoDate: string,
  actor: ActorMeta,
  onlyIndexes?: number[],
): Promise<PosExtraSummary & { postPushSync: PreReconcileSyncResult | null }> {
  const date = isoDateToUTC(isoDate);
  const models = await getTenantModelsFor(companyKey);
  const exists = await models.DaybookDay.findOne({ date }).select({ _id: 1 }).lean();
  if (!exists) throw new NotFoundError('DaybookDay');
  const summary = await pushPosExtrasForDay({
    companyKey,
    isoDate,
    models,
    actor,
    onlyIndexes,
  });

  let postPushSync: PreReconcileSyncResult | null = null;
  try {
    postPushSync = await preReconcileSync(companyKey, models, isoDate);
  } catch (err) {
    logger.warn(
      { err, companyKey, isoDate },
      'daybook.push_pos_extras.post_sync_failed',
    );
  }

  return { ...summary, postPushSync };
}

/**
 * Manually set, change, or clear the match decision for one livraison line.
 * `invoiceDocEntry: null` with `status: 'rejected'` means "I checked and
 * none of the candidates apply"; `status: 'unmatched'` means "leave it open
 * for re-evaluation".
 */
export async function setLineMatch(
  companyKey: string,
  isoDate: string,
  lineIndex: number,
  patch: {
    status: 'manual' | 'rejected' | 'unmatched';
    invoiceDocEntry?: number | null;
    notes?: string;
  },
  actor: ActorMeta,
) {
  const date = isoDateToUTC(isoDate);
  const models = await getTenantModelsFor(companyKey);
  const day = await models.DaybookDay.findOne({ date });
  if (!day) throw new NotFoundError('DaybookDay');
  if (lineIndex < 0 || lineIndex >= day.livraisons.length) {
    throw new BadRequestError('Line index out of range');
  }

  const before = day.livraisons[lineIndex].match
    ? { ...day.livraisons[lineIndex].match }
    : null;
  const updatedAt = new Date();

  if (patch.status === 'manual') {
    if (!patch.invoiceDocEntry) {
      throw new BadRequestError('invoiceDocEntry required for status=manual');
    }
    // Look the invoice up in the SAP cache so we capture the snapshot of
    // its balance at decision time.
    const invModel = models.Invoice as unknown as Model<Record<string, unknown>>;
    const inv = (await invModel
      .findOne({ DocEntry: patch.invoiceDocEntry })
      .select({
        DocEntry: 1,
        DocNum: 1,
        DocDate: 1,
        DocTotal: 1,
        PaidToDate: 1,
        CardCode: 1,
      })
      .lean()) as Record<string, unknown> | null;
    if (!inv) throw new NotFoundError(`Invoice DocEntry ${patch.invoiceDocEntry}`);
    const docTotal = Number(inv.DocTotal ?? 0);
    const paidToDate = Number(inv.PaidToDate ?? 0);
    day.livraisons[lineIndex].match = {
      status: 'manual',
      invoiceDocEntry: Number(inv.DocEntry),
      invoiceDocNum: Number(inv.DocNum ?? 0),
      invoiceTotal: docTotal,
      invoiceBalance: +(docTotal - paidToDate).toFixed(2),
      invoiceDate: inv.DocDate
        ? inv.DocDate instanceof Date
          ? inv.DocDate
          : new Date(String(inv.DocDate))
        : null,
      matchScore: null,
      matchReason: 'manual',
      matchedByEmail: actor.email,
      matchedAt: updatedAt,
      notes: patch.notes ?? '',
    } as never;
  } else if (patch.status === 'rejected') {
    day.livraisons[lineIndex].match = {
      status: 'rejected',
      invoiceDocEntry: null,
      invoiceDocNum: null,
      invoiceTotal: null,
      invoiceBalance: null,
      invoiceDate: null,
      matchScore: null,
      matchReason: 'user-rejected',
      matchedByEmail: actor.email,
      matchedAt: updatedAt,
      notes: patch.notes ?? '',
    } as never;
  } else {
    day.livraisons[lineIndex].match = { status: 'unmatched' } as never;
  }

  await day.save();

  await audit({
    action: 'daybook.match.set',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    subjectType: 'DaybookDay',
    subjectId: `${isoDate}#${lineIndex}`,
    companyKey,
    before: before ? { match: before } : undefined,
    after: { match: day.livraisons[lineIndex].match },
    ip: actor.ip,
  });

  return getReconciliation(companyKey, isoDate);
}

/**
 * Cross-day failed-push queue. Walks every DaybookDay in the last 30 days
 * and flattens livraisons + posExtraPayments rows whose push attempt failed
 * (`match.status === 'push-failed'` or `posExtraPayments[].status ===
 * 'push-failed'`). Returns one row per failed push so the workbench retry
 * queue can show + retry them in bulk.
 */
export interface FailedPushRow {
  kind: 'livraison' | 'posExtra';
  date: string;
  lineIndex: number;
  codeClient: string;
  clientName: string;
  amount: number | null;
  method: string;
  pushError: string;
  pushErrorAt: string | null;
  pushAttempts: number;
}

export async function listFailedPushes(companyKey: string): Promise<{
  items: FailedPushRow[];
}> {
  const models = await getTenantModelsFor(companyKey);
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const days = await models.DaybookDay.find({ date: { $gte: cutoff } })
    .select({ date: 1, livraisons: 1, posExtraPayments: 1 })
    .sort({ date: -1 })
    .lean();

  const items: FailedPushRow[] = [];
  for (const d of days) {
    const isoDate = d.date.toISOString().slice(0, 10);

    (d.livraisons ?? []).forEach((l, idx) => {
      if (l.match?.status !== 'push-failed') return;
      const methods: Array<{ method: string; amount: number }> = [];
      if (typeof l.montant === 'number' && l.montant > 0) methods.push({ method: 'Cheque', amount: l.montant });
      if (typeof l.montantEspeces === 'number' && l.montantEspeces > 0) methods.push({ method: 'Cash', amount: l.montantEspeces });
      if (typeof l.montantCBSite === 'number' && l.montantCBSite > 0) methods.push({ method: 'CB-Site', amount: l.montantCBSite });
      if (typeof l.montantCBPhone === 'number' && l.montantCBPhone > 0) methods.push({ method: 'CB-Phone', amount: l.montantCBPhone });
      if (typeof l.montantVirement === 'number' && l.montantVirement > 0) methods.push({ method: 'Bank', amount: l.montantVirement });

      const primary = methods[0] ?? { method: 'Cheque', amount: l.montant ?? null };
      items.push({
        kind: 'livraison',
        date: isoDate,
        lineIndex: idx,
        codeClient: l.codeClient ?? '',
        clientName: l.clientName ?? '',
        amount: primary.amount,
        method: methods.length > 1 ? methods.map((m) => m.method).join('+') : primary.method,
        pushError: l.match?.pushError ?? '',
        pushErrorAt: l.match?.pushErrorAt ? new Date(l.match.pushErrorAt).toISOString() : null,
        pushAttempts: l.match?.pushAttempts ?? 0,
      });
    });

    (d.posExtraPayments ?? []).forEach((p, idx) => {
      if (p.status !== 'push-failed') return;
      items.push({
        kind: 'posExtra',
        date: isoDate,
        lineIndex: idx,
        codeClient: p.codeClient ?? '',
        clientName: p.clientName ?? '',
        amount: typeof p.amount === 'number' ? p.amount : null,
        method: p.method ?? 'card',
        pushError: p.pushError ?? '',
        pushErrorAt: p.pushErrorAt ? new Date(p.pushErrorAt).toISOString() : null,
        pushAttempts: 0,
      });
    });
  }

  return { items };
}
