import type { Request } from 'express';
import { asyncHandler } from '../../lib/asyncHandler';
import { UnauthorizedError } from '../../lib/errors';
import * as svc from './roles.service';
import type {
  CreateRoleInput,
  UpdateRoleInput,
  ListRolesQuery,
} from './roles.validators';

const meta = (req: Request) => ({
  actorUserId: req.auth!.userId,
  actorEmail: req.auth!.email,
  ip: req.ip ?? '',
});

const auth = (req: Request) => {
  if (!req.auth) throw new UnauthorizedError();
  return req.auth;
};

export const list = asyncHandler<unknown, unknown, unknown, ListRolesQuery>(async (req, res) => {
  auth(req);
  res.json(await svc.listRoles(req.query));
});

export const get = asyncHandler<{ id: string }>(async (req, res) => {
  auth(req);
  res.json(await svc.getRole(req.params.id));
});

export const create = asyncHandler<unknown, unknown, CreateRoleInput>(async (req, res) => {
  auth(req);
  res.status(201).json(await svc.createRole(req.body, meta(req)));
});

export const update = asyncHandler<{ id: string }, unknown, UpdateRoleInput>(async (req, res) => {
  auth(req);
  res.json(await svc.updateRole(req.params.id, req.body, meta(req)));
});

export const remove = asyncHandler<{ id: string }>(async (req, res) => {
  auth(req);
  await svc.deleteRole(req.params.id, meta(req));
  res.json({ ok: true });
});
