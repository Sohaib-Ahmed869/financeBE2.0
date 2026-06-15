/**
 * One-off: load the 14/05/2026 Z-report sample into the Paris tenant DB,
 * verify the daybook day picked up the POS totals. Mirrors what the
 * /api/zreports/upload endpoint would do, but skips auth and runs against
 * the local Mongo directly.
 */
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { ZReportSchema } from '../src/models/tenant/ZReport';
import { DaybookDaySchema } from '../src/models/tenant/DaybookDay';
import { parseZReport } from '../src/modules/zreports/zreports.parser';
import { applyZReportToDaybook } from '../src/modules/daybook/daybook.zreport';

const TENANT_URI = process.env.TENANT_PARIS_MONGO_URI;
const COMPANY_KEY = 'paris';
const ISO_DATE = '2026-05-14';
const FILE = path.resolve(__dirname, '../data/140526 EXCEL.XLSX');

async function main() {
  if (!TENANT_URI) throw new Error('TENANT_PARIS_MONGO_URI not set in be/.env');

  const conn = await mongoose.createConnection(TENANT_URI).asPromise();

  const ZReport = conn.model('ZReport', ZReportSchema, 'zreports');
  const DaybookDay = conn.model('DaybookDay', DaybookDaySchema, 'daybook_days');

  const buf = fs.readFileSync(FILE);
  const parsed = parseZReport(buf);
  console.log('Parsed Z-report:', {
    date: parsed.date,
    totals: parsed.totals,
    drawerAudit: parsed.drawerAudit,
    drawerCounted: parsed.drawerCounted,
    drawerDiscrepancy: parsed.drawerDiscrepancy,
    netDiscrepancy: parsed.netDiscrepancy,
    rows: parsed.rows.length,
    accountReceipts: parsed.accountReceipts.length,
    float: parsed.float,
    expenses: parsed.expenses,
  });

  const date = new Date(`${ISO_DATE}T00:00:00.000Z`);

  // Same logic as zreports.service.uploadZReport, condensed for this script.
  const expectedCash = +((parsed.totals.cash ?? 0) + (parsed.float ?? 0) - parsed.expenses).toFixed(2);
  const drawerGap =
    parsed.netDiscrepancy !== null
      ? parsed.netDiscrepancy
      : parsed.countedCash === null
        ? null
        : +(parsed.countedCash - expectedCash).toFixed(2);

  await ZReport.updateOne(
    { branch: COMPANY_KEY, date },
    {
      $set: {
        branch: COMPANY_KEY,
        date,
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
        rows: parsed.rows,
        status: 'pending-counted',
      },
    },
    { upsert: true },
  );
  console.log('ZReport upserted for', COMPANY_KEY, ISO_DATE);

  // Materialise into the daybook day.
  const models = { ZReport, DaybookDay } as unknown as Parameters<typeof applyZReportToDaybook>[0];
  await applyZReportToDaybook(models, date, parsed);

  const day = await DaybookDay.findOne({ date }).lean();
  console.log('\nDaybookDay after import:');
  console.log({
    source: day?.source,
    dayOfMonth: day?.dayOfMonth,
    'totals.especes': day?.totals?.especes,
    'totals.carteCredit': day?.totals?.carteCredit,
    'totals.cheques': day?.totals?.cheques,
    'caisseEspeces.total': day?.caisseEspeces?.total,
    'caisseCB.total': day?.caisseCB?.total,
    caisseChequesTotal: day?.caisseChequesTotal,
    differenceFondCaisse: day?.differenceFondCaisse,
  });

  await conn.close();
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
