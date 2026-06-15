import { z } from 'zod';

const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');

export const grantAccessSchema = z.object({
  userId: objectId,
  companyKey: z.string().min(2).max(40).regex(/^[a-z0-9-]+$/),
  roleIds: z.array(objectId).min(1, 'At least one role is required'),
});

export const updateAccessSchema = z.object({
  roleIds: z.array(objectId).min(1, 'At least one role is required'),
});

export const revokeAccessSchema = z.object({
  reason: z.string().max(300).optional(),
});

export const listAccessQuerySchema = z.object({
  userId: objectId.optional(),
  companyKey: z.string().optional(),
  active: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
});

export const accessIdParam = z.object({ id: objectId });

export type GrantAccessInput = z.infer<typeof grantAccessSchema>;
export type UpdateAccessInput = z.infer<typeof updateAccessSchema>;
export type RevokeAccessInput = z.infer<typeof revokeAccessSchema>;
export type ListAccessQuery = z.infer<typeof listAccessQuerySchema>;
