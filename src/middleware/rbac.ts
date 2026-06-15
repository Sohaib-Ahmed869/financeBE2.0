import type { NextFunction, Request, Response } from 'express';
import { ForbiddenError, BadRequestError } from '../lib/errors';

/**
 * Operation-based permission gate. Used after requireAuth + requireCompany.
 * Pass one or more permission keys; user must hold ALL of them
 * (use requireAnyPermission for OR semantics).
 *
 * Super-admins are admitted by requireCompany already populating their permissions.
 */
export function requirePermission(...keys: string[]) {
  if (keys.length === 0) throw new Error('requirePermission needs ≥1 key');
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.tenant) {
      return next(new BadRequestError('requirePermission used before requireCompany'));
    }
    const missing = keys.filter((k) => !req.tenant!.permissions.has(k));
    if (missing.length > 0) {
      return next(
        new ForbiddenError(
          `Missing permission${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`,
        ),
      );
    }
    next();
  };
}

/** OR-semantics version: holding any one of the keys passes. */
export function requireAnyPermission(...keys: string[]) {
  if (keys.length === 0) throw new Error('requireAnyPermission needs ≥1 key');
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.tenant) {
      return next(new BadRequestError('requireAnyPermission used before requireCompany'));
    }
    const ok = keys.some((k) => req.tenant!.permissions.has(k));
    if (!ok) {
      return next(new ForbiddenError(`Requires any of: ${keys.join(', ')}`));
    }
    next();
  };
}

/** Super-admin only — operations that bypass the per-company permission system. */
export function requireSuperAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.auth) return next(new BadRequestError('requireSuperAdmin used before requireAuth'));
  if (!req.auth.isSuperAdmin) return next(new ForbiddenError('Super-admin only'));
  next();
}
