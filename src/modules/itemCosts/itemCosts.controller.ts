import multer from 'multer';
import type { RequestHandler } from 'express';
import { asyncHandler } from '../../lib/asyncHandler';
import { BadRequestError, UnauthorizedError } from '../../lib/errors';
import { uploadItemCosts, getItemCostHistory } from './itemCosts.service';

const ipOf = (req: { ip?: string; headers?: Record<string, unknown> }): string =>
  ((req.headers?.['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || '');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ok =
      /\.(csv|tsv|txt|xlsx|xls)$/i.test(file.originalname)
      || /text|csv|sheet|excel/.test(file.mimetype);
    if (!ok) return cb(new BadRequestError('CSV / Excel only'));
    cb(null, true);
  },
});

export const uploadMiddleware: RequestHandler = upload.single('file');

export const upload_ = asyncHandler(async (req, res) => {
  if (!req.auth) throw new UnauthorizedError();
  if (!req.tenant) throw new BadRequestError('No active company');
  const f = (req as unknown as { file?: Express.Multer.File }).file;
  if (!f) throw new BadRequestError('Attach the cost file as form field "file"');
  const result = await uploadItemCosts(
    req.tenant.companyKey,
    { originalname: f.originalname, buffer: f.buffer, size: f.size },
    { userId: req.auth.userId, email: req.auth.email, ip: ipOf(req) },
  );
  res.status(201).json(result);
});

export const history = asyncHandler<{ itemCode: string }>(async (req, res) => {
  if (!req.auth) throw new UnauthorizedError();
  if (!req.tenant) throw new BadRequestError('No active company');
  const result = await getItemCostHistory(req.tenant.companyKey, req.params.itemCode);
  res.json(result);
});
