import pino from 'pino';
import { env, isDev } from '../config/env';

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.cookie',
      'req.headers.authorization',
      'req.headers["x-csrf-token"]',
      '*.password',
      '*.passwordHash',
      '*.sap.password',
      '*.mongoUri',
      '*.encryptionKey',
    ],
    censor: '[redacted]',
  },
  transport: isDev
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          // Hide pid/hostname always; also hide the heavy req/res/headers/responseTime
          // bags pino-http likes to attach so each line stays one row in the terminal.
          ignore: 'pid,hostname,req,res,reqId,responseTime,userId,companyKey',
          singleLine: true,
        },
      }
    : undefined,
});

export type Logger = typeof logger;
