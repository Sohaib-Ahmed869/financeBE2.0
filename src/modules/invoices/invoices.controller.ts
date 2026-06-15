import { asyncHandler } from '../../lib/asyncHandler';
import { BadRequestError, UnauthorizedError } from '../../lib/errors';
import {
  createManualInvoice,
  getDay,
  getInvoice,
  listInvoices,
  setUnpaidFlag,
} from './invoices.service';
import type {
  CreateInvoiceInput,
  ListInvoicesQuery,
  MarkUnpaidInput,
} from './invoices.validators';

const ipOf = (req: { ip?: string; headers?: Record<string, unknown> }): string =>
  ((req.headers?.['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || '');

function actorOf(req: {
  auth?: { userId: string; email: string } | null;
  headers?: Record<string, unknown>;
  ip?: string;
}) {
  if (!req.auth) throw new UnauthorizedError();
  return { userId: req.auth.userId, email: req.auth.email, ip: ipOf(req) };
}

export const list = asyncHandler<unknown, unknown, unknown, ListInvoicesQuery>(
  async (req, res) => {
    if (!req.auth) throw new UnauthorizedError();
    if (!req.tenant) throw new BadRequestError('No active company');
    const result = await listInvoices(req.tenant.companyKey, req.query);
    res.json(result);
  },
);

export const getDayCtrl = asyncHandler<{ date: string }>(async (req, res) => {
  if (!req.auth) throw new UnauthorizedError();
  if (!req.tenant) throw new BadRequestError('No active company');
  const result = await getDay(req.tenant.companyKey, req.params.date);
  res.json(result);
});

export const detail = asyncHandler<{ docEntry: number }>(async (req, res) => {
  if (!req.auth) throw new UnauthorizedError();
  if (!req.tenant) throw new BadRequestError('No active company');
  const inv = await getInvoice(
    req.tenant.companyKey,
    Number(req.params.docEntry),
  );
  res.json(inv);
});

export const create = asyncHandler<unknown, unknown, CreateInvoiceInput>(
  async (req, res) => {
    if (!req.tenant) throw new BadRequestError('No active company');
    const inv = await createManualInvoice(
      req.tenant.companyKey,
      req.body,
      actorOf(req),
    );
    res.status(201).json(inv);
  },
);

export const markUnpaid = asyncHandler<
  { docEntry: number },
  unknown,
  MarkUnpaidInput
>(async (req, res) => {
  if (!req.tenant) throw new BadRequestError('No active company');
  const inv = await setUnpaidFlag(
    req.tenant.companyKey,
    Number(req.params.docEntry),
    req.body,
    actorOf(req),
  );
  res.json(inv);
});
