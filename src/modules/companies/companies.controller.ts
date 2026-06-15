import type { Request } from 'express';
import { asyncHandler } from '../../lib/asyncHandler';
import { UnauthorizedError } from '../../lib/errors';
import * as svc from './companies.service';
import type {
  CreateCompanyInput,
  UpdateCompanyInput,
  RotateSapInput,
  UpdateOwnCompanyCardCodesInput,
} from './companies.validators';

const meta = (req: Request) => ({
  actorUserId: req.auth!.userId,
  actorEmail: req.auth!.email,
  ip: req.ip ?? '',
});

const auth = (req: Request) => {
  if (!req.auth) throw new UnauthorizedError();
};

export const list = asyncHandler(async (req, res) => {
  auth(req);
  res.json(await svc.listCompanies());
});

export const get = asyncHandler<{ key: string }>(async (req, res) => {
  auth(req);
  res.json(await svc.getCompany(req.params.key));
});

export const create = asyncHandler<unknown, unknown, CreateCompanyInput>(async (req, res) => {
  auth(req);
  res.status(201).json(await svc.createCompany(req.body, meta(req)));
});

export const update = asyncHandler<{ key: string }, unknown, UpdateCompanyInput>(
  async (req, res) => {
    auth(req);
    res.json(await svc.updateCompany(req.params.key, req.body, meta(req)));
  },
);

export const rotateSap = asyncHandler<{ key: string }, unknown, RotateSapInput>(
  async (req, res) => {
    auth(req);
    res.json(await svc.rotateSapCreds(req.params.key, req.body, meta(req)));
  },
);

export const deactivate = asyncHandler<{ key: string }>(async (req, res) => {
  auth(req);
  await svc.deactivateCompany(req.params.key, meta(req));
  res.json({ ok: true });
});

export const updateOwnCompanyCardCodes = asyncHandler<
  { key: string },
  unknown,
  UpdateOwnCompanyCardCodesInput
>(async (req, res) => {
  auth(req);
  res.json(
    await svc.updateOwnCompanyCardCodes(
      req.params.key,
      req.body.cardCodes,
      meta(req),
    ),
  );
});
