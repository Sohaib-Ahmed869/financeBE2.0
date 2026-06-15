import express, { type Application } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { env } from './config/env';
import { logger } from './lib/logger';
import { csrfMiddleware } from './middleware/csrf';
import { generalLimiter } from './middleware/rateLimit';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import router from './routes';

export function createApp(): Application {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  // Quiet the per-request log down to a one-liner. Default pino-http dumps the
  // full req/res with every header — far too noisy for dev. The few endpoints
  // that need richer logs do their own structured logs explicitly.
  const QUIET_PATHS = new Set([
    '/api/health',
    '/api/sap/runner-stats',
    '/api/sap/sync-state',
    '/api/auth/me',
  ]);
  app.use(
    pinoHttp({
      logger,
      autoLogging: { ignore: (req) => QUIET_PATHS.has(req.url ?? '') },
      // One-line message per response.
      customSuccessMessage: (req, res) => {
        const tenant = (req as { tenant?: { companyKey?: string } }).tenant?.companyKey;
        return `${req.method} ${req.url} → ${res.statusCode}${tenant ? ` [${tenant}]` : ''}`;
      },
      customErrorMessage: (req, res) =>
        `${req.method} ${req.url} → ${res.statusCode} ERROR`,
      // Strip the heavy fields (headers, full URL parsing, etc.) — pino-http
      // attaches them by default and pino-pretty prints the lot.
      serializers: {
        req: (req: { method?: string; url?: string }) => ({
          method: req.method,
          url: req.url,
        }),
        res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
      },
      customProps: (req) => ({
        userId: (req as { auth?: { userId?: string } }).auth?.userId,
        companyKey: (req as { tenant?: { companyKey?: string } }).tenant?.companyKey,
      }),
    }),
  );

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(
    cors({
      origin: env.CLIENT_ORIGIN,
      credentials: true,
      exposedHeaders: ['X-CSRF-Token'],
    }),
  );
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());
  app.use(generalLimiter);
  app.use(csrfMiddleware);

  app.use('/api', router);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
