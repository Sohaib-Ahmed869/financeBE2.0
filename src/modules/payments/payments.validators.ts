import { z } from 'zod';
import { PaymentMethods } from '../../models/tenant/PaymentEntry';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');

const chequeDetails = z.object({
  chequeNumber: z.string().trim().max(50).optional(),
  bankCode: z.string().trim().max(50).optional(),
  bankName: z.string().trim().max(120).optional(),
  payerName: z.string().trim().max(120).optional(),
  chequeDate: isoDate.optional(),
});

const cardDetails = z.object({
  processor: z.enum(['sogecommerce-site', 'sogecommerce-phone', 'paypal']).optional(),
  authCode: z.string().trim().max(50).optional(),
  transactionId: z.string().trim().max(100).optional(),
  maskedPan: z
    .string()
    .trim()
    .max(8)
    .regex(/^\d{0,4}$/, 'Last 4 only — never store full PAN')
    .optional(),
  cardBrand: z.string().trim().max(40).optional(),
});

const bankDetails = z.object({
  transferReference: z.string().trim().max(120).optional(),
  bankAccount: z.string().trim().max(120).optional(),
  counterpartyName: z.string().trim().max(120).optional(),
  counterpartyIban: z.string().trim().max(40).optional(),
});

export const dateParamSchema = z.object({ date: isoDate });

export const paymentIdParamSchema = z.object({ id: objectId });

export const listQuerySchema = z.object({
  date: isoDate.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  cardCode: z.string().trim().min(1).optional(),
  method: z.enum(PaymentMethods).optional(),
  status: z
    .enum(['draft', 'matched', 'push-pending', 'pushed', 'failed', 'voided'])
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type ListPaymentsQuery = z.infer<typeof listQuerySchema>;

export const createPaymentSchema = z
  .object({
    date: isoDate,
    cardCode: z.string().trim().min(1, 'cardCode required'),
    cardName: z.string().trim().max(200).optional(),
    method: z.enum(PaymentMethods),
    amount: z.number().finite().min(0),
    currency: z.string().trim().length(3).default('EUR'),
    cheque: chequeDetails.optional(),
    card: cardDetails.optional(),
    bank: bankDetails.optional(),
    notes: z.string().max(500).optional(),
    sourceType: z
      .enum(['manual', 'paypal-import', 'sogecommerce-import', 'bank-statement', 'z-report'])
      .default('manual'),
    sourceLineRef: z.string().max(200).optional(),
    tags: z.array(z.string().trim().max(40)).max(20).optional(),
  })
  .refine(
    (v) => {
      // Account = "leave invoice open" — no method-detail subdoc.
      if (v.method === 'Account') return true;
      // Cheque must carry the cheque sub-doc (number is technically optional
      // — some banks; bankCode is required for the SAP push to work cleanly).
      if (v.method === 'Cheque') return Boolean(v.cheque);
      if (v.method === 'Bank') return Boolean(v.bank);
      if (v.method === 'CB-Site' || v.method === 'CB-Phone' || v.method === 'PayPal') {
        return Boolean(v.card);
      }
      return true;
    },
    { message: 'Method-specific details missing for this payment method' },
  );
export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;

export const updatePaymentSchema = createPaymentSchema.innerType().partial();
export type UpdatePaymentInput = z.infer<typeof updatePaymentSchema>;

export const reconcileSchema = z
  .object({
    // Omitted → null (clear match / on-account). Explicit null also clears.
    invoiceDocEntry: z.number().int().positive().nullable().default(null),
    /**
     * "On-account" mode — apply to the customer's account instead of a
     * specific invoice. When true, `invoiceDocEntry` must be null. The
     * subsequent SAP push omits PaymentInvoices; the receipt lands against
     * the BP's AR control account.
     */
    onAccount: z.boolean().optional().default(false),
    appliedAmount: z.number().finite().min(0).optional(),
    matchedVia: z
      .enum(['manual', 'rule', 'embedding', 'sap-native', 'envelope-match', 'learned'])
      .default('manual'),
    notes: z.string().max(500).optional(),
  })
  .refine(
    (v) => !(v.onAccount && v.invoiceDocEntry !== null),
    { message: 'onAccount is mutually exclusive with invoiceDocEntry' },
  );
export type ReconcileInput = z.infer<typeof reconcileSchema>;

export const pushPaymentSchema = z.object({
  /** Optional override — defaults to the entry's matched invoice. */
  invoiceDocEntry: z.number().int().positive().optional(),
});
export type PushPaymentInput = z.infer<typeof pushPaymentSchema>;

export const autoMatchDaySchema = z.object({}).partial();

export const voidPaymentSchema = z.object({
  reason: z.string().trim().min(1, 'Reason required').max(500),
});
export type VoidPaymentInput = z.infer<typeof voidPaymentSchema>;
