import { Types } from 'mongoose';
import type { TenantModels } from '../../models/tenant';
import type { IPaymentEntry, PaymentMethod } from '../../models/tenant/PaymentEntry';
import { buildIncomingPaymentBody as buildPaymentBody } from '../payments/payments.pusher';
import { sapPost } from '../../sap/client';
import { logger } from '../../lib/logger';
import { audit } from '../../lib/audit';
import { AppError, BadRequestError, NotFoundError } from '../../lib/errors';

/**
 * POS over-payment push pipeline.
 *
 * Each `posExtraPayments` row on a daybook day represents a customer who paid
 * more at the till than the invoice total. The till could only book the
 * invoice amount; the surplus has to be posted to SAP separately as a
 * payment-on-account.
 *
 *   method = 'card'   → CB-Site (RCT4)
 *   method = 'cash'   → Cash    (RCT3)
 *   method = 'cheque' → Cheque  (RCT2) — synthetic cheque-# if user left it blank
 *
 * On-account = no `PaymentInvoices` array (the existing `payments.pusher.ts`
 * builder handles that branch when `invoiceDocEntry` is `null`).
 */

type ExtraMethod = 'card' | 'cash' | 'cheque';

interface PushExtraArgs {
  companyKey: string;
  isoDate: string;
  actor: { userId: string; email: string; ip: string };
  /**
   * Optional whitelist of `posExtraPayments` indexes to push. If omitted,
   * every row not already in `status === 'pushed'` is attempted.
   */
  onlyIndexes?: number[];
}

export interface PosExtraOutcome {
  index: number;
  status: 'pushed' | 'failed' | 'skipped';
  method: ExtraMethod;
  amount: number;
  sapDocEntry?: number;
  sapDocNum?: number | null;
  paymentEntryId?: string;
  error?: string;
  reason?: string;
}

export interface PosExtraSummary {
  date: string;
  pushed: number;
  failed: number;
  skipped: number;
  results: PosExtraOutcome[];
}

function methodToPaymentMethod(m: ExtraMethod): PaymentMethod {
  switch (m) {
    case 'card':
      return 'CB-Site';
    case 'cash':
      return 'Cash';
    case 'cheque':
      return 'Cheque';
  }
}

interface ExtraRow {
  codeClient: string;
  clientName: string;
  method: ExtraMethod;
  amount: number;
  notes: string;
  status: string;
  sapDocEntry?: number | null;
}

