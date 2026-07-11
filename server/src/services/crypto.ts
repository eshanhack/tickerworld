import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export function createId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function encodeBase58(bytes: Uint8Array): string {
  let numeric = 0n;
  for (const byte of bytes) numeric = numeric * 256n + BigInt(byte);
  let encoded = '';
  while (numeric > 0n) {
    encoded = `${BASE58_ALPHABET[Number(numeric % 58n)]}${encoded}`;
    numeric /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = `1${encoded}`;
  }
  return encoded || '1';
}

/** Solana Pay references are ordinary 32-byte public keys, not arbitrary IDs. */
export function randomSolanaReference(): string {
  return encodeBase58(randomBytes(32));
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function hmacSha256(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value, 'utf8').digest('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function hashIp(secret: string, ip: string): string {
  return createHmac('sha256', secret).update(ip || 'unknown', 'utf8').digest('hex');
}
