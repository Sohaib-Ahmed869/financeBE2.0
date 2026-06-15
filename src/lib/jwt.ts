import jwt, { type SignOptions } from 'jsonwebtoken';
import { env } from '../config/env';

export interface SessionTokenPayload {
  sub: string; // userId
  jti: string; // AuthSession._id
}

const SECRET = env.JWT_SECRET;

export function signSessionToken(payload: SessionTokenPayload, ttlHours: number): string {
  const options: SignOptions = {
    algorithm: 'HS256',
    expiresIn: `${ttlHours}h`,
    issuer: 'hff',
    audience: 'hff-web',
  };
  return jwt.sign(payload, SECRET, options);
}

export function verifySessionToken(token: string): SessionTokenPayload {
  const decoded = jwt.verify(token, SECRET, {
    algorithms: ['HS256'],
    issuer: 'hff',
    audience: 'hff-web',
  }) as jwt.JwtPayload & SessionTokenPayload;
  if (!decoded.sub || !decoded.jti) {
    throw new Error('Token missing required claims');
  }
  return { sub: decoded.sub, jti: decoded.jti };
}
