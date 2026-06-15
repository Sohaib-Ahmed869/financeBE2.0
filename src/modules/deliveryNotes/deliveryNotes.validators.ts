import { z } from 'zod';

export const listQuerySchema = z.object({
  status: z.enum(['open', 'closed', 'all']).optional(),
  cardCode: z.string().trim().min(1).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type ListQuery = z.infer<typeof listQuerySchema>;

export const docEntryParamSchema = z.object({
  docEntry: z.coerce.number().int().positive(),
});

export const bulkConvertSchema = z.object({
  docEntries: z
    .array(z.number().int().positive())
    .min(1, 'Pick at least one delivery note')
    .max(200, 'Convert at most 200 at a time'),
});
export type BulkConvertInput = z.infer<typeof bulkConvertSchema>;
