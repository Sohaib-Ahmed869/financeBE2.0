import type { Types } from 'mongoose';
import type { getTenantModelsFor } from '../../db/tenant';
import type { ParsedZReport } from '../zreports/zreports.parser';

type Models = Awaited<ReturnType<typeof getTenantModelsFor>>;

/**
 * Push the POS-side numbers from a Z-report into that day's daybook so the
 * user never has to retype them. Idris's instruction from the 14/05/2026
 * call: "POS this stuff you should take from this Excel. We shouldn't have
 * to do it again."
 *
 * Three blocks are filled completely from the POS report and stay editable in
 * the day editor:
 *   - POS Card Terminal (`caisseCB`)        — drawer card total
 *   - POS Cheques (`caisseCheques`)         — one line per cheque receipt + total
 *   - Expenses (`depenses`)                 — one line per PETTY memo + total
 * plus `caisseEspeces.total` and `differenceFondCaisse`.
 *
 * The cheque and expense line-items are derived from the per-receipt rows /
 * expense breakdown, so the lines shown always sum to the block's total. A
 * re-upload resets these POS-side fields to the file's values (it's an
 * explicit "use the till's numbers here" action — see the note on the update
 * branch below). A day that doesn't exist yet is created with `source: 'excel'`.
 */
export async function applyZReportToDaybook(
  models: Models,
  date: Date,
  parsed: ParsedZReport,
): Promise<void> {
  const existing = await models.DaybookDay.findOne({ date }).lean();

  // Prefer the counted (In Drawer) values when present; fall back to audit so
  // the day always reads with the till's totals even before the user has
  // verified the drawer.
  const cashPos = parsed.drawerCounted.cash ?? parsed.drawerAudit.cash ?? null;
  const cardPos = parsed.drawerCounted.card ?? parsed.drawerAudit.card ?? null;
  const chequePos = parsed.drawerCounted.cheque ?? parsed.drawerAudit.cheque ?? null;

  // POS Cheques — one editable line per cheque receipt (customer + amount).
  // The block's total is the sum of its own lines so the listing stays
  // self-consistent; fall back to the drawer cheque figure when the file
  // carried no per-receipt cheque rows.
  const chequeLines = parsed.rows
    .filter((r) => r.method === 'cheque')
    .map((r) => ({ client: r.cardName || r.cardCode || '', montant: r.amount }));
  const chequesTotal = chequeLines.length
    ? +chequeLines.reduce((a, c) => a + (c.montant ?? 0), 0).toFixed(2)
    : chequePos;

  // Expenses — one editable line per PETTY memo (negative-cash lines the
  // parser already split out of the receipts block).
  const depenseLines = parsed.expenseBreakdown.map((e) => ({
    label: e.label,
    amount: e.amount,
  }));
  const depensesTotal = depenseLines.length ? parsed.expenses : null;

  if (!existing) {
    await models.DaybookDay.updateOne(
      { date },
      {
        $set: {
          source: 'excel',
          date,
          dayOfMonth: date.getUTCDate(),
          sheetName: '',
          totals: {
            especes: cashPos,
            cheques: chequePos,
            carteCredit: cardPos,
            virement: null,
          },
          caisseEspeces: {
            billets50: null,
            billets20: null,
            billets10: null,
            billets5: null,
            monnaie: null,
            total: cashPos,
            fondCaisse: null,
          },
          caisseCheques: chequeLines,
          caisseChequesTotal: chequesTotal,
          caisseCB: {
            till: cardPos,
            sansContact: null,
            total: cardPos,
          },
          differenceFondCaisse: parsed.netDiscrepancy,
          depenses: depenseLines,
          depensesTotal,
          livraisons: [],
          parseWarnings: [],
        },
      },
      { upsert: true },
    );
    return;
  }

  // Always patch the POS-side fields, even on `source: 'manual'` days. A
  // Z-report upload is an explicit "use the till's numbers here" action by
  // the user — it shouldn't be silently swallowed by the "manual wins"
  // rule, which exists for blind daybook re-imports. Driver deliveries
  // (livraisons), expenses, and bank deposits live elsewhere on the day
  // and stay untouched.
  await models.DaybookDay.updateOne(
    { date },
    {
      $set: {
        'caisseEspeces.total': cashPos,
        'caisseCB.till': cardPos,
        'caisseCB.total': cardPos,
        caisseCheques: chequeLines,
        caisseChequesTotal: chequesTotal,
        depenses: depenseLines,
        depensesTotal,
        differenceFondCaisse: parsed.netDiscrepancy,
        // Mirror onto the day-level totals so the Excel export / day-card
        // headline numbers carry the POS contribution.
        'totals.especes': cashPos,
        'totals.cheques': chequesTotal,
        'totals.carteCredit': cardPos,
      },
    },
  );
}
