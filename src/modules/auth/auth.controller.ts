import type { Request, Response } from 'express';
import { env } from '../../config/env';
import { asyncHandler } from '../../lib/asyncHandler';
import { issueCsrfCookie, clearCsrfCookie } from '../../middleware/csrf';
import { baseCookieOptions, clearCookieOptions } from '../../lib/cookies';
import * as svc from './auth.service';
import type { LoginInput, UpdateMeInput, ChangePasswordInput } from './auth.validators';
import { UnauthorizedError } from '../../lib/errors';

function ipOf(req: Request): string {
  return (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || '';
}
function uaOf(req: Request): string {
  return (req.headers['user-agent'] as string) || '';
}

function setSessionCookie(res: Response, token: string, expiresAt: Date) {
  res.cookie(env.COOKIE_NAME, token, {
    ...baseCookieOptions(),
    httpOnly: true,
    expires: expiresAt,
  });
}

function clearSessionCookie(res: Response) {
  res.clearCookie(env.COOKIE_NAME, clearCookieOptions());
}

export const login = asyncHandler<unknown, unknown, LoginInput>(async (req, res) => {
  const { user, token, expiresAt } = await svc.login(req.body.email, req.body.password, {
    ip: ipOf(req),
    userAgent: uaOf(req),
  });
  setSessionCookie(res, token, expiresAt);
  issueCsrfCookie(res);
  res.json({
    user: {
      id: user._id.toString(),
      email: user.email,
      name: user.name,
      language: user.language,
      isSuperAdmin: user.isSuperAdmin,
    },
    expiresAt,
  });
});

export const logout = asyncHandler(async (req, res) => {
  if (req.auth) await svc.logout(req.auth.sessionId, req.auth.email, ipOf(req));
  clearSessionCookie(res);
  clearCsrfCookie(res);
  res.json({ ok: true });
});

export const me = asyncHandler(async (req, res) => {
  if (!req.auth) throw new UnauthorizedError();
  const activeCompanyKey = (req.header('x-company') || '').toLowerCase().trim() || undefined;
  const data = await svc.getMe(req.auth.userId, activeCompanyKey);
  res.json(data);
});

export const updateMe = asyncHandler<unknown, unknown, UpdateMeInput>(async (req, res) => {
  if (!req.auth) throw new UnauthorizedError();
  const user = await svc.updateMe(req.auth.userId, req.body, {
    ip: ipOf(req),
    actorEmail: req.auth.email,
  });
  res.json({
    user: {
      id: user._id.toString(),
      email: user.email,
      name: user.name,
      language: user.language,
    },
  });
});

export const changePassword = asyncHandler<unknown, unknown, ChangePasswordInput>(
  async (req, res) => {
    if (!req.auth) throw new UnauthorizedError();
    await svc.changePassword(req.auth.userId, req.body.currentPassword, req.body.newPassword, {
      ip: ipOf(req),
      actorEmail: req.auth.email,
      sessionId: req.auth.sessionId,
    });
    res.json({ ok: true });
  },
);
