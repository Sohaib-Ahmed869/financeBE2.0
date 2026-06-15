/**
 * Dumps the DaybookDay document stored in Mongo for a given (companyKey, date)
 * and the upstream DaybookFile that produced it. Use this to verify that an
 * import actually persisted every section (totals, remiseBancaire,
 * caisseEspeces, caisseCheques, caisseCB, depenses, livraisons) and not just
 * the cheques.
 *
 * Usage:
 *   npx tsx scripts/inspect-daybook-day.ts <companyKey> <YYYY-MM-DD>
 *   e.g.  npx tsx scripts/inspect-daybook-day.ts paris 2026-04-01
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { connectMaster } from '../src/db/master';
import { getTenantModelsFor, closeAllTenantConnections } from '../src/db/tenant';

async function main() {
  const [, , companyKey, isoDate] = process.argv;
  if (!companyKey || !isoDate) {
    console.error('Usage: inspect-daybook-day <companyKey> <YYYY-MM-DD>');
    process.exit(1);
  }
  const m = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) {
    console.error('Invalid date — use YYYY-MM-DD');
    process.exit(1);
  }
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));

  await connectMaster();
  const models = await getTenantModelsFor(companyKey);

  const day = await models.DaybookDay.findOne({ date }).lean();
  if (!day) {
    console.log(`No DaybookDay row for ${companyKey} / ${isoDate}.`);
  } else {
    console.log(`\n=== DaybookDay (${companyKey} / ${isoDate}) ===`);
    console.log('source:', day.source);
    console.log('fileId:', day.fileId?.toString() ?? null);
    console.log('sheetName:', day.sheetName);
    console.log('dayOfMonth:', day.dayOfMonth);
    console.log('\ntotals:', day.totals);
    console.log('remiseBancaire:', day.remiseBancaire);
    console.log('caisseEspeces:', day.caisseEspeces);
    console.log(
      'caisseCheques:',
      day.caisseCheques,
      'total=',
      day.caisseChequesTotal,
    );
    console.log('caisseCB:', day.caisseCB);
    console.log('differenceFondCaisse:', day.differenceFondCaisse);
    console.log('depenses:', day.depenses, 'total=', day.depensesTotal);
    console.log('livraisons:', day.livraisons?.length ?? 0, 'rows');
    if (day.livraisons?.length) {
      console.log('  first:', day.livraisons[0]);
    }
    console.log('parseWarnings:', day.parseWarnings);

    // Quick "is this field actually present" check — useful if the doc
    // somehow lost its top-of-day sections.
    const presence = {
      totals: day.totals != null && typeof day.totals === 'object',
      remiseBancaire:
        day.remiseBancaire != null && typeof day.remiseBancaire === 'object',
      caisseEspeces:
        day.caisseEspeces != null && typeof day.caisseEspeces === 'object',
      caisseCheques: Array.isArray(day.caisseCheques),
      caisseCB: day.caisseCB != null && typeof day.caisseCB === 'object',
      depenses: Array.isArray(day.depenses),
      livraisons: Array.isArray(day.livraisons),
    };
    console.log('\nField presence:', presence);
  }

  // Also list the DaybookFile(s) for that month so we can compare.
  const file = await models.DaybookFile.findOne({
    year: Number(m[1]),
    month: Number(m[2]),
  }).lean();
  if (file) {
    console.log('\n=== DaybookFile for this month ===');
    console.log('originalFilename:', file.originalFilename);
    console.log('sha256:', file.sha256);
    console.log('status:', file.status);
    console.log('daysParsed:', file.daysParsed);
    console.log('uploadedAt:', file.createdAt);
    console.log('parseErrors:', file.parseErrors);
  } else {
    console.log('\nNo DaybookFile in this tenant for that month.');
  }

  await closeAllTenantConnections();
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
