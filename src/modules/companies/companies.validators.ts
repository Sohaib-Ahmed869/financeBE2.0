import { z } from 'zod';

export const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');

export const companyKeySchema = z
  .string()
  .min(2)
  .max(40)
  .regex(/^[a-z0-9-]+$/, 'Use lowercase letters, digits, and hyphens only');

export const createCompanySchema = z.object({
  key: companyKeySchema,
  name: z.string().min(1).max(160),
  mongoUri: z.string().min(10).max(2000),
  sap: z.object({
    baseUrl: z.string().url().or(z.literal('')).default(''),
    companyDB: z.string().max(120).default(''),
    username: z.string().max(120).default(''),
    password: z.string().max(400).default(''),
  }),
  posUdfFieldName: z.string().max(80).default('U_POS_Source'),
  currency: z.string().length(3).default('EUR'),
  timezone: z.string().max(80).default('Europe/Paris'),
  locale: z.string().max(10).default('fr-FR'),
});

export const updateCompanySchema = z
  .object({
    name: z.string().min(1).max(160).optional(),
    mongoUri: z.string().min(10).max(2000).optional(),
    posUdfFieldName: z.string().max(80).optional(),
    currency: z.string().length(3).optional(),
    timezone: z.string().max(80).optional(),
    locale: z.string().max(10).optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field required' });

export const rotateSapSchema = z.object({
  baseUrl: z.string().url().optional(),
  companyDB: z.string().max(120).optional(),
  username: z.string().max(120).optional(),
  password: z.string().max(400).optional(),
});

export const keyParamSchema = z.object({ key: companyKeySchema });

export const updateOwnCompanyCardCodesSchema = z.object({
  cardCodes: z
    .array(z.string().trim().min(1).max(64))
    .max(500, 'Too many card codes (max 500)'),
});

export type CreateCompanyInput = z.infer<typeof createCompanySchema>;
export type UpdateCompanyInput = z.infer<typeof updateCompanySchema>;
export type RotateSapInput = z.infer<typeof rotateSapSchema>;
export type UpdateOwnCompanyCardCodesInput = z.infer<
  typeof updateOwnCompanyCardCodesSchema
>;
