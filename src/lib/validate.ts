import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z, type ZodTypeAny } from 'zod';
import { ValidationError } from './errors';

interface ValidateOptions {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

/**
 * Validates body / query / params against Zod schemas. On success, the parsed values
 * REPLACE the originals on `req` so downstream handlers get the typed shape.
 *
 * Returns a plain RequestHandler — the typed shapes are erased here on purpose so
 * Express's router types compose cleanly. Downstream handlers cast req via
 * asyncHandler<P, B, Q>(...) when they need typed access.
 */
export function validate(schemas: ValidateOptions): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (schemas.body) {
        const r = schemas.body.safeParse(req.body);
        if (!r.success) throw new ValidationError(formatZod(r.error), 'Invalid request body');
        req.body = r.data;
      }
      if (schemas.query) {
        const r = schemas.query.safeParse(req.query);
        if (!r.success) throw new ValidationError(formatZod(r.error), 'Invalid query parameters');
        // Express 4 keeps req.query as ParsedQs; we replace contents in place
        // so downstream handlers see the parsed/coerced shape.
        const target = req.query as Record<string, unknown>;
        Object.keys(target).forEach((k) => delete target[k]);
        Object.assign(target, r.data as object);
      }
      if (schemas.params) {
        const r = schemas.params.safeParse(req.params);
        if (!r.success) throw new ValidationError(formatZod(r.error), 'Invalid path parameters');
        const target = req.params as Record<string, unknown>;
        Object.keys(target).forEach((k) => delete target[k]);
        Object.assign(target, r.data as object);
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

function formatZod(err: z.ZodError) {
  return err.issues.map((i) => ({
    path: i.path.join('.'),
    message: i.message,
    code: i.code,
  }));
}
