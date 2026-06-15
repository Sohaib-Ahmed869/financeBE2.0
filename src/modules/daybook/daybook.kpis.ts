import type { Model } from 'mongoose';
import { getTenantModelsFor } from '../../db/tenant';
import { BadRequestError } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { lookupCostAt } from '../itemCosts/itemCosts.service';
import type { DeliveryChannel } from './daybook.channelTagger';

/**
 * Month-level KPIs for the dashboard. Aggregates a (year, month) of
 * DaybookDay rows into:
 *
 *   - `byChannel` — count + revenue per `livraisons[].deliveryChannel` bucket
 *   - `total`    — sum of every method amount across every livraison
 *   - `nonPaye`  — sum of `montant` for rows flagged `nonPaye`
 *   - `posContribution` — POS revenue from the day's till blocks
 *     (caisseEspeces.total + caisseCB.total + caisseChequesTotal)
 *   - `costOfGoods` / `grossProfit` — best-effort, computed from the cached
 *     Invoice collection for the month + the per-item `costHistory` overlay.
 *     Returns `null` for both if no item has a cost overlay for the period.
 *
 * Idris's framing (14/05/2026): dashboard surfaces four channels and a
 * profitability rollup; we do the COGS join here so the FE just renders.
 */

const CHANNELS: DeliveryChannel[] = [
  'pos',
  'own-company',
  'external-transport',
  'own-delivery',
];

export interface MonthKpis {
  year: number;
  month: number;
  byChannel: Record<DeliveryChannel, { count: number; revenue: number }>;
  total: number;
  nonPaye: number;
  posContribution: number;
  costOfGoods: number | null;
  grossProfit: number | null;
}

function emptyByChannel(): Record<DeliveryChannel, { count: number; revenue: number }> {
  const out = {} as Record<DeliveryChannel, { count: number; revenue: number }>;
  for (const c of CHANNELS) out[c] = { count: 0, revenue: 0 };
  return out;
}

function lineAmount(l: {
  montant?: number | null;
  montantEspeces?: number | null;
  montantCBSite?: number | null;
  montantCBPhone?: number | null;
  montantVirement?: number | null;
}): number {
  return (
    (l.montant ?? 0) +
    (l.montantEspeces ?? 0) +
    (l.montantCBSite ?? 0) +
    (l.montantCBPhone ?? 0) +
    (l.montantVirement ?? 0)
  );
}

export async function getMonthKpis(
  companyKey: string,
  year: number,
  month: number,
): Promise<MonthKpis> {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new BadRequestError('Invalid year/month');
  }
  const models = await getTenantModelsFor(companyKey);
  const monthStart = new Date(Date.UTC(year, month - 1, 1));
  const monthEnd = new Date(Date.UTC(year, month, 1));

  const days = await models.DaybookDay.find({
    date: { $gte: monthStart, $lt: monthEnd },
  })
    .select({
      livraisons: 1,
      caisseEspeces: 1,
      caisseCB: 1,
      caisseChequesTotal: 1,
    })
    .lean();

  const byChannel = emptyByChannel();
  let total = 0;
  let nonPaye = 0;
  let posContribution = 0;

  for (const d of days) {
    posContribution +=
      (d.caisseEspeces?.total ?? 0) +
      (d.caisseCB?.total ?? 0) +
      (d.caisseChequesTotal ?? 0);

    for (const l of d.livraisons ?? []) {
      const channel = (l.deliveryChannel as DeliveryChannel) || 'own-delivery';
      const amount = lineAmount(l);
      const bucket = byChannel[channel] ?? byChannel['own-delivery'];
      bucket.count += 1;
      bucket.revenue += amount;
      total += amount;
      if (l.nonPaye && typeof l.montant === 'number') {
        nonPaye += l.montant;
      }
    }
  }

  // Best-effort cost-of-goods rollup from cached Invoices + Item.costHistory.
  // Skip lines whose item has no overlay covering the invoice's DocDate.
  let costOfGoods: number | null = null;
  let grossProfit: number | null = null;
  try {
    const invoiceModel = models.Invoice as unknown as Model<Record<string, unknown>>;
    const invoices = (await invoiceModel
      .find({ DocDate: { $gte: monthStart, $lt: monthEnd } })
      .select({ DocDate: 1, DocumentLines: 1 })
      .lean()) as Array<{
      DocDate?: Date | string | null;
      DocumentLines?: Array<{ ItemCode?: string; Quantity?: number | null }>;
    }>;

    let runningCost = 0;
    let anyMatched = false;
    for (const inv of invoices) {
      const rawDate = inv.DocDate;
      const docDate = rawDate
        ? rawDate instanceof Date
          ? rawDate
          : new Date(String(rawDate))
        : null;
      if (!docDate || Number.isNaN(docDate.getTime())) continue;
      for (const line of inv.DocumentLines ?? []) {
        const itemCode = (line.ItemCode ?? '').trim();
        const qty = Number(line.Quantity ?? 0);
        if (!itemCode || !Number.isFinite(qty) || qty <= 0) continue;
        const avgCost = await lookupCostAt(companyKey, itemCode, docDate);
        if (avgCost === null) continue;
        anyMatched = true;
        runningCost += qty * avgCost;
      }
    }
    if (anyMatched) {
      costOfGoods = +runningCost.toFixed(2);
      grossProfit = +(total - costOfGoods).toFixed(2);
    }
  } catch (err) {
    // COGS is best-effort — log and leave null. Don't fail the whole KPI call.
    logger.warn({ err, companyKey, year, month }, 'daybook.kpis.cogs_failed');
  }

  return {
    year,
    month,
    byChannel,
    total: +total.toFixed(2),
    nonPaye: +nonPaye.toFixed(2),
    posContribution: +posContribution.toFixed(2),
    costOfGoods,
    grossProfit,
  };
}
