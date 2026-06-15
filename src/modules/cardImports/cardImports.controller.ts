import multer from 'multer';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../lib/asyncHandler';
import { BadRequestError, UnauthorizedError } from '../../lib/errors';
import {
  uploadCardImport,
  uploadRemiseFile,
  listCardImports,
  getCardImport,
  assignCardCode,
  type CardProvider,
} from './cardImports.service';

const ipOf = (req: { ip?: string; headers?: Record<string, unknown> }): string =>
  ((req.headers?.['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || '');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ok =
      /\.(csv|xls|xlsx)$/i.test(file.originalname)
      || /text|csv|sheet|excel/.test(file.mimetype);
    if (!ok) return cb(new BadRequestError('CSV / XLS / XLSX files only'));
    cb(null, true);
  },
});

export const uploadMiddleware: RequestHandler = upload.single('file');

const providerSchema = z
  .enum(['sogecommerce-site', 'sogecommerce-phone', 'paypal'])
  .optional();

export const upload_ = asyncHandler<unknown, unknown, unknown, { provider?: CardProvider }>(
  async (req, res) => {
    if (!req.auth) throw new UnauthorizedError();
    if (!req.tenant) throw new BadRequestError('No active company');
    const f = (req as unknown as { file?: Express.Multer.File }).file;
    if (!f) throw new BadRequestError('Attach the file as form field "file"');
    const providerParsed = providerSchema.safeParse(req.query?.provider);
    const result = await uploadCardImport(
      req.tenant.companyKey,
      { originalname: f.originalname, buffer: f.buffer, size: f.size },
      { provider: providerParsed.success ? providerParsed.data : undefined },
      { userId: req.auth.userId, email: req.auth.email, ip: ipOf(req) },
    );
    res.status(201).json(result);
  },
);

export const uploadRemises = asyncHandler(async (req, res) => {
  if (!req.auth) throw new UnauthorizedError();
  if (!req.tenant) throw new BadRequestError('No active company');
  const f = (req as unknown as { file?: Express.Multer.File }).file;
  if (!f) throw new BadRequestError('Attach the file as form field "file"');
  const result = await uploadRemiseFile(
    req.tenant.companyKey,
    { originalname: f.originalname, buffer: f.buffer, size: f.size },
    { userId: req.auth.userId, email: req.auth.email, ip: ipOf(req) },
  );
  res.status(201).json(result);
});

export const list = asyncHandler(async (req, res) => {
  if (!req.auth) throw new UnauthorizedError();
  if (!req.tenant) throw new BadRequestError('No active company');
  res.json(await listCardImports(req.tenant.companyKey));
});

export const detail = asyncHandler<{ id: string }>(async (req, res) => {
  if (!req.auth) throw new UnauthorizedError();
  if (!req.tenant) throw new BadRequestError('No active company');
  res.json(await getCardImport(req.tenant.companyKey, req.params.id));
});

const assignBody = z.object({
  cardCode: z.string().trim().min(1),
  cardName: z.string().trim().optional(),
  createPaymentEntry: z.boolean().optional(),
});
export type AssignBody = z.infer<typeof assignBody>;

export const assignBodySchema = assignBody;

export const assign = asyncHandler<{ rowId: string }, unknown, AssignBody>(
  async (req, res) => {
    if (!req.auth) throw new UnauthorizedError();
    if (!req.tenant) throw new BadRequestError('No active company');
    const result = await assignCardCode(
      req.tenant.companyKey,
      req.params.rowId,
      req.body,
      { userId: req.auth.userId, email: req.auth.email, ip: ipOf(req) },
    );
    res.json(result);
  },
);
