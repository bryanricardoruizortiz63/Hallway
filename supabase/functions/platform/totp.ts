// Codes of an authenticator app (Google or Microsoft Authenticator): TOTP, RFC 6238 (SHA-1, 6 digits, 30 s).
// No network, no npm imports, so it runs in tests without permissions.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Uint8Array<ArrayBuffer> {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const c of clean) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error('Clave no válida.');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** A new secret: 20 random bytes, in base32 (what the QR carries). */
export const newSecret = () => base32Encode(crypto.getRandomValues(new Uint8Array(20)));

/** The code of one 30-second step (counter). */
export async function hotp(secret: string, counter: number, digits = 6): Promise<string> {
  const key = await crypto.subtle.importKey('raw', base32Decode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setBigUint64(0, BigInt(counter));
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const offset = mac[mac.length - 1] & 15;
  const n = ((mac[offset] & 127) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(n % 10 ** digits).padStart(digits, '0');
}

/**
 * Checks a 6-digit code against the current step and one on each side (the phone's clock may be a little off).
 * Returns the step it matched, or null. A step at or before lastCounter was already used: refused, so a code seen
 * over someone's shoulder can't be used again.
 */
export async function verifyTotp(
  secret: string,
  code: string,
  lastCounter: number | null,
  now = Date.now(),
): Promise<number | null> {
  if (!/^\d{6}$/.test(code)) return null;
  const step = Math.floor(now / 30000);
  for (const counter of [step - 1, step, step + 1]) {
    if (lastCounter !== null && counter <= lastCounter) continue;
    if (await hotp(secret, counter) === code) return counter;
  }
  return null;
}

/** What the authenticator app scans. */
export function otpauthUri(secret: string, issuer: string, account: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
