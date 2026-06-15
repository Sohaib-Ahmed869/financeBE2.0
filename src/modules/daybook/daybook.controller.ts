import multer from 'multer';
import type { RequestHandler } from 'express';
import { asyncHandler } from '../../lib/asyncHandler';
import { BadRequestError, UnauthorizedError } from '../../lib/errors';
import {
  uploadAndParse,
  listFiles,
  listMonths,
  getFile,
  getMonthByYM,
  getDayByDate,
  deleteFile,
  upsertManualDay,
  getReconciliation,
  autoMatchDay,
  setLineMatch,
  pushDay,
  pushPosExtras,
  exportMonthWorkbook,
  syncSapForDay,
  getDiscrepancyReport,
  getMonthKpis,
  listFailedPushes,
  autoMatchImportedPayments,
  matchImportedPayment,
  pushImportedPayment,
} from './daybook.service';
import type {
  UpsertDayInput,
  SetMatchInput,
  PushDayInput,
  PushPosExtrasInput,
} from './daybook.validators';
import type { ReconcileInput, PushPaymentInput } from '../payments/payments.validators';

const ipOf = (req: { ip?: string; headers?: Record<string, unknown> }): string =>
  ((req.headers?.['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || '');

const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB — comfortably above any monthly daybook.

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ok =
      file.mimetype.includes('spreadsheet') ||
      file.mimetype.includes('excel') ||
      /\.xlsx?$/i.test(file.originalname);
    if (!ok) return cb(new BadRequestError('Only .xlsx / .xls files are accepted'));
    cb(null, true);
  },
});

/** Multer middleware — exported so the route file can compose it. */
export const uploadMiddleware: RequestHandler = upload.single('file');

export const upload_ = asyncHandler(async (req, res) => {
  if (!req.auth) throw new UnauthorizedError();
  if (!req.tenant) throw new BadRequestError('No active company');
  const f = (req as unknown as { file?: Express.Multer.File }).file;
  if (!f) throw new BadRequestError('Attach the workbook as form field "file"');
  const result = await uploadAndParse(
    req.tenant.companyKey,
    { originalname: f.originalname, buffer: f.buffer, size: f.size },
    { userId: req.auth.userId, email: req.auth.email, ip: ipOf(req) },
  );
  res.status(result.reused ? 200 : 201).json(result);
});

export const list = asyncHandler(async (req, res) => {
  if (!req.auth) throw new UnauthorizedError();
  if (!req.tenant) throw new BadRequestError('No active company');
  const items = await listFiles(req.tenant.companyKey);
  res.json({ items });
});

export const months = asyncHandler(async (req, res) => {
  if (!req.auth) throw new UnauthorizedError();
  if (!req.tenant) throw new BadRequestError('No active company');
  const result = await listMonths(req.tenant.companyKey);
  res.json(result);
});

export const getMonth = asyncHandler<{ year: string; month: string }>(
  async (req, res) => {
    if (!req.auth) throw new UnauthorizedError();
    if (!req.tenant) throw new BadRequestError('No active company');
    const result = await getMonthByYM(
      req.tenant.companyKey,
      Number(req.params.year),
      Number(req.params.month),
    );
    res.json(result);
  },
);

export const getOne = asyncHandler<{ id: string }>(async (req, res) => {
  if (!req.auth) throw new UnauthorizedError();
  if (!req.tenant) throw new BadRequestError('No active company');
  const result = await getFile(req.tenant.companyKey, req.params.id);
  res.json(result);
});

export const getDay = asyncHandler<{ date: string }>(async (req, res) => {
  if (!req.auth) throw new UnauthorizedError();
  if (!req.tenant) throw new BadRequestError('No active company');
  const day = await getDayByDate(req.tenant.companyKey, req.params.date);
  res.json(day);
});

export const upsertDay = asyncHandler<{ date: string }, unknown, UpsertDayInput>(
  async (req, res) => {
    if (!req.auth) throw new UnauthorizedError();
    if (!req.tenant) throw new BadRequestError('No active company');
    const result = await upsertManualDay(
      req.tenant.companyKey,
      req.params.date,
      req.body,
      { userId: req.auth.userId, email: req.auth.email, ip: ipOf(req) },
    );
    res.json(result);
  },
);

export const reconciliation = asyncHandler<{ date: string }>(async (req, res) => {
  if (!req.auth) throw new UnauthorizedError();
  if (!req.tenant) throw new BadRequestError('No active company');
  const result = await getReconciliation(req.tenant.companyKey, req.params.date);
  res.json(result);
});

export const discrepancy = asyncHandler<{ date: string }>(async (req, res) => {
  if (!req.auth) throw new UnauthorizedError();
  if (!req.tenant) throw new BadRequestError('No active company');
  const result = await getDiscrepancyReport(req.tenant.companyKey, req.params.date);
  res.json(result);
});

