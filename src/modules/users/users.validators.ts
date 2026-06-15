import { z } from 'zod';

export const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');

export const createUserSchema = z.object({
  email: z.string().email().toLowerCase(),
  name: z.string().min(1).max(120),
  password: z
    .string()
    .min(10, 'Password must be at least 10 characters')
    .max(200)
    .regex(/[A-Z]/, 'Must contain an uppercase letter')
    .regex(/[a-z]/, 'Must contain a lowercase letter')
    .regex(/[0-9]/, 'Must contain a digit'),
  language: z.enum(['en', 'fr']).default('fr'),
  isSuperAdmin: z.boolean().optional().default(false),
});

export const updateUserSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    language: z.enum(['en', 'fr']).optional(),
    active: z.boolean().optional(),
    isSuperAdmin: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field required' });

export const resetPasswordSchema = z.object({
  newPassword: z
    .string()
    .min(10)
    .max(200)
    .regex(/[A-Z]/)
    .regex(/[a-z]/)
    .regex(/[0-9]/),
});

export const listUsersQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  active: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
