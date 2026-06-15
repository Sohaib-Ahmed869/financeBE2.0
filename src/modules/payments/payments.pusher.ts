import type { HydratedDocument } from 'mongoose';
import { sapPost } from '../../sap/client';
import { AppError } from '../../lib/errors';
import { logger } from '../../lib/logger';
import type { IPaymentEntry } from '../../models/tenant/PaymentEntry';
import { SAP_TABLE_BY_METHOD } from '../../models/tenant/PaymentEntry';

/**
 * Method-aware push to SAP B1 IncomingPayments.
 *
 * Builds the right ORCT + RCT1/2/3/4 body for each payment method and POSTs
 * it. Mirrors the v1 (HalalSales) shape that has been the production push
 * path against this same tenant for years — `CashSum` carries the grand total
 * regardless of method, and the per-method details live in the matching
 * sub-collection.
 *
 *   Cheque   → PaymentChecks    (RCT2)
 *   Bank     → TransferSum      (RCT1, top-level fields, not a sub-collection)
 *   Cash     → CashSum-only     (RCT3 — the OPdf "cash account" path)
 *   CB-Site  → PaymentCreditCards (RCT4)
 *   CB-Phone → PaymentCreditCards (RCT4)
 *   PayPal   → PaymentCreditCards (RCT4)
 *   Account  → no push (this method = "leave invoice open / non payé")
 *   POS      → no push (POS posts via the till; we verify, never write)
 */

export interface SapPushResult {
  sapDocEntry: number;
  sapDocNum: number | null;
  sapTable: 'RCT1' | 'RCT2' | 'RCT3' | 'RCT4';
}

interface BuildContext {
  /** ISO date "YYYY-MM-DD" — used as DocDate / DueDate / TaxDate. */
  isoDate: string;
  remarksPrefix?: string;
}

