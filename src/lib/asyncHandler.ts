import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Typed request shape for handlers. Generics let callers describe their `params`,
 * `body`, and `query` shapes; we extend `Request<any, any, any, any>` so the
 * resulting type is still assignable to plain `Request` (handy when passing it
 * to small inline helpers that expect `Request`).
 */
export type TypedRequest<P = unknown, B = unknown, Q = unknown> = Request<any, any, any, any> & {
  params: P;
  body: B;
  query: Q;
};

/**
 * Wraps an async handler. Returns a plain `RequestHandler` so it composes
 * cleanly with Express's router types regardless of the inner generics.
 *
 * Generic order matches Express's RequestHandler: `<Params, ResBody, Body, Query>`.
 * `ResBody` is unused here but kept so call-sites can document the response shape.
 */
export function asyncHandler<
  P = unknown,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  ResBody = unknown,
  B = unknown,
  Q = unknown,
>(
  handler: (req: TypedRequest<P, B, Q>, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req as TypedRequest<P, B, Q>, res, next).catch(next);
  };
}
