import { assert, assertEquals } from 'jsr:@std/assert@1';
import { b64urlToBytes, bytesToB64url, encryptPayload, isDeadEndpoint, vapidAuthorization } from './webpush.ts';

type Bytes = Uint8Array<ArrayBuffer>;
const enc = new TextEncoder();

async function hmac(key: Bytes, data: Bytes): Promise<Bytes> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** What the browser does when a push arrives (RFC 8291), used to check our encryption end to end. */
async function decrypt(body: Bytes, ua: CryptoKeyPair, uaPublic: Bytes, auth: Bytes): Promise<string> {
  const salt = body.slice(0, 16);
  const idLen = body[20];
  const senderPublic = body.slice(21, 21 + idLen);
  const cipher = body.slice(21 + idLen);
  const senderKey = await crypto.subtle.importKey('raw', senderPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: senderKey }, ua.privateKey, 256));
  const ikm = await hmac(await hmac(auth, ecdh), concat(enc.encode('WebPush: info\0'), uaPublic, senderPublic, new Uint8Array([1])));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, cipher));
  assertEquals(plain[plain.length - 1], 2, 'last-record delimiter');
  return new TextDecoder().decode(plain.slice(0, -1));
}

Deno.test('encrypts a payload the browser can decrypt', async () => {
  const ua = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const uaPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const message = JSON.stringify({ title: 'Nueva ausencia: María González', body: 'jue 24 sep · Día completo', url: '#/absence/7' });

  const body = await encryptPayload(enc.encode(message), bytesToB64url(uaPublic), bytesToB64url(auth));
  assertEquals(new DataView(body.buffer).getUint32(16), 4096, 'record size');
  assertEquals(await decrypt(body, ua, uaPublic, auth), message);
});

Deno.test('signs a valid VAPID token for the push service', async () => {
  const keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const publicKey = bytesToB64url(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)));
  const privateKey = (await crypto.subtle.exportKey('jwk', keys.privateKey)).d!;

  const header = await vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', {
    publicKey,
    privateKey,
    subject: 'https://example.org/app/',
  });
  const [, token, k] = header.match(/^vapid t=([^,]+), k=(.+)$/)!;
  assertEquals(k, publicKey);
  const [h, c, s] = token.split('.');
  const claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(c)));
  assertEquals(claims.aud, 'https://fcm.googleapis.com');
  assert(claims.exp > Date.now() / 1000);
  const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, keys.publicKey, b64urlToBytes(s), enc.encode(`${h}.${c}`));
  assert(valid, 'signature verifies with the public key');
});

Deno.test('knows the subscriptions the browser removed for good', () => {
  assert(isDeadEndpoint('https://permanently-removed.invalid/fcm/send/abc'));
  assert(isDeadEndpoint('https://invalid/x'));
  assert(isDeadEndpoint('not a url'));
  assert(isDeadEndpoint('http://fcm.googleapis.com/fcm/send/abc'));
  assert(!isDeadEndpoint('https://fcm.googleapis.com/fcm/send/abc'));
  assert(!isDeadEndpoint('https://web.push.apple.com/QGx'));
  assert(!isDeadEndpoint('https://updates.push.services.mozilla.com/wpush/v2/gAAA'));
  assert(!isDeadEndpoint('https://wns2-bl2p.notify.windows.com/w/?token=x'));
});
