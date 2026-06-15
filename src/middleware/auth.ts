import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';
import { verifySessionToken } from '../lib/jwt';
import { UnauthorizedError } from '../lib/errors';
import { AuthSession } from '../models/master/AuthSession';
import { User } from '../models/master/User';

export interface AuthContext {
  userId: string;
  sessionId: string;
  email: string;
  isSuperAdmin: boolean;
  language: 'en' | 'fr';
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
  }
}

/**
 * Reads the session cookie, verifies the JWT, looks up the AuthSession, ensures
 * the user is still active, and attaches `req.auth` for downstream handlers.
 * Also slides the session's lastUsedAt timestamp.
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.[env.COOKIE_NAME];
    if (!token) throw new UnauthorizedError('No session');

    let payload;
    try {
      payload = verifySessionToken(token);
    } catch {
      throw new UnauthorizedError('Invalid or expired session');
    }

    const session = await AuthSession.findById(payload.jti);
    if (!session || session.revokedAt) throw new UnauthorizedError('Session revoked');
    if (session.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedError('Session expired');
    }
    if (session.userId.toString() !== payload.sub) {
      throw new UnauthorizedError('Session user mismatch');
    }

    const user = await User.findById(payload.sub).lean();
    if (!user) throw new UnauthorizedError('User not found');
    if (!user.active) throw new UnauthorizedError('User deactivated');

    session.lastUsedAt = new Date();
    await session.save();

    req.auth = {
      userId: user._id.toString(),
      sessionId: session._id.toString(),
      email: user.email,
      isSuperAdmin: user.isSuperAdmin,
      language: user.language,
    };
    next();
  } catch (err) {
    next(err);
  }
}
