import { z } from 'zod';
import { ENTITY_SLUGS } from '../../sap/entityConfig';

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');

export const entityParamSchema = z.object({
  entity: z.enum(ENTITY_SLUGS as [string, ...string[]]),
});

export const jobIdParamSchema = z.object({ id: objectId });

export const syncBodySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  pageSize: z.coerce.number().int().min(1).max(500).optional(),
  maxDocs: z.coerce.number().int().min(1).optional(),
  /**
   * When true, block the HTTP response until the sync finishes. Useful for
   * Postman testing and small pulls. Defaults to false (returns 202 + jobId).
   */
  wait: z.boolean().optional().default(false),
});

export const listJobsQuerySchema = z.object({
  entity: z.string().optional(),
  status: z
    .enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted'])
    .optional(),
  triggeredByEmail: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type SyncBodyInput = z.infer<typeof syncBodySchema>;
export type ListJobsQuery = z.infer<typeof listJobsQuerySchema>;
