import type { Request } from 'express';
import { asyncHandler } from '../../lib/asyncHandler';
import { UnauthorizedError } from '../../lib/errors';
import * as svc from './access.service';
import type {
  GrantAccessInput,
  UpdateAccessInput,
  RevokeAccessInput,
  ListAccessQuery,
} from './access.validators';

const meta = (req: Request) => ({
  actorUserId: req.auth!.userId,
  actorEmail: req.auth!.email,
  ip: req.ip ?? '',
});
const auth = (req: Request) => {
  if (!req.auth) throw new UnauthorizedError();
};

export const list = asyncHandler<unknown, unknown, unknown, ListAccessQuery>(async (req, res) => {
  auth(req);
  res.json(await svc.listAccess(req.query));
});

export const grant = asyncHandler<unknown, unknown, GrantAccessInput>(async (req, res) => {
  auth(req);
  res.status(201).json(await svc.grantAccess(req.body, meta(req)));
});

export const update = asyncHandler<{ id: string }, unknown, UpdateAccessInput>(async (req, res) => {
  auth(req);
  res.json(await svc.updateAccess(req.params.id, req.body, meta(req)));
});

export const revoke = asyncHandler<{ id: string }, unknown, RevokeAccessInput>(async (req, res) => {
  auth(req);
  res.json(await svc.revokeAccess(req.params.id, req.body, meta(req)));
});
