import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const dateParamSchema = z.object({ date: isoDate });
export const docEntryParamSchema = z.object({
  docEntry: z.coerce.number().int().positive(),
});

export const listQuerySchema = z.object({
  date: isoDate.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  cardCode: z.string().trim().min(1).optional(),
  status: z.enum(['open', 'closed', 'all']).optional(),
  unpaidFlag: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type ListInvoicesQuery = z.infer<typeof listQuerySchema>;

const lineSchema = z.object({
  ItemCode: z.string().trim().min(1, 'ItemCode required'),
  Quantity: z.number().finite().min(0),
  UnitPrice: z.number().finite().min(0).optional(),
  LineTotal: z.number().finite().min(0).optional(),
  TaxCode: z.string().trim().max(20).optional(),
  ItemDescription: z.string().max(200).optional(),
});

export const createInvoiceSchema = z.object({
  date: isoDate,
  cardCode: z.string().trim().min(1, 'cardCode required'),
  docDueDate: isoDate.optional(),
  docCurrency: z.string().trim().length(3).default('EUR'),
  comments: z.string().max(500).optional(),
  lines: z.array(lineSchema).min(1, 'At least one line required'),
});
export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;

export const markUnpaidSchema = z.object({
  unpaidFlag: z.boolean(),
  reason: z.string().trim().max(500).optional(),
});
export type MarkUnpaidInput = z.infer<typeof markUnpaidSchema>;
