/**
 * Time-based one-time passwords (RFC 6238) on top of HMAC-SHA1 (RFC 4226), using node:crypto only.
 * 30-second steps, 6 digits, and verification accepts the neighbouring step either side so a
 * phone whose clock drifts by a few seconds still works.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh 160-bit secret, base32 encoded for authenticator apps. */
export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

function hotp(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  const digest = createHmac('sha1', secret).update(msg).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const code = ((digest[offset]! & 0x7f) << 24) | ((digest[offset + 1]! & 0xff) << 16) | ((digest[offset + 2]! & 0xff) << 8) | (digest[offset + 3]! & 0xff);
  return String(code % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

export function totpCode(secret: string, at: Date = new Date(), stepOffset = 0): string {
  const counter = Math.floor(at.getTime() / 1000 / TOTP_STEP_SECONDS) + stepOffset;
  return hotp(base32Decode(secret), counter);
}

/** True when the code matches the current step or the step either side. */
export function verifyTotp(secret: string, code: string, at: Date = new Date(), window = 1): boolean {
  const given = (code ?? '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(given)) return false;
  const a = Buffer.from(given);
  for (let offset = -window; offset <= window; offset++) {
    const expected = Buffer.from(totpCode(secret, at, offset));
    if (expected.length === a.length && timingSafeEqual(expected, a)) return true;
  }
  return false;
}

/** URL an authenticator app can scan (as a QR code) or be given by hand. */
export function otpauthUrl(secret: string, accountName: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${accountName}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(TOTP_DIGITS), period: String(TOTP_STEP_SECONDS) });
  return `otpauth://totp/${label}?${params.toString()}`;
}