export const syncSap = asyncHandler<{ date: string }>(async (req, res) => {
  if (!req.auth) throw new UnauthorizedError();
  if (!req.tenant) throw new BadRequestError('No active company');
  const result = await syncSapForDay(req.tenant.companyKey, req.params.date, {
    userId: req.auth.userId,
    email: req.auth.email,
    ip: ipOf(req),
  });
  res.json(result);
});

export const autoMatch = asyncHandler<{ date: string }>(async (req, res) => {
  if (!req.auth) throw new UnauthorizedError();
  if (!req.tenant) throw new BadRequestError('No active company');
  const result = await autoMatchDay(req.tenant.companyKey, req.params.date, {
    userId: req.auth.userId,
    email: req.auth.email,
    ip: ipOf(req),
  });
  res.json(result);
});

export const importedAutoMatch = asyncHandler<{ date: string }>(
  async (req, res) => {
    if (!req.auth) throw new UnauthorizedError();
    if (!req.tenant) throw new BadRequestError('No active company');
    const result = await autoMatchImportedPayments(
      req.tenant.companyKey,
      req.params.date,
      { userId: req.auth.userId, email: req.auth.email, ip: ipOf(req) },
    );
    res.json(result);
  },
);

export const matchImported = asyncHandler<{ id: string }, unknown, ReconcileInput>(
  async (req, res) => {
    if (!req.auth) throw new UnauthorizedError();
    if (!req.tenant) throw new BadRequestError('No active company');
    const result = await matchImportedPayment(
      req.tenant.companyKey,
      req.params.id,
      req.body,
      { userId: req.auth.userId, email: req.auth.email, ip: ipOf(req) },
    );
    res.json(result);
  },
);

export const pushImported = asyncHandler<{ id: string }, unknown, PushPaymentInput>(
  async (req, res) => {
    if (!req.auth) throw new UnauthorizedError();
    if (!req.tenant) throw new BadRequestError('No active company');
    const result = await pushImportedPayment(
      req.tenant.companyKey,
      req.params.id,
      req.body?.invoiceDocEntry,
      { userId: req.auth.userId, email: req.auth.email, ip: ipOf(req) },
    );
    res.json(result);
  },
);

export const setMatch = asyncHandler<
  { date: string; index: number },
  unknown,
  SetMatchInput
>(async (req, res) => {
  if (!req.auth) throw new UnauthorizedError();
  if (!req.tenant) throw new BadRequestError('No active company');
  const result = await setLineMatch(
    req.tenant.companyKey,
    req.params.date,
    Number(req.params.index),
    req.body,
    { userId: req.auth.userId, email: req.auth.email, ip: ipOf(req) },
  );
  res.json(result);
});

export const push = asyncHandler<{ date: string }, unknown, PushDayInput>(
  async (req, res) => {
    if (!req.auth) throw new UnauthorizedError();
    if (!req.tenant) throw new BadRequestError('No active company');
    const summary = await pushDay(
      req.tenant.companyKey,
      req.params.date,
      { userId: req.auth.userId, email: req.auth.email, ip: ipOf(req) },
      req.body?.indexes,
    );
    res.json(summary);
  },
);

export const pushPosExtrasCtrl = asyncHandler<
  { date: string },
  unknown,
  PushPosExtrasInput
>(async (req, res) => {
  if (!req.auth) throw new UnauthorizedError();
  if (!req.tenant) throw new BadRequestError('No active company');
  const summary = await pushPosExtras(
    req.tenant.companyKey,
    req.params.date,
    { userId: req.auth.userId, email: req.auth.email, ip: ipOf(req) },
    req.body?.indexes,
  );
  res.json(summary);
});

export const exportMonth = asyncHandler<{ year: string; month: string }>(
  async (req, res) => {
    if (!req.auth) throw new UnauthorizedError();
    if (!req.tenant) throw new BadRequestError('No active company');
    const { buffer, filename } = await exportMonthWorkbook(
      req.tenant.companyKey,
      Number(req.params.year),
      Number(req.params.month),
    );
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(filename)}"`,
    );
    res.send(buffer);
  },
);

export const kpis = asyncHandler<{ year: string; month: string }>(
  async (req, res) => {
    if (!req.auth) throw new UnauthorizedError();
    if (!req.tenant) throw new BadRequestError('No active company');
    const result = await getMonthKpis(
      req.tenant.companyKey,
      Number(req.params.year),
      Number(req.params.month),
    );
    res.json(result);
  },
);

export const failedPushes = asyncHandler(async (req, res) => {
  if (!req.auth) throw new UnauthorizedError();
  if (!req.tenant) throw new BadRequestError('No active company');
  const result = await listFailedPushes(req.tenant.companyKey);
  res.json(result);
});

export const remove = asyncHandler<{ id: string }>(async (req, res) => {
  if (!req.auth) throw new UnauthorizedError();
  if (!req.tenant) throw new BadRequestError('No active company');
  await deleteFile(req.tenant.companyKey, req.params.id, {
    userId: req.auth.userId,
    email: req.auth.email,
    ip: ipOf(req),
  });
  res.json({ ok: true });
});
