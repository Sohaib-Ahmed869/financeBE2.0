# June 2026 test dataset — end-to-end pipeline run

A coherent, self-consistent set of June 2026 data so the whole finance pipeline
can run **without a live SAP**. Card codes, amounts and dates across the seed and
the import files all line up, so reconciliation, matching and bank verification
all produce real (non-empty, non-trivial) results.

Two parts:

1. **DB seed** — customers, 10 open invoices, 3 open delivery notes, and a SAP
   payment mirror. Run once. (Invoices/customers normally come from SAP sync;
   this injects them directly.)
2. **Import files** (this folder) — you upload these yourself through the app /
   API to drive the pipeline.

---

## 0. One-time setup

```bash
cd be
npm run seed                              # master data (companies/users) — if not already done
npx ts-node scripts/seed-june2026.ts      # << the June 2026 tenant data (Paris)
npm run dev                               # start the API on :4000
```

Then log in (Idris or the Paris accountant) and select **Paris** as the active
company. Every API call below needs the auth cookie + the `X-Company: paris`
header (the UI sets these for you).

Re-running `seed-june2026.ts` is safe — it upserts by key.

---

## 1. What got seeded (the reconcile targets)

**8 customers:** C9999 vente comptoir · C2983 FIRAT · C2422 YUNUS ·
C2622 CHICKEN ASIA · C4494 MCV DAUMESNIL · C2336 O.F.C · C6819 UGUR SARL ·
C3050 KEBAB HOUSE.

**10 open invoices** (`DocumentStatus: 'O'`, `PaidToDate: 0`) — each is the
reconcile target for one payment method:

| DocEntry | DocNum | Customer        | Date       | Total    | Intended payment |
|---------:|-------:|-----------------|------------|---------:|------------------|
| 5001 | 12001 | C2622 CHICKEN ASIA | 2026-06-02 | 1240.50 | **Cheque** |
| 5002 | 12002 | C4494 MCV DAUMESNIL| 2026-06-02 | 284.64  | **Bank** transfer |
| 5003 | 12003 | C6819 UGUR SARL    | 2026-06-03 | 980.00  | **CB-Site** (Sogecommerce) |
| 5004 | 12004 | C2983 FIRAT        | 2026-06-03 | 156.30  | **PayPal** |
| 5005 | 12005 | C2422 YUNUS        | 2026-06-04 | 432.75  | **Cash** |
| 5006 | 12006 | C3050 KEBAB HOUSE  | 2026-06-04 | 610.20  | **CB-Phone** |
| 5007 | 12007 | C2336 O.F.C        | 2026-06-05 | 271.40  | **POS** (Z-report cheque) |
| 5008 | 12008 | C2622 CHICKEN ASIA | 2026-06-05 | 540.00  | **Account** (leave unpaid) |
| 5009 | 12009 | C4494 MCV DAUMESNIL| 2026-06-08 | 825.90  | open |
| 5010 | 12010 | C6819 UGUR SARL    | 2026-06-09 | 1110.00 | open receivable |

**3 open delivery notes** (DocEntry 4001-4003) for the morning *convert to
invoice* screen. Listing/selecting works offline; the convert **action** posts
to SAP, so that one step needs a live SAP.

**7 SAP payment-mirror rows** (DocEntry 9001-9007) — what bank reconciliation
verifies against (see §5).

---

## 2. Payments — entry → reconcile → push (the core flow)

There is no payment import file; payments are entered through the sheet UI (or
the API). Enter one per invoice to exercise every RCT sub-table. Example via API:

```bash
# Cheque against invoice 5001 (CHICKEN ASIA, 1240.50) -> RCT2
curl -X POST $API/api/payments -H 'X-Company: paris' -H 'Content-Type: application/json' --cookie "$COOKIE" -d '{
  "date":"2026-06-02","cardCode":"C2622","method":"Cheque","amount":1240.50,
  "cheque":{"chequeNumber":"8801234","bankCode":"30002","bankName":"BRED","payerName":"CHICKEN ASIA","chequeDate":"2026-06-02"}
}'
# -> returns { id }. Then reconcile to the invoice, then push:
curl -X PUT  $API/api/payments/<id>/match -H 'X-Company: paris' --cookie "$COOKIE" -H 'Content-Type: application/json' -d '{"invoiceDocEntry":5001}'
curl -X POST $API/api/payments/<id>/push  -H 'X-Company: paris' --cookie "$COOKIE"
```

Method → SAP table cheat-sheet: `Cheque`→RCT2, `Bank`→RCT1, `Cash`/`POS`→RCT3,
`CB-Site`/`CB-Phone`/`PayPal`→RCT4, `Account`→no push (outstanding receivable).

Suggested entries (each matches the table above): 5001 Cheque, 5002 Bank,
5003 CB-Site, 5004 PayPal, 5005 Cash, 5006 CB-Phone. For 5008 use `method:"Account"`
and reconcile with `{"onAccount":true}` (no SAP push). The `push` step calls the
real SAP Service Layer — without SAP creds it returns `status:"failed"` with the
SAP error captured; match + entry still work fully.

---

## 3. POS verification — `050626 ZREPORT JUIN.XLSX`

