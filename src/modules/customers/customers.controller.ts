import { asyncHandler } from '../../lib/asyncHandler';
import { BadRequestError, UnauthorizedError } from '../../lib/errors';
import { getCustomerByCardCode, searchCustomers } from './customers.service';

export const lookup = asyncHandler<{ cardCode: string }>(async (req, res) => {
  if (!req.auth) throw new UnauthorizedError();
  if (!req.tenant) throw new BadRequestError('No active company');
  const dto = await getCustomerByCardCode(
    req.tenant.companyKey,
    req.params.cardCode,
  );
  res.json(dto);
});

export const search = asyncHandler<unknown, unknown, unknown, { q?: string }>(
  async (req, res) => {
    if (!req.auth) throw new UnauthorizedError();
    if (!req.tenant) throw new BadRequestError('No active company');
    const items = await searchCustomers(
      req.tenant.companyKey,
      typeof req.query?.q === 'string' ? req.query.q : '',
    );
    res.json({ items });
  },
);
