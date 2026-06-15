import { z } from 'zod';

export const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');

export const createRoleSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).default(''),
  /** null = template (not assignable directly) */
  companyKey: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9-]+$/)
    .nullable()
    .default(null),
  permissionKeys: z.array(z.string().min(1)).default([]),
});

export const updateRoleSchema = z
  .object({
    name: z.string().min(1).max(80).optional(),
    description: z.string().max(500).optional(),
    permissionKeys: z.array(z.string().min(1)).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field required' });

export const listRolesQuerySchema = z.object({
  companyKey: z.string().optional(),
  q: z.string().trim().max(80).optional(),
});

export type CreateRoleInput = z.infer<typeof createRoleSchema>;
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;
export type ListRolesQuery = z.infer<typeof listRolesQuerySchema>;
