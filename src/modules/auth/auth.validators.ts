import { z } from 'zod';

export const loginSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(1).max(200),
});

export const updateMeSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    language: z.enum(['en', 'fr']).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field required' });

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(200),
    newPassword: z
      .string()
      .min(10, 'Password must be at least 10 characters')
      .max(200)
      .regex(/[A-Z]/, 'Must contain an uppercase letter')
      .regex(/[a-z]/, 'Must contain a lowercase letter')
      .regex(/[0-9]/, 'Must contain a digit'),
  })
  .refine((v) => v.currentPassword !== v.newPassword, {
    message: 'New password must differ from current',
    path: ['newPassword'],
  });

export type LoginInput = z.infer<typeof loginSchema>;
export type UpdateMeInput = z.infer<typeof updateMeSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
