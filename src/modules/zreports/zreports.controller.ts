import multer from 'multer';
import type { RequestHandler } from 'express';
import { asyncHandler } from '../../lib/asyncHandler';
import { BadRequestError, UnauthorizedError } from '../../lib/errors';
import {
  uploadZReport,
  listZReports,
  getZReport,
  setCountedCash,
  verifyZReport,
} from './zreports.service';

const ipOf = (req: { ip?: string; headers?: Record<string, unknown> }): string =>
  ((req.headers?.['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || '');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ok =
      /\.(csv|tsv|txt|xlsx|xls)$/i.test(file.originalname)
      || /text|csv|sheet|excel/.test(file.mimetype);
    if (!ok) return cb(new BadRequestError('CSV, TSV or Excel files only'));
    cb(null, true);
  },
});

export const uploadMiddleware: RequestHandler = upload.single('file');

export const upload_ = asyncHandler<unknown, unknown, unknown, { date?: string }>(
  async (req, res) => {
    if (!req.auth) throw new UnauthorizedError();
    if (!req.tenant) throw new BadRequestError('No active company');
    const f = (req as unknown as { file?: Express.Multer.File }).file;
    if (!f) throw new BadRequestError('Attach the Z-report as form field "file"');
    const result = await uploadZReport(
      req.tenant.companyKey,
      { originalname: f.originalname, buffer: f.buffer, size: f.size },
      { date: req.query?.date },
      { userId: req.auth.userId, email: req.auth.email, ip: ipOf(req) },
    );
    res.status(201).json(result);
  },
);

export const list = asyncHandler(async (req, res) => {
  if (!req.auth) throw new UnauthorizedError();
  if (!req.tenant) throw new BadRequestError('No active company');
  res.json(await listZReports(req.tenant.companyKey));
});

export const detail = asyncHandler<{ date: string }>(async (req, res) => {
  if (!req.auth) throw new UnauthorizedError();
  if (!req.tenant) throw new BadRequestError('No active company');
  res.json(await getZReport(req.tenant.companyKey, req.params.date));
});

export const counted = asyncHandler<{ date: string }, unknown, { countedCash: number }>(
  async (req, res) => {
    if (!req.auth) throw new UnauthorizedError();
    if (!req.tenant) throw new BadRequestError('No active company');
    if (typeof req.body?.countedCash !== 'number') {
      throw new BadRequestError('countedCash (number) required');
    }
    const result = await setCountedCash(
      req.tenant.companyKey,
      req.params.date,
      req.body.countedCash,
      { userId: req.auth.userId, email: req.auth.email, ip: ipOf(req) },
    );
    res.json(result);
  },
);

export const verify = asyncHandler<{ date: string }>(async (req, res) => {
  if (!req.auth) throw new UnauthorizedError();
  if (!req.tenant) throw new BadRequestError('No active company');
  const result = await verifyZReport(req.tenant.companyKey, req.params.date, {
    userId: req.auth.userId,
    email: req.auth.email,
    ip: ipOf(req),
  });
  res.json(result);
});
