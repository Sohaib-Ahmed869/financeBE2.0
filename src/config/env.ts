import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  MASTER_MONGO_URI: z.string().min(1, 'MASTER_MONGO_URI required'),

  TENANT_PARIS_MONGO_URI: z.string().optional(),
  TENANT_BORDEAUX_MONGO_URI: z.string().optional(),
  TENANT_LYON_MONGO_URI: z.string().optional(),

  SAP_BASE_URL_PARIS: z.string().optional(),
  SAP_BASE_URL_BORDEAUX: z.string().optional(),
  SAP_BASE_URL_LYON: z.string().optional(),
  SAP_COMPANY_DB_PARIS: z.string().optional(),
  SAP_COMPANY_DB_BORDEAUX: z.string().optional(),
  SAP_COMPANY_DB_LYON: z.string().optional(),
  SAP_USERNAME_PARIS: z.string().optional(),
  SAP_PASSWORD_PARIS: z.string().optional(),
  SAP_USERNAME_BORDEAUX: z.string().optional(),
  SAP_PASSWORD_BORDEAUX: z.string().optional(),
  SAP_USERNAME_LYON: z.string().optional(),
  SAP_PASSWORD_LYON: z.string().optional(),

  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY must be 64 hex chars (32 bytes)'),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 chars'),
  COOKIE_NAME: z.string().default('hff_session'),
  CSRF_COOKIE_NAME: z.string().default('hff_csrf'),
  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(8),

  CLIENT_ORIGIN: z.string().default('http://localhost:5173'),

  SEED_SOHAIB_EMAIL: z.string().email().optional(),
  SEED_SOHAIB_PASSWORD: z.string().optional(),
  SEED_IDRIS_EMAIL: z.string().email().optional(),
  SEED_IDRIS_PASSWORD: z.string().optional(),
  SEED_ACCOUNTANT_PARIS_EMAIL: z.string().email().optional(),
  SEED_ACCOUNTANT_PARIS_PASSWORD: z.string().optional(),
  SEED_ACCOUNTANT_BORDEAUX_EMAIL: z.string().email().optional(),
  SEED_ACCOUNTANT_BORDEAUX_PASSWORD: z.string().optional(),
  SEED_ACCOUNTANT_LYON_EMAIL: z.string().email().optional(),
  SEED_ACCOUNTANT_LYON_PASSWORD: z.string().optional(),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('❌ Invalid environment configuration:');
  // eslint-disable-next-line no-console
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;

export const isProd = env.NODE_ENV === 'production';
export const isDev = env.NODE_ENV === 'development';
