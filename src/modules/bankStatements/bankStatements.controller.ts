import multer from 'multer';
import type { RequestHandler } from 'express';
import { asyncHandler } from '../../lib/asyncHandler';
import { BadRequestError, UnauthorizedError } from '../../lib/errors';
import {
  uploadStatement,
  listStatements,
  getStatement,
  autoMatchStatement,
  tagLine,
} from './bankStatements.service';

const ipOf = (req: { ip?: string; headers?: Record<string, unknown> }): string =>
  ((req.headers?.['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || '');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ok =
      /\.(csv|tsv|txt|ofx|xls|xlsx)$/i.test(file.originalname) ||
      /text|csv|excel|spreadsheet|ofx|octet-stream/.test(file.mimetype);
    if (!ok)
      return cb(
        new BadRequestError(
          'Unsupported file. Accepted: CSV / TSV / TXT, OFX, XLS / XLSX.',
        ),
      );
    cb(null, true);
  },
});

export const uploadMiddleware: RequestHandler = upload.single('file');

export const upload_ = asyncHandler<unknown, unknown, { bankKey: string; accountLabel?: string }>(
  async (req, res) => {
    if (!req.auth) throw new UnauthorizedError();
    if (!req.tenant) throw new BadRequestError('No active company');
    const f = (req as unknown as { file?: Express.Multer.File }).file;
    if (!f) throw new BadRequestError('Attach the statement as form field "file"');
    const result = await uploadStatement(
      req.tenant.companyKey,
      { originalname: f.originalname, buffer: f.buffer, size: f.size },
      { bankKey: req.body?.bankKey, accountLabel: req.body?.accountLabel },
      { userId: req.auth.userId, email: req.auth.email, ip: ipOf(req) },
    );
    res.status(201).json(result);
  },
);

export const list = asyncHandler(async (req, res) => {
  if (!req.auth) throw new UnauthorizedError();
  if (!req.tenant) throw new BadRequestError('No active company');
  res.json(await listStatements(req.tenant.companyKey));
});

export const detail = asyncHandler<{ id: string }, unknown, unknown, { status?: string; direction?: string }>(
  async (req, res) => {
    if (!req.auth) throw new UnauthorizedError();
    if (!req.tenant) throw new BadRequestError('No active company');
    res.json(
      await getStatement(req.tenant.companyKey, req.params.id, {
        status: req.query?.status as never,
        direction: req.query?.direction as never,
      }),
    );
  },
);

export const autoMatch = asyncHandler<{ id: string }>(async (req, res) => {
  if (!req.auth) throw new UnauthorizedError();
  if (!req.tenant) throw new BadRequestError('No active company');
  res.json(
    await autoMatchStatement(req.tenant.companyKey, req.params.id, {
      userId: req.auth.userId,
      email: req.auth.email,
      ip: ipOf(req),
    }),
  );
});

export const tag = asyncHandler<{ id: string }, unknown, { status?: string; tags?: string[]; notes?: string; category?: string }>(
  async (req, res) => {
    if (!req.auth) throw new UnauthorizedError();
    if (!req.tenant) throw new BadRequestError('No active company');
    const line = await tagLine(req.tenant.companyKey, req.params.id, req.body, {
      userId: req.auth.userId,
      email: req.auth.email,
      ip: ipOf(req),
    });
    res.json(line);
  },
);
