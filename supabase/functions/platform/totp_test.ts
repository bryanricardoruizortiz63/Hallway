import { base32Decode, base32Encode, hotp, newSecret, verifyTotp } from './totp.ts';

const assertEquals = (a: unknown, b: unknown) => {
  if (a !== b) throw new Error(`${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
};

// RFC 6238, SHA-1 key "12345678901234567890" (6 digits: the last six of the RFC's 8-digit codes).
const RFC = base32Encode(new TextEncoder().encode('12345678901234567890'));

Deno.test('RFC 6238 vectors', async () => {
  assertEquals(await hotp(RFC, Math.floor(59 / 30)), '287082');
  assertEquals(await hotp(RFC, Math.floor(1111111109 / 30)), '081804');
  assertEquals(await hotp(RFC, Math.floor(1234567890 / 30)), '005924');
});

Deno.test('base32 round trip', () => {
  const s = newSecret();
  assertEquals(s.length, 32);
  assertEquals(base32Encode(base32Decode(s)), s);
});

Deno.test('a code works once, with a step of margin', async () => {
  const now = 1234567890 * 1000;
  const step = Math.floor(now / 30000);
  const code = await hotp(RFC, step);
  assertEquals(await verifyTotp(RFC, code, null, now), step);
  assertEquals(await verifyTotp(RFC, code, step, now), null);
  assertEquals(await verifyTotp(RFC, await hotp(RFC, step - 1), null, now), step - 1);
  assertEquals(await verifyTotp(RFC, await hotp(RFC, step - 3), null, now), null);
  assertEquals(await verifyTotp(RFC, '12345', null, now), null);
});
