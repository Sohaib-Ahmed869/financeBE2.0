import { Types } from 'mongoose';
import { getTenantModelsFor } from '../../db/tenant';
import { audit } from '../../lib/audit';
import { BadRequestError, NotFoundError } from '../../lib/errors';
import { parseZReport, type ParsedZReport } from './zreports.parser';
import { applyZReportToDaybook } from '../daybook/daybook.zreport';

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

function isoDateToUTC(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

function expectedCashFrom(parsed: ReturnType<typeof parseZReport>): number {
  // Expected = cash receipts + float - expenses paid out of the drawer.
  const cash = parsed.totals.cash ?? 0;
  const float = parsed.float ?? 0;
  return +(cash + float - parsed.expenses).toFixed(2);
}

export async function uploadZReport(
  companyKey: string,
  file: UploadFile,
  override: { date?: string },
  actor: ActorMeta,
) {
  if (!file?.buffer || file.size === 0) throw new BadRequestError('Empty upload');
  const parsed = parseZReport(file.buffer);

  const dateIso = override.date ?? parsed.date;
  if (!dateIso) {
    throw new BadRequestError(
      "Couldn't infer the report date from the file. Pass a `date=YYYY-MM-DD` query param to override.",
    );
  }
  const date = isoDateToUTC(dateIso);
  const expectedCash = expectedCashFrom(parsed);
  // Prefer the Z Summary's net discrepancy when present; fall back to the
  // legacy cash-only drawerGap calc for old CSV exports.
  const drawerGap =
    parsed.netDiscrepancy !== null
      ? parsed.netDiscrepancy
      : parsed.countedCash === null
        ? null
        : +(parsed.countedCash - expectedCash).toFixed(2);

  const models = await getTenantModelsFor(companyKey);

  const docPayload: Record<string, unknown> = {
    totals: parsed.totals,
    countedCash: parsed.countedCash,
    float: parsed.float,
    expectedCash,
    drawerGap,
    expenses: parsed.expenses,
    expenseBreakdown: parsed.expenseBreakdown,
    drawerAudit: parsed.drawerAudit,
    drawerCounted: parsed.drawerCounted,
    drawerDiscrepancy: parsed.drawerDiscrepancy,
    netDiscrepancy: parsed.netDiscrepancy,
    accountReceipts: parsed.accountReceipts,
    rows: parsed.rows.map((r) => ({
      receiptRef: r.receiptRef,
      time: r.time,
      cardCode: r.cardCode,
      cardName: r.cardName,
      method: r.method,
      amount: r.amount,
      raw: r.raw,
    })),
  };

  const existing = await models.ZReport.findOne({ branch: companyKey, date });
  const doc = existing
    ? await models.ZReport.findOneAndUpdate(
        { _id: existing._id },
        {
          $set: {
            ...docPayload,
            status: 'pending-counted',
            matchedSapPaymentIds: [],
          },
        },
        { new: true },
      )
    : await models.ZReport.create({
        branch: companyKey,
        date,
        ...docPayload,
        status: 'pending-counted',
      });

  if (!doc) throw new BadRequestError('Failed to persist Z-report');

  // Materialize the Z-report's POS-side numbers onto that day's daybook so the
  // user doesn't have to retype them. Manual edits to the day take precedence
  // (the daybook layer enforces "manual wins").
  await applyZReportToDaybook(models, date, parsed);

  await audit({
    action: existing ? 'zreport.reupload' : 'zreport.upload',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    subjectType: 'ZReport',
    subjectId: doc._id.toString(),
    companyKey,
    after: {
      date: dateIso,
      rows: parsed.rows.length,
      totals: parsed.totals,
      drawerGap,
    },
    ip: actor.ip,
  });

  return {
    id: doc._id.toString(),
    date: doc.date,
    totals: doc.totals,
    expectedCash: doc.expectedCash,
    countedCash: doc.countedCash,
    drawerGap: doc.drawerGap,
    rows: doc.rows.length,
    warnings: parsed.warnings,
  };
}

export async function listZReports(companyKey: string) {
  const models = await getTenantModelsFor(companyKey);
  const items = await models.ZReport.find({ branch: companyKey })
    .sort({ date: -1 })
    .select({
      _id: 1,
      date: 1,
      totals: 1,
      expectedCash: 1,
      countedCash: 1,
      drawerGap: 1,
      status: 1,
      rows: 1,
      verifiedAt: 1,
      verifiedByEmail: 1,
    })
    .lean();
  return {
    items: items.map((z) => ({
      id: z._id.toString(),
      date: z.date,
      totals: z.totals,
      expectedCash: z.expectedCash,
      countedCash: z.countedCash,
      drawerGap: z.drawerGap,
      status: z.status,
      rowCount: z.rows?.length ?? 0,
      verifiedAt: z.verifiedAt ?? null,
      verifiedByEmail: z.verifiedByEmail ?? null,
    })),
  };
}

export async function getZReport(companyKey: string, isoDate: string) {
  const date = isoDateToUTC(isoDate);
  const models = await getTenantModelsFor(companyKey);
  const z = await models.ZReport.findOne({ branch: companyKey, date }).lean();
  if (!z) throw new NotFoundError('ZReport');

  // Match per-receipt rows against cached SAP Payments. Best-effort:
  // SAP POS payments carry the cardCode + amount + date; we match by
  // (cardCode, amount, same day). The till already auto-posts these so
  // we expect a row for nearly every receipt.
  const dayStart = new Date(date);
  const dayEnd = new Date(date);
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
  const sapPayments = (await models.Payment.find({
    DocDate: { $gte: dayStart, $lt: dayEnd },
  })
    .select({ DocEntry: 1, CardCode: 1, DocTotal: 1, CashSum: 1, U_POS_Source: 1 })
    .lean()) as unknown as Array<{
    DocEntry: number;
    CardCode: string;
    DocTotal: number;
    CashSum?: number;
  }>;

  // Index by cardCode → list of payments not yet claimed.
  const byCard = new Map<string, Array<{ DocEntry: number; amount: number; claimed: boolean }>>();
  for (const p of sapPayments) {
    const key = (p.CardCode ?? '').toUpperCase();
    const list = byCard.get(key) ?? [];
    list.push({ DocEntry: p.DocEntry, amount: p.DocTotal ?? p.CashSum ?? 0, claimed: false });
    byCard.set(key, list);
  }

  const rowsOut = (z.rows ?? []).map((r, i) => {
    const key = (r.cardCode ?? '').toUpperCase();
    const candidates = byCard.get(key) ?? [];
    let matchedDocEntry: number | null = r.matchedSapPaymentDocEntry ?? null;
    if (!matchedDocEntry) {
      const hit = candidates.find(
        (c) => !c.claimed && Math.abs((c.amount ?? 0) - (r.amount ?? 0)) < 0.01,
      );
      if (hit) {
        hit.claimed = true;
        matchedDocEntry = hit.DocEntry;
      }
    }
    return {
      index: i,
      receiptRef: r.receiptRef,
      time: r.time,
      cardCode: r.cardCode,
      cardName: r.cardName,
      method: r.method,
      amount: r.amount,
      matchedSapPaymentDocEntry: matchedDocEntry,
      matched: Boolean(matchedDocEntry),
    };
  });

  const matchedCount = rowsOut.filter((r) => r.matched).length;
  const orphanSapPayments = sapPayments.filter(
    (p) => !byCard.get((p.CardCode ?? '').toUpperCase())?.find((c) => c.claimed && c.DocEntry === p.DocEntry),
  );

  return {
    id: z._id.toString(),
    date: z.date,
    totals: z.totals,
    expectedCash: z.expectedCash,
    countedCash: z.countedCash,
    drawerGap: z.drawerGap,
    drawerAudit: z.drawerAudit ?? { cash: null, card: null, cheque: null },
    drawerCounted: z.drawerCounted ?? { cash: null, card: null, cheque: null },
    drawerDiscrepancy: z.drawerDiscrepancy ?? { cash: null, card: null, cheque: null },
    netDiscrepancy: z.netDiscrepancy ?? null,
    accountReceipts: z.accountReceipts ?? [],
    expenses: z.expenses,
    expenseBreakdown: z.expenseBreakdown ?? [],
    float: z.float,
    status: z.status,
    rows: rowsOut,
    rowsTotal: rowsOut.length,
    rowsMatched: matchedCount,
    rowsUnmatched: rowsOut.length - matchedCount,
    sapPaymentsCount: sapPayments.length,
    orphanSapPaymentsCount: orphanSapPayments.length,
    verifiedAt: z.verifiedAt ?? null,
    verifiedByEmail: z.verifiedByEmail ?? null,
  };
}

export async function setCountedCash(
  companyKey: string,
  isoDate: string,
  countedCash: number,
  actor: ActorMeta,
) {
  const date = isoDateToUTC(isoDate);
  const models = await getTenantModelsFor(companyKey);
  const z = await models.ZReport.findOne({ branch: companyKey, date });
  if (!z) throw new NotFoundError('ZReport');
  const expected = z.expectedCash ?? 0;
  z.countedCash = countedCash;
  z.drawerGap = +(countedCash - expected).toFixed(2);
  await z.save();
  await audit({
    action: 'zreport.counted_cash',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    subjectType: 'ZReport',
    subjectId: z._id.toString(),
    companyKey,
    after: { countedCash, drawerGap: z.drawerGap, expectedCash: expected },
    ip: actor.ip,
  });
  return getZReport(companyKey, isoDate);
}

export async function verifyZReport(
  companyKey: string,
  isoDate: string,
  actor: ActorMeta,
) {
  const date = isoDateToUTC(isoDate);
  const models = await getTenantModelsFor(companyKey);
  const z = await models.ZReport.findOne({ branch: companyKey, date });
  if (!z) throw new NotFoundError('ZReport');
  z.verifiedAt = new Date();
  z.verifiedByEmail = actor.email;
  z.status =
    z.drawerGap === null || z.drawerGap === undefined
      ? 'pending-counted'
      : Math.abs(z.drawerGap) > 0.5
        ? 'discrepant'
        : 'verified';
  await z.save();
  await audit({
    action: 'zreport.verify',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    subjectType: 'ZReport',
    subjectId: z._id.toString(),
    companyKey,
    after: { status: z.status, drawerGap: z.drawerGap },
    ip: actor.ip,
  });
  return getZReport(companyKey, isoDate);
}
