import type { CookieOptions } from 'express';
import { env } from '../config/env';

/**
 * Shared attributes for the session + CSRF cookies.
 *
 * SameSite=None is needed for the cross-site deployment (frontend on
 * finance.foodservices.live, API on backendfinance.foodservices.live), since
 * the cookie travels with a cross-site XHR. Browsers reject a None cookie that
 * isn't also Secure, so Secure is forced on whenever SameSite is None —
 * regardless of COOKIE_SECURE — to avoid a silent "cookie never set" footgun.
 */
export function baseCookieOptions(): CookieOptions {
  const sameSite = env.COOKIE_SAMESITE;
  return {
    secure: env.COOKIE_SECURE || sameSite === 'none',
    sameSite,
    domain: env.COOKIE_DOMAIN || undefined,
    path: '/',
  };
}

/** Attributes for clearing a cookie — must match domain/path used to set it. */
export function clearCookieOptions(): CookieOptions {
  return {
    domain: env.COOKIE_DOMAIN || undefined,
    path: '/',
  };
}