function isoDateOf(date: Date | string): string {
  if (typeof date === 'string') return date.slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function remarksFor(entry: IPaymentEntry, prefix?: string): string {
  const head = prefix ?? `Payment ${isoDateOf(entry.date)}`;
  switch (entry.method) {
    case 'Cheque': {
      const num = entry.cheque?.chequeNumber || '(no #)';
      const bank = entry.cheque?.bankCode || 'no bank';
      return `${head} — cheque ${num} (${bank})`;
    }
    case 'Bank': {
      const ref = entry.bank?.transferReference || '(no ref)';
      return `${head} — virement ${ref}`;
    }
    case 'Cash':
      return `${head} — espèces`;
    case 'CB-Site':
      return `${head} — CB site${entry.card?.transactionId ? ` ${entry.card.transactionId}` : ''}`;
    case 'CB-Phone':
      return `${head} — CB téléphone${entry.card?.transactionId ? ` ${entry.card.transactionId}` : ''}`;
    case 'PayPal':
      return `${head} — PayPal${entry.card?.transactionId ? ` ${entry.card.transactionId}` : ''}`;
    default:
      return head;
  }
}

interface BuildArgs {
  entry: IPaymentEntry;
  /**
   * SAP DocEntry of the invoice to apply against, or `null` for on-account
   * (no PaymentInvoices link — the receipt goes to the customer's account).
   */
  invoiceDocEntry: number | null;
  appliedAmount: number;
  ctx: BuildContext;
}

/**
 * Builds the SAP IncomingPayments POST body for one PaymentEntry. The payment
 * is either applied to a specific invoice (creates an RCT2 row via the
 * `PaymentInvoices` array) or posted on-account (no PaymentInvoices — the
 * receipt sits against the customer's AR control account).
 * Public-by-export so tests can pin the exact wire shape.
 */
export function buildIncomingPaymentBody({
  entry,
  invoiceDocEntry,
  appliedAmount,
  ctx,
}: BuildArgs) {
  const cardCode = entry.cardCode.toUpperCase();
  const dueDate = ctx.isoDate;
  const remarks = remarksFor(entry, ctx.remarksPrefix);

  // SAP B1 Service Layer computes the payment's grand total as:
  //   CashSum + TransferSum + Σ(PaymentChecks[].CheckSum) + Σ(PaymentCreditCards[].CreditSum)
  // So we MUST set only the field matching the actual method. Sending both
  // CashSum AND PaymentChecks doubles the payment total in SAP (and leaves
  // the surplus on the customer's account).
  const base = {
    DocType: 'rCustomer',
    CardCode: cardCode,
    DocDate: dueDate,
    TaxDate: dueDate,
    DocCurrency: entry.currency || 'EUR',
    Remarks: remarks,
    ...(invoiceDocEntry !== null
      ? {
          PaymentInvoices: [
            {
              DocEntry: invoiceDocEntry,
              InvoiceType: 'it_Invoice',
              SumApplied: appliedAmount,
            },
          ],
        }
      : {}),
  } as const;

  switch (entry.method) {
    case 'Cheque': {
      const raw = entry.cheque?.chequeNumber || '';
      const checkNumberInt = /^\d+$/.test(raw) ? Number(raw) : null;
      // SAP validates BankCode against its per-country bank master. The team
      // records the drawer bank as a free-typed abbreviation ("SG", "BNP"…),
      // which is NOT a SAP bank code, so SAP rejects it
      // ("country/region or bank wrong"). A cheque payment posts fine with an
      // EMPTY BankCode (confirmed against cheque payments already in SAP —
      // BankCode "", CountryCode "FR", HandWritten tNO, CheckAccount auto-
      // filled). So only pass a BankCode when it's a real numeric SAP code;
      // otherwise leave it blank and let SAP default the check account.
      const bankCode = entry.cheque?.bankCode || '';
      return {
        ...base,
        PaymentChecks: [
          {
            ...(checkNumberInt !== null ? { CheckNumber: checkNumberInt } : {}),
            BankCode: /^\d+$/.test(bankCode) ? bankCode : '',
            CountryCode: 'FR',
            DueDate: dueDate,
            CheckSum: appliedAmount,
          },
        ],
      };
    }
    case 'Bank': {
      // RCT1 — top-level TransferSum + TransferReference.
      return {
        ...base,
        TransferSum: appliedAmount,
        TransferReference: entry.bank?.transferReference || '',
        TransferAccount: entry.bank?.bankAccount || '',
      };
    }
    case 'Cash': {
      // RCT3 — cash. The configured CashAccount is picked up SAP-side.
      return {
        ...base,
        CashSum: appliedAmount,
      };
    }
    case 'CB-Site':
    case 'CB-Phone':
    case 'PayPal': {
      // RCT4 — credit card / online processors. SAP's PaymentCreditCards row
      // requires three fields or it rejects the post ("Payment means
      // specification missing"): a credit-card master code (CreditCard), a
      // CardValidUntil date, and a VoucherNum. The code comes from the SAP
      // credit-card master (OCRC) for this tenant: 1 = CARTE BLEUE (the CB
      // site/phone gateway), 2 = PAYPAL. CardValidUntil is a placeholder
      // far-future date — online gateways carry no card expiry we track.
      const creditCardCode = entry.method === 'PayPal' ? 2 : 1;
      const voucherNum = entry.card?.transactionId || `${entry.method}-${dueDate}`;
      return {
        ...base,
        PaymentCreditCards: [
          {
            CreditCard: creditCardCode,
            CardValidUntil: '2030-01-01',
            VoucherNum: voucherNum,
            CreditSum: appliedAmount,
          },
        ],
      };
    }
    default:
      throw new AppError(
        `Method ${entry.method} cannot be pushed to SAP`,
        400,
        'PAYMENT_NOT_PUSHABLE',
      );
  }
}

interface PushArgs {
  companyKey: string;
  entry: HydratedDocument<IPaymentEntry>;
  /** SAP DocEntry of the target invoice, or `null` for an on-account push. */
  invoiceDocEntry: number | null;
  appliedAmount: number;
  isoDate?: string;
}

/**
 * Push one payment entry to SAP. Throws an AppError on failure; the caller
 * (service layer) decides whether to mark the entry `failed` or rethrow.
 *
 * Idempotency: callers must check `entry.status === 'pushed'` before
 * invoking. We don't double-check here so retries-after-failure work cleanly.
 */
export async function pushPaymentToSap({
  companyKey,
  entry,
  invoiceDocEntry,
  appliedAmount,
  isoDate,
}: PushArgs): Promise<SapPushResult> {
  const sapTable = SAP_TABLE_BY_METHOD[entry.method];
  if (sapTable === 'NONE') {
    throw new AppError(
      `Method ${entry.method} does not push to SAP (non payé / POS)`,
      400,
      'PAYMENT_NOT_PUSHABLE',
    );
  }

  const body = buildIncomingPaymentBody({
    entry,
    invoiceDocEntry,
    appliedAmount,
    ctx: { isoDate: isoDate ?? isoDateOf(entry.date) },
  });

  const response = await sapPost<{ DocEntry?: number; DocNum?: number }>(
    companyKey,
    '/IncomingPayments',
    body,
  );

  const sapDocEntry = response?.DocEntry;
  if (!sapDocEntry) {
    throw new AppError(
      'SAP returned 200 but no DocEntry — refusing to claim a successful push',
      502,
      'SAP_NO_DOCENTRY',
      response,
    );
  }

  logger.info(
    `payments.push ok ${isoDateOf(entry.date)} method=${entry.method} → SAP DocEntry=${sapDocEntry}`,
  );

  return {
    sapDocEntry,
    sapDocNum: response.DocNum ?? null,
    sapTable: sapTable as 'RCT1' | 'RCT2' | 'RCT3' | 'RCT4',
  };
}
