import type { ErrorRequestHandler, NextFunction, Request, Response } from 'express';
import { AppError, InternalError } from '../lib/errors';
import { logger } from '../lib/logger';
import { isProd } from '../config/env';

export const notFoundHandler = (req: Request, _res: Response, next: NextFunction) => {
  next(new AppError(`Route not found: ${req.method} ${req.path}`, 404, 'NOT_FOUND'));
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const error = err instanceof AppError ? err : new InternalError(err?.message ?? 'Internal');

  const log = error.statusCode >= 500 ? logger.error : logger.warn;
  log.call(
    logger,
    {
      err,
      method: req.method,
      path: req.path,
      statusCode: error.statusCode,
      code: error.code,
      userId: (req as Request & { userId?: string }).userId,
      companyKey: (req as Request & { companyKey?: string }).companyKey,
    },
    'request.failed',
  );

  res.status(error.statusCode).json({
    error: {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
      ...(isProd || error.statusCode < 500 ? {} : { stack: err?.stack }),
    },
  });
};
