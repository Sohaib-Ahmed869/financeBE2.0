import { asyncHandler } from '../../lib/asyncHandler';
import { BadRequestError, UnauthorizedError } from '../../lib/errors';
import {
  autoMatchDay,
  createPayment,
  getDay,
  getPaymentById,
  getReconciliationForDay,
  listPayments,
  pushPayment,
  reconcilePayment,
  updatePayment,
  voidPayment,
} from './payments.service';
import type {
  CreatePaymentInput,
  ListPaymentsQuery,
  PushPaymentInput,
  ReconcileInput,
  UpdatePaymentInput,
  VoidPaymentInput,
} from './payments.validators';

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

export const list = asyncHandler<unknown, unknown, unknown, ListPaymentsQuery>(
  async (req, res) => {
    if (!req.auth) throw new UnauthorizedError();
    if (!req.tenant) throw new BadRequestError('No active company');
    const result = await listPayments(req.tenant.companyKey, req.query);
    res.json(result);
  },
);

export const getDayCtrl = asyncHandler<{ date: string }>(async (req, res) => {
  if (!req.auth) throw new UnauthorizedError();
  if (!req.tenant) throw new BadRequestError('No active company');
  const result = await getDay(req.tenant.companyKey, req.params.date);
  res.json(result);
});

export const getOne = asyncHandler<{ id: string }>(async (req, res) => {
  if (!req.auth) throw new UnauthorizedError();
  if (!req.tenant) throw new BadRequestError('No active company');
  const entry = await getPaymentById(req.tenant.companyKey, req.params.id);
  res.json(entry);
});

export const create = asyncHandler<unknown, unknown, CreatePaymentInput>(
  async (req, res) => {
    if (!req.tenant) throw new BadRequestError('No active company');
    const entry = await createPayment(req.tenant.companyKey, req.body, actorOf(req));
    res.status(201).json(entry);
  },
);

export const update = asyncHandler<{ id: string }, unknown, UpdatePaymentInput>(
  async (req, res) => {
    if (!req.tenant) throw new BadRequestError('No active company');
    const entry = await updatePayment(
      req.tenant.companyKey,
      req.params.id,
      req.body,
      actorOf(req),
    );
    res.json(entry);
  },
);

export const reconciliation = asyncHandler<{ date: string }>(async (req, res) => {
  if (!req.auth) throw new UnauthorizedError();
  if (!req.tenant) throw new BadRequestError('No active company');
  const result = await getReconciliationForDay(
    req.tenant.companyKey,
    req.params.date,
  );
  res.json(result);
});

export const autoMatch = asyncHandler<{ date: string }>(async (req, res) => {
  if (!req.tenant) throw new BadRequestError('No active company');
  const result = await autoMatchDay(
    req.tenant.companyKey,
    req.params.date,
    actorOf(req),
  );
  res.json(result);
});

export const reconcile = asyncHandler<{ id: string }, unknown, ReconcileInput>(
  async (req, res) => {
    if (!req.tenant) throw new BadRequestError('No active company');
    const result = await reconcilePayment(
      req.tenant.companyKey,
      req.params.id,
      req.body,
      actorOf(req),
    );
    res.json(result);
  },
);

export const push = asyncHandler<{ id: string }, unknown, PushPaymentInput>(
  async (req, res) => {
    if (!req.tenant) throw new BadRequestError('No active company');
    const result = await pushPayment(
      req.tenant.companyKey,
      req.params.id,
      req.body?.invoiceDocEntry,
      actorOf(req),
    );
    res.json(result);
  },
);

export const voidCtrl = asyncHandler<{ id: string }, unknown, VoidPaymentInput>(
  async (req, res) => {
    if (!req.tenant) throw new BadRequestError('No active company');
    const entry = await voidPayment(
      req.tenant.companyKey,
      req.params.id,
      req.body.reason,
      actorOf(req),
    );
    res.json(entry);
  },
);