export async function pushPosExtrasForDay({
  companyKey,
  isoDate,
  actor,
  onlyIndexes,
  models,
}: PushExtraArgs & { models: TenantModels }): Promise<PosExtraSummary> {
  const m = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new BadRequestError('Use YYYY-MM-DD');
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));

  const day = await models.DaybookDay.findOne({ date });
  if (!day) throw new NotFoundError('DaybookDay');

  const indexFilter = onlyIndexes ? new Set(onlyIndexes) : null;
  const summary: PosExtraSummary = {
    date: isoDate,
    pushed: 0,
    failed: 0,
    skipped: 0,
    results: [],
  };

  const dayId = day._id as Types.ObjectId;
  const dateMidnight = new Date(`${isoDate}T00:00:00.000Z`);

  for (let i = 0; i < (day.posExtraPayments ?? []).length; i++) {
    if (indexFilter && !indexFilter.has(i)) continue;
    const row = day.posExtraPayments[i] as unknown as ExtraRow;
    const method: ExtraMethod = (row.method as ExtraMethod) ?? 'card';
    const amount = row.amount ?? 0;
    const cardCode = (row.codeClient ?? '').trim().toUpperCase();

    if (row.status === 'pushed' && row.sapDocEntry) {
      summary.results.push({
        index: i,
        status: 'skipped',
        method,
        amount,
        sapDocEntry: row.sapDocEntry,
        reason: 'already-pushed',
      });
      summary.skipped++;
      continue;
    }
    if (!cardCode) {
      summary.results.push({
        index: i,
        status: 'skipped',
        method,
        amount,
        reason: 'no-card-code',
      });
      summary.skipped++;
      continue;
    }
    if (!amount || amount <= 0) {
      summary.results.push({
        index: i,
        status: 'skipped',
        method,
        amount,
        reason: 'no-amount',
      });
      summary.skipped++;
      continue;
    }

    const sourceLineRef = `posExtra:${i}:${method}`;
    const paymentMethod = methodToPaymentMethod(method);
    const chequeNumber =
      method === 'cheque' ? `POS-EXTRA-${isoDate}-${i + 1}` : '';

    // Upsert / refresh the PaymentEntry draft (sourceType='manual', onAccount=true).
    // We need a hydrated document for body building and post-success updates.
    let entry = await models.PaymentEntry.findOne({
      sourceFileId: dayId,
      sourceLineRef,
    });
    if (!entry) {
      entry = await models.PaymentEntry.create({
        cardCode,
        cardName: row.clientName ?? '',
        date: dateMidnight,
        method: paymentMethod,
        amount,
        currency: 'EUR',
        ...(method === 'cheque'
          ? { cheque: { chequeNumber, bankCode: '' } as IPaymentEntry['cheque'] }
          : {}),
        ...(method === 'card'
          ? { card: { processor: 'sogecommerce-site' } as IPaymentEntry['card'] }
          : {}),
        sourceType: 'manual',
        sourceFileId: dayId,
        sourceLineRef,
        onAccount: true,
        status: 'draft',
        enteredByEmail: actor.email,
        enteredAt: new Date(),
        notes:
          (row.notes ?? '') +
          (row.notes ? ' — ' : '') +
          `POS over-payment ${isoDate} row #${i + 1}`,
      });
    } else {
      entry.cardCode = cardCode;
      entry.cardName = row.clientName ?? '';
      entry.amount = amount;
      entry.method = paymentMethod;
      if (method === 'cheque') {
        entry.cheque = {
          chequeNumber: entry.cheque?.chequeNumber || chequeNumber,
          bankCode: entry.cheque?.bankCode || '',
        } as IPaymentEntry['cheque'];
      }
      entry.onAccount = true;
      await entry.save();
    }

    const remarksPrefix = `POS over-payment ${isoDate} row #${i + 1}`;
    let body;
    try {
      body = buildPaymentBody({
        entry: entry.toObject(),
        invoiceDocEntry: null,
        appliedAmount: amount,
        ctx: { isoDate, remarksPrefix },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      day.posExtraPayments[i].status = 'push-failed';
      day.posExtraPayments[i].pushError = message;
      day.posExtraPayments[i].pushErrorAt = new Date();
      summary.results.push({
        index: i,
        status: 'failed',
        method,
        amount,
        error: message,
      });
      summary.failed++;
      continue;
    }

    try {
      const response = await sapPost<{ DocEntry?: number; DocNum?: number }>(
        companyKey,
        '/IncomingPayments',
        body,
      );
      const sapDocEntry = response?.DocEntry;
      const sapDocNum = response?.DocNum ?? null;
      if (!sapDocEntry) {
        throw new AppError(
          'SAP returned 200 but no DocEntry — refusing to claim a successful push',
          502,
          'SAP_NO_DOCENTRY',
          response,
        );
      }

      entry.status = 'pushed';
      entry.sapDocEntry = sapDocEntry;
      entry.sapDocNum = sapDocNum;
      entry.sapPushedAt = new Date();
      entry.sapPushAttempts = (entry.sapPushAttempts ?? 0) + 1;
      entry.confirmedByEmail = actor.email;
      entry.confirmedAt = new Date();
      entry.sapLastError = '';
      await entry.save();

      day.posExtraPayments[i].status = 'pushed';
      day.posExtraPayments[i].sapDocEntry = sapDocEntry;
      day.posExtraPayments[i].sapDocNum = sapDocNum;
      day.posExtraPayments[i].pushedAt = new Date();
      day.posExtraPayments[i].paymentEntryId = entry._id as Types.ObjectId;
      day.posExtraPayments[i].pushError = '';
      day.posExtraPayments[i].pushErrorAt = null;

      summary.results.push({
        index: i,
        status: 'pushed',
        method,
        amount,
        sapDocEntry,
        sapDocNum,
        paymentEntryId: entry._id.toString(),
      });
      summary.pushed++;
      logger.info(
        `daybook.pos_extra.push ok ${isoDate} #${i} method=${method} → SAP DocEntry=${sapDocEntry}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        { err, companyKey, isoDate, index: i, method },
        'daybook.pos_extra.push.failed',
      );

      entry.status = 'failed';
      entry.sapPushAttempts = (entry.sapPushAttempts ?? 0) + 1;
      entry.sapLastError = message;
      entry.sapLastErrorAt = new Date();
      try {
        await entry.save();
      } catch (saveErr) {
        logger.error({ err: saveErr }, 'daybook.pos_extra.push.save_failed');
      }

      day.posExtraPayments[i].status = 'push-failed';
      day.posExtraPayments[i].pushError = message;
      day.posExtraPayments[i].pushErrorAt = new Date();

      summary.results.push({
        index: i,
        status: 'failed',
        method,
        amount,
        error: message,
      });
      summary.failed++;
    }
  }

  await day.save();

  await audit({
    action: 'daybook.push_pos_extras',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    subjectType: 'DaybookDay',
    subjectId: isoDate,
    companyKey,
    after: {
      pushed: summary.pushed,
      failed: summary.failed,
      indexes: summary.results.map((r) => r.index),
    },
    ip: actor.ip,
  });

  return summary;
}
