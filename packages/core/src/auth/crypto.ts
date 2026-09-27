import {
  createHash,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';

import type { Role } from '../domain/status.js';

function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

const SCRYPT = { N: 16384, r: 8, p: 1 } as const;

/** `scrypt$N$r$p$<salt b64>$<hash b64>` */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A URL-safe random token with a recognisable prefix. */
export function randomToken(prefix: string, bytes = 32): string {
  return `${prefix}${randomBytes(bytes).toString('base64url')}`;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** A readable one-time password for the evaluation admin. */
export function generatePassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(20);
  let out = '';
  for (const b of bytes) out += alphabet.charAt(b % alphabet.length);
  return `${out.slice(0, 5)}-${out.slice(5, 10)}-${out.slice(10, 15)}-${out.slice(15, 20)}`;
}

const RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 };

export function roleAtLeast(role: Role, required: Role): boolean {
  return RANK[role] >= RANK[required];
}
