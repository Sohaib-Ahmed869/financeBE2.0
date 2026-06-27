import { asyncHandler } from '../../lib/asyncHandler';
import { BadRequestError, UnauthorizedError } from '../../lib/errors';
import {
  getMonthRecon,
  seedSapNativeMatches,
  reconcileHistoricalPayment,
  resolveDiscrepancy,
} from './reconciliation.service';
import type {
  MatchHistoricalInput,
  ResolveDiscrepancyInput,
} from './reconciliation.validators';

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

export const getMonth = asyncHandler<{ yearMonth: string }>(async (req, res) => {
  if (!req.auth) throw new UnauthorizedError();
  if (!req.tenant) throw new BadRequestError('No active company');
  const result = await getMonthRecon(req.tenant.companyKey, req.params.yearMonth);
  res.json(result);
});

export const seedMonth = asyncHandler<{ yearMonth: string }>(async (req, res) => {
  if (!req.tenant) throw new BadRequestError('No active company');
  const result = await seedSapNativeMatches(
    req.tenant.companyKey,
    req.params.yearMonth,
    actorOf(req),
  );
  res.json(result);
});

export const matchSapPayment = asyncHandler<
  { sapDocEntry: string },
  unknown,
  MatchHistoricalInput
>(async (req, res) => {
  if (!req.tenant) throw new BadRequestError('No active company');
  const sapDocEntry = parseInt(req.params.sapDocEntry, 10);
  if (!Number.isFinite(sapDocEntry) || sapDocEntry <= 0) {
    throw new BadRequestError('Invalid sapDocEntry');
  }
  const match = await reconcileHistoricalPayment(
    req.tenant.companyKey,
    sapDocEntry,
    req.body,
    actorOf(req),
  );
  res.json(match);
});

export const resolveDisc = asyncHandler<
  { discrepancyId: string },
  unknown,
  ResolveDiscrepancyInput
>(async (req, res) => {
  if (!req.tenant) throw new BadRequestError('No active company');
  const result = await resolveDiscrepancy(
    req.tenant.companyKey,
    req.params.discrepancyId,
    req.body,
    actorOf(req),
  );
  res.json(result);
});
