/**
 * A PDF that asks for a PIN to open: the PDF standard's own lock (AES-256, «revision 6»), so it works outside Hallway,
 * in any PDF reader (Acrobat, Chrome, Edge, Safari and Preview, the Files app, Google Drive…). The PIN isn't stored
 * anywhere: without it the file can't be read, and nobody, not even Hallway, can open it.
 *
 * Built with the browser's own cryptography (WebCrypto). How it works (ISO 32000-2, 7.6.4):
 *   · a random 256-bit key encrypts every stream and string of the file (AES-256-CBC, a random IV in front of each);
 *   · /U and /UE let a reader check the PIN and recover that key; /O and /OE do the same for an owner password nobody
 *     knows (random), so the permissions can't be changed;
 *   · /Perms holds the permissions, encrypted with the key.
 */

const subtle = globalThis.crypto.subtle;
const ZERO_IV = new Uint8Array(16);

const random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** AES-CBC. WebCrypto always pads; «no padding» (data already a multiple of 16) is the same output without its last block. */
async function aesCbc(keyBytes, iv, data, padded = true) {
  const key = await subtle.importKey('raw', keyBytes, 'AES-CBC', false, ['encrypt']);
  const out = new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv }, key, data));
  return padded ? out : out.slice(0, data.length);
}

/** Algorithm 2.B: the hash of a password with its salt (and, for the owner, /U). */
async function hash2B(password, salt, udata) {
  let k = new Uint8Array(await subtle.digest('SHA-256', concat(password, salt, udata)));
  let e = new Uint8Array(0);
  for (let round = 0; round < 64 || e[e.length - 1] > round - 32; round++) {
    const unit = concat(password, k, udata);
    const k1 = new Uint8Array(unit.length * 64);
    for (let i = 0; i < 64; i++) k1.set(unit, i * unit.length);
    e = await aesCbc(k.slice(0, 16), k.slice(16, 32), k1, false);
    // The first 16 bytes as a number, mod 3 (256 ≡ 1 mod 3: the sum of the bytes is enough).
    let sum = 0;
    for (let i = 0; i < 16; i++) sum += e[i];
    k = new Uint8Array(await subtle.digest(['SHA-256', 'SHA-384', 'SHA-512'][sum % 3], e));
  }
  return k.slice(0, 32);
}

/** /U and /UE (or /O and /OE, with /U as udata) for a password. */
async function passwordEntries(password, fileKey, udata) {
  const validation = random(8);
  const keySalt = random(8);
  const check = concat(await hash2B(password, validation, udata), validation, keySalt);
  const wrapped = await aesCbc(await hash2B(password, keySalt, udata), ZERO_IV, fileKey, false);
  return [check, wrapped];
}

/** Every permission (print, copy…): the PIN is the lock; whoever has it uses the file as usual. */
const PERMISSIONS = -4;

/**
 * The lock for one file: the /Encrypt dictionary, the file's /ID, and the functions that encrypt its streams and strings.
 * The PIN is a password like any other (up to 127 bytes, UTF-8).
 */
export async function pdfLock(pin) {
  const password = new TextEncoder().encode(String(pin).normalize('NFKC')).slice(0, 127);
  const fileKey = random(32);
  const [u, ue] = await passwordEntries(password, fileKey, new Uint8Array(0));
  const [o, oe] = await passwordEntries(random(32), fileKey, u);
  const p = new Uint8Array(16);
  new DataView(p.buffer).setInt32(0, PERMISSIONS, true);
  p.set([0xff, 0xff, 0xff, 0xff, 0x54 /* T: metadata encrypted too */, 0x61, 0x64, 0x62], 4);
  p.set(random(4), 12);
  const perms = await aesCbc(fileKey, ZERO_IV, p, false);
  const key = await subtle.importKey('raw', fileKey, 'AES-CBC', false, ['encrypt']);
  const encrypt = async (bytes) => {
    const iv = random(16);
    return concat(iv, new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv }, key, bytes)));
  };
  return {
    dictionary:
      '<< /Filter /Standard /V 5 /R 6 /Length 256 /CF << /StdCF << /AuthEvent /DocOpen /CFM /AESV3 /Length 32 >> >>' +
      ` /StmF /StdCF /StrF /StdCF /O <${hex(o)}> /U <${hex(u)}> /OE <${hex(oe)}> /UE <${hex(ue)}>` +
      ` /P ${PERMISSIONS} /Perms <${hex(perms)}> /EncryptMetadata true >>`,
    id: hex(random(16)),
    stream: encrypt,
    /** A string of the file, encrypted, as <hex>. */
    string: async (text) => `<${hex(await encrypt(new TextEncoder().encode(text)))}>`,
  };
}
