import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';
import { AppError } from '../lib/errors';
import { randomToken, safeEqual } from '../lib/crypto';
import { baseCookieOptions, clearCookieOptions } from '../lib/cookies';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Double-submit CSRF: a non-httpOnly cookie holds a random token; mutating
 * requests must echo it in the X-CSRF-Token header. Server compares the two
 * with constant-time equality.
 *
 * The token is rotated on login (in auth controller) and re-issued lazily here
 * for any request that doesn't yet have one.
 */
export function csrfMiddleware(req: Request, res: Response, next: NextFunction) {
  const cookieName = env.CSRF_COOKIE_NAME;
  const cookieToken = req.cookies?.[cookieName];

  if (!cookieToken) {
    const fresh = randomToken(24);
    res.cookie(cookieName, fresh, {
      ...baseCookieOptions(),
      httpOnly: false,
      maxAge: env.SESSION_TTL_HOURS * 60 * 60 * 1000,
    });
    if (!SAFE_METHODS.has(req.method)) {
      return next(
        new AppError('CSRF token missing — retry after this response sets it', 403, 'CSRF'),
      );
    }
    return next();
  }

  if (SAFE_METHODS.has(req.method)) return next();

  const headerToken = req.header('x-csrf-token');
  if (!headerToken || !safeEqual(headerToken, cookieToken)) {
    return next(new AppError('Invalid CSRF token', 403, 'CSRF'));
  }
  next();
}

/** Issue a fresh CSRF token (call from /login on success). */
export function issueCsrfCookie(res: Response): string {
  const token = randomToken(24);
  res.cookie(env.CSRF_COOKIE_NAME, token, {
    ...baseCookieOptions(),
    httpOnly: false,
    maxAge: env.SESSION_TTL_HOURS * 60 * 60 * 1000,
  });
  return token;
}

export function clearCsrfCookie(res: Response): void {
  res.clearCookie(env.CSRF_COOKIE_NAME, clearCookieOptions());
}
