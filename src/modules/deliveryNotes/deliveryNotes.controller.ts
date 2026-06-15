import { asyncHandler } from '../../lib/asyncHandler';
import { BadRequestError, UnauthorizedError } from '../../lib/errors';
import {
  listDeliveryNotes,
  bulkConvert,
  getOne,
} from './deliveryNotes.service';
import type { ListQuery, BulkConvertInput } from './deliveryNotes.validators';

const ipOf = (req: { ip?: string; headers?: Record<string, unknown> }): string =>
  ((req.headers?.['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || '');

export const list = asyncHandler<unknown, unknown, unknown, ListQuery>(
  async (req, res) => {
    if (!req.auth) throw new UnauthorizedError();
    if (!req.tenant) throw new BadRequestError('No active company');
    const result = await listDeliveryNotes(req.tenant.companyKey, req.query);
    res.json(result);
  },
);

export const detail = asyncHandler<{ docEntry: number }>(async (req, res) => {
  if (!req.auth) throw new UnauthorizedError();
  if (!req.tenant) throw new BadRequestError('No active company');
  const dn = await getOne(req.tenant.companyKey, Number(req.params.docEntry));
  res.json(dn);
});

export const bulkConvertCtrl = asyncHandler<unknown, unknown, BulkConvertInput>(
  async (req, res) => {
    if (!req.auth) throw new UnauthorizedError();
    if (!req.tenant) throw new BadRequestError('No active company');
    const summary = await bulkConvert(req.tenant.companyKey, req.body.docEntries, {
      userId: req.auth.userId,
      email: req.auth.email,
      ip: ipOf(req),
    });
    res.json(summary);
  },
);