```
POST /api/zreports/upload?date=2026-06-05      (multipart field: file)
```
Parses to: cash 196.47 / cheque 271.40 / card 110.19, float 600, expenses 298.99,
one **account receipt** (C2622 CHICKEN ASIA 246.63), and a **drawer gap of
-6.47** (Z-Summary net discrepancy). This is the exception the morning queue
surfaces. Receipt C2336/271.40 lines up with invoice 5007.

Then set counted cash / verify:
```
PUT  /api/zreports/2026-06-05/counted-cash   { "countedCash": 190 }
POST /api/zreports/2026-06-05/verify
```

---

## 4. Daybook — `Feuille de solde Juin 2026.xlsx`

```
POST /api/daybook/upload                       (multipart field: file)
GET  /api/daybook/months/2026/6/export         (round-trip / parity export)
```
Four day-sheets (2-5 June) with distinct per-day totals and a **LIVRAISONS**
block whose rows mirror the seeded deliveries (cheque/virement on the 2nd,
CB-site on the 3rd, cash + CB-phone on the 4th, an unpaid delivery on the 5th).
Filename must keep the `Juin 2026` month/year — the parser reads it from the name.

---

## 5. Bank reconciliation — `BANK JUIN 2026.csv`  (verification only, no SAP write)

```
POST /api/bank-statements/upload     body: bankKey=bred   (multipart field: file)
POST /api/bank-statements/<id>/auto-match
```
7 lines (`;`-delimited, FR decimals). Bank deposit lines are matched against the
**daily total per method** of the seeded SAP payments (§1, rows 9001-9007). This
produces all three outcomes on purpose:

- **matched:** 02/06 cheque 1240.50 · 02/06 bank 284.64 · 03/06 card 1136.30
  (980 + 156.30) · 04/06 cash 432.75 (envelope `NO00042`) · 04/06 card 610.20
- **missing in bank:** seeded SAP payment 9005 (O.F.C bank 175.00 on 03/06) has
  **no** matching bank line
- **unexplained bank line:** 06/06 `VIREMENT RECU SCI HORIZON` 500.00 has no SAP
  payment; 05/06 `COMMISSION CARTE BANCAIRE` -12.40 is a non-payment fee to tag

No SAP write happens here — this is the verification half of the flow.

---

## 6. Card imports

```
POST /api/card-imports/upload?provider=paypal              file = PAYPAL JUIN 2026.CSV
POST /api/card-imports/upload?provider=sogecommerce-site   file = Listing_transactions_remisees_juin.xlsx
POST /api/card-imports/upload-remises                      file = Listing_remises_juin.xlsx
```
- **PayPal:** one customer payment (FIRAT 156.30 → invoice 5004) + one bank sweep.
- **Sogecommerce transactions:** UGUR 980.00 (→5003) and KEBAB 610.20 (→5006);
  a third row is `Rejeté` and is correctly skipped by the parser.
- **Sogecommerce remises:** settlement batches R20260604 / R20260605.

Rows land as `pending` until you assign a CardCode (`PUT /card-imports/rows/:rowId/assign`),
which teaches a learned pattern for next time (PAN→CardCode, email/name→CardCode).

---

## One command: run the whole pipeline as a test

`scripts/e2e-june2026.js` logs in, sets the tenant + CSRF, and drives **every**
pipeline through the live API, then prints a PASS/FAIL table. Run the seed +
dev server first (§0), then:

```bash
node scripts/e2e-june2026.js          # offline pipeline — currently 41/41 PASS
node scripts/e2e-june2026.js --quiet  # same, summary only
```

It exercises: SAP login · Z-report (parsed totals + drawer gap) · daybook
(4 day-sheets + parity export) · bank recon (5 matched + missing-in-bank) ·
card imports (PayPal / Sogecommerce / remises, Rejeté skipped) · payment
entry→match for all 6 methods + on-account · delivery-note listing.

## Live SAP push (the only part that writes to SAP) — one command

```bash
npm run demo:sap        # = seed-sap-june2026.js  &&  e2e-june2026.js --with-sap
```

This creates 6 fresh open invoices in the SAP **test** company (one per payment
method), then runs the whole pipeline and pushes a real IncomingPayment against
each — landing in every RCT sub-table (Cheque→RCT2, Bank→RCT1, Cash→RCT3,
CB-Site/CB-Phone/PayPal→RCT4). Last verified run: **59/59 PASS**, e.g. invoice
closes with `PaidToDate == DocTotal` in SAP.

Notes:
- **Run it as the pair** (`npm run demo:sap`), not `--with-sap` alone. Each push
  closes its invoice in SAP, so a second `--with-sap` against the same invoices
  fails with *"Invoice is already closed"*. `seed-sap` makes fresh invoices
  (new DocEntry) every run.
- **Prerequisite (one-time, in SAP):** a daily **GBP exchange rate** must exist
  for the invoice DocDate (we use `2026-06-01`). Without it SAP rejects with
  `Update the exchange rate , 'GBP'`. Override the date with `SAP_INV_DATE=YYYY-MM-DD`.
- `seed-sap-june2026.js` is guarded to `MSF_HALAL_TEST` only, uses service-type
  invoices (revenue account `707000`, VAT group `C3`, no stock needed), and
  captures SAP's real DocEntry/DocTotal into `sap-invoices.json`; the push pays
  the exact DocTotal.

## Regenerating the files

```bash
node scripts/gen-june2026-imports.js     # rewrites every file in this folder
npx ts-node scripts/validate-june2026.ts # parses them back through the real parsers
```
