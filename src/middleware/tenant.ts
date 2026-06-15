import type { NextFunction, Request, Response } from 'express';
import { BadRequestError, ForbiddenError } from '../lib/errors';
import { Company } from '../models/master/Company';
import { UserCompanyAccess } from '../models/master/UserCompanyAccess';
import { Role } from '../models/master/Role';

export interface TenantContext {
  companyKey: string;
  permissions: Set<string>;
  roleIds: string[];
}

declare module 'express-serve-static-core' {
  interface Request {
    tenant?: TenantContext;
  }
}

const HEADER = 'x-company';
const VALID_KEY = /^[a-z0-9-]{2,40}$/;

/**
 * Reads the X-Company header, validates the user has access to that company,
 * and attaches the union of permissions across the user's roles for that company.
 *
 * Super-admins get all permissions implicitly.
 *
 * Use after `requireAuth`. If `optional` is true, missing header is allowed
 * (useful for endpoints like /me that work without an active company).
 */
export function requireCompany(opts: { optional?: boolean } = {}) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (!req.auth) throw new BadRequestError('requireCompany used before requireAuth');

      const raw = req.header(HEADER);
      if (!raw) {
        if (opts.optional) return next();
        throw new BadRequestError(`Missing ${HEADER.toUpperCase()} header`);
      }
      const companyKey = raw.toLowerCase().trim();
      if (!VALID_KEY.test(companyKey)) {
        throw new BadRequestError(`Invalid company key: ${raw}`);
      }

      const company = await Company.findOne({ key: companyKey, active: true }).lean();
      if (!company) throw new BadRequestError(`Unknown or inactive company: ${companyKey}`);

      // Super-admin: full access, no UserCompanyAccess check needed.
      if (req.auth.isSuperAdmin) {
        const allRoles = await Role.find({}, { permissionKeys: 1 }).lean();
        const perms = new Set<string>();
        for (const r of allRoles) for (const k of r.permissionKeys) perms.add(k);
        req.tenant = { companyKey, permissions: perms, roleIds: [] };
        // Super-admin gets every permission key directly:
        const { PERMISSION_KEYS } = await import('../lib/permissions.catalog');
        for (const k of PERMISSION_KEYS) perms.add(k);
        return next();
      }

      const access = await UserCompanyAccess.findOne({
        userId: req.auth.userId,
        companyKey,
        active: true,
      }).lean();
      if (!access) throw new ForbiddenError(`You do not have access to company '${companyKey}'`);

      const roles = await Role.find({ _id: { $in: access.roleIds } }, { permissionKeys: 1 }).lean();
      const perms = new Set<string>();
      for (const r of roles) for (const k of r.permissionKeys) perms.add(k);

      req.tenant = {
        companyKey,
        permissions: perms,
        roleIds: access.roleIds.map((id) => id.toString()),
      };
      next();
    } catch (err) {
      next(err);
    }
  };
}
