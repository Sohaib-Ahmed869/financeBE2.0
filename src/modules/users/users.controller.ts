import type { Request } from 'express';
import { asyncHandler } from '../../lib/asyncHandler';
import { UnauthorizedError } from '../../lib/errors';
import * as svc from './users.service';
import type {
  CreateUserInput,
  UpdateUserInput,
  ListUsersQuery,
  ResetPasswordInput,
} from './users.validators';

const meta = (req: Request) => ({
  actorUserId: req.auth!.userId,
  actorEmail: req.auth!.email,
  ip: req.ip ?? '',
});

const auth = (req: Request) => {
  if (!req.auth) throw new UnauthorizedError();
  return req.auth;
};

export const list = asyncHandler<unknown, unknown, unknown, ListUsersQuery>(async (req, res) => {
  auth(req);
  res.json(await svc.listUsers(req.query));
});

export const get = asyncHandler<{ id: string }>(async (req, res) => {
  auth(req);
  res.json(await svc.getUser(req.params.id));
});

export const create = asyncHandler<unknown, unknown, CreateUserInput>(async (req, res) => {
  auth(req);
  res.status(201).json(await svc.createUser(req.body, meta(req)));
});

export const update = asyncHandler<{ id: string }, unknown, UpdateUserInput>(async (req, res) => {
  auth(req);
  res.json(await svc.updateUser(req.params.id, req.body, meta(req)));
});

export const deactivate = asyncHandler<{ id: string }>(async (req, res) => {
  auth(req);
  res.json(await svc.deactivateUser(req.params.id, meta(req)));
});

export const resetPassword = asyncHandler<{ id: string }, unknown, ResetPasswordInput>(
  async (req, res) => {
    auth(req);
    await svc.resetUserPassword(req.params.id, req.body, meta(req));
    res.json({ ok: true });
  },
);
