import { z } from 'zod';

const yearMonthSchema = z
  .string()
  .regex(/^\d{4}-\d{2}$/, 'Use YYYY-MM format');

export const monthParamSchema = z.object({ yearMonth: yearMonthSchema });

export const sapDocEntryParamSchema = z.object({
  sapDocEntry: z.coerce.number().int().positive(),
});

export const discrepancyIdParamSchema = z.object({
  discrepancyId: z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id'),
});

export const matchHistoricalSchema = z.object({
  invoiceDocEntry: z.number().int().positive(),
  appliedAmount: z.number().finite().min(0).optional(),
});
export type MatchHistoricalInput = z.infer<typeof matchHistoricalSchema>;

export const resolveDiscrepancySchema = z.object({
  action: z.enum([
    'manual-match',
    'split-match',
    'apply-credit-note',
    'create-correction-entry',
    'override-amount',
    'mark-fraudulent',
    'mark-duplicate',
    'mark-wont-fix',
    'other',
  ]),
  reason: z.string().trim().max(500).optional(),
  wontFix: z.boolean().optional().default(false),
});
export type ResolveDiscrepancyInput = z.infer<typeof resolveDiscrepancySchema>;
