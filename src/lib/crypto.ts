import crypto from 'crypto';
import { env } from '../config/env';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

const key = Buffer.from(env.ENCRYPTION_KEY, 'hex');

if (key.length !== 32) {
  throw new Error('ENCRYPTION_KEY must decode to 32 bytes');
}

/** Encrypt a UTF-8 string. Returns base64(iv | tag | ciphertext). */
export function encrypt(plaintext: string): string {
  if (typeof plaintext !== 'string') throw new Error('encrypt: plaintext must be string');
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

/** Decrypt the output of encrypt(). Throws if tampered or malformed. */
export function decrypt(payload: string): string {
  if (typeof payload !== 'string') throw new Error('decrypt: payload must be string');
  const buf = Buffer.from(payload, 'base64');
  if (buf.length < IV_LEN + TAG_LEN) throw new Error('decrypt: payload too short');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

/** Returns true if payload looks like a valid base64 envelope. */
export function isEncrypted(payload: unknown): payload is string {
  if (typeof payload !== 'string' || payload.length < 28) return false;
  try {
    const buf = Buffer.from(payload, 'base64');
    return buf.length >= IV_LEN + TAG_LEN;
  } catch {
    return false;
  }
}

/** Constant-time string compare. */
export function safeEqual(a: string, b: string): boolean {
  const A = Buffer.from(a);
  const B = Buffer.from(b);
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}
