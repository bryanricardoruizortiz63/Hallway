/**
 * An Excel that asks for a PIN to open: Office's own lock («Agile encryption», ECMA-376 / MS-OFFCRYPTO 2.3.4.10:
 * AES-256 and SHA-512), the one Excel uses for «Proteger con contraseña». It opens with the PIN in Excel, Numbers,
 * LibreOffice and Google Sheets. The PIN isn't stored anywhere: without it nobody can read the file.
 *
 * The locked file is a «Compound File» (MS-CFB) with two streams:
 *   · EncryptionInfo: how to check the PIN and get the key (an XML with salts and encrypted values);
 *   · EncryptedPackage: the .xlsx, encrypted in 4096-byte pieces with a random 256-bit key.
 * The password is hashed 100,000 times (spinCount), as Excel does: a fast SHA-512 here, WebCrypto for the rest.
 */

const subtle = globalThis.crypto.subtle;
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

const le32 = (n) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
const b64 = (bytes) => btoa(String.fromCharCode(...bytes));

// ---- SHA-512, synchronous (the 100,000 rounds would take seconds one await at a time) ----------------------------

const K = (() => {
  const hex = '428a2f98d728ae22 7137449123ef65cd b5c0fbcfec4d3b2f e9b5dba58189dbbc 3956c25bf348b538 59f111f1b605d019 ' +
    '923f82a4af194f9b ab1c5ed5da6d8118 d807aa98a3030242 12835b0145706fbe 243185be4ee4b28c 550c7dc3d5ffb4e2 ' +
    '72be5d74f27b896f 80deb1fe3b1696b1 9bdc06a725c71235 c19bf174cf692694 e49b69c19ef14ad2 efbe4786384f25e3 ' +
    '0fc19dc68b8cd5b5 240ca1cc77ac9c65 2de92c6f592b0275 4a7484aa6ea6e483 5cb0a9dcbd41fbd4 76f988da831153b5 ' +
    '983e5152ee66dfab a831c66d2db43210 b00327c898fb213f bf597fc7beef0ee4 c6e00bf33da88fc2 d5a79147930aa725 ' +
    '06ca6351e003826f 142929670a0e6e70 27b70a8546d22ffc 2e1b21385c26c926 4d2c6dfc5ac42aed 53380d139d95b3df ' +
    '650a73548baf63de 766a0abb3c77b2a8 81c2c92e47edaee6 92722c851482353b a2bfe8a14cf10364 a81a664bbc423001 ' +
    'c24b8b70d0f89791 c76c51a30654be30 d192e819d6ef5218 d69906245565a910 f40e35855771202a 106aa07032bbd1b8 ' +
    '19a4c116b8d2d0c8 1e376c085141ab53 2748774cdf8eeb99 34b0bcb5e19b48a8 391c0cb3c5c95a63 4ed8aa4ae3418acb ' +
    '5b9cca4f7763e373 682e6ff3d6b2b8a3 748f82ee5defb2fc 78a5636f43172f60 84c87814a1f0ab72 8cc702081a6439ec ' +
    '90befffa23631e28 a4506cebde82bde9 bef9a3f7b2c67915 c67178f2e372532b ca273eceea26619c d186b8c721c0c207 ' +
    'eada7dd6cde0eb1e f57d4f7fee6ed178 06f067aa72176fba 0a637dc5a2c898a6 113f9804bef90dae 1b710b35131c471b ' +
    '28db77f523047d84 32caab7b40c72493 3c9ebe0a15c9bebc 431d67c49c100d4c 4cc5d4becb3e42b6 597f299cfc657e2a ' +
    '5fcb6fab3ad6faec 6c44198c4a475817';
  return hex.split(' ').flatMap((h) => [parseInt(h.slice(0, 8), 16) | 0, parseInt(h.slice(8), 16) | 0]);
})();
const H0 = [0x6a09e667, 0xf3bcc908, 0xbb67ae85, 0x84caa73b, 0x3c6ef372, 0xfe94f82b, 0xa54ff53a, 0x5f1d36f1,
  0x510e527f, 0xade682d1, 0x9b05688c, 0x2b3e6c1f, 0x1f83d9ab, 0xfb41bd6b, 0x5be0cd19, 0x137e2179].map((x) => x | 0);
const W = new Int32Array(160);

/** SHA-512 of the bytes (each 64-bit word as two 32-bit halves, high then low). */
export function sha512(data) {
  const bits = data.length * 8;
  const padded = new Uint8Array(((data.length + 17 + 127) >> 7) << 7);
  padded.set(data);
  padded[data.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, Math.floor(bits / 0x100000000));
  dv.setUint32(padded.length - 4, bits >>> 0);
  const h = H0.slice();
  for (let off = 0; off < padded.length; off += 128) {
    for (let i = 0; i < 32; i++) W[i] = dv.getInt32(off + i * 4);
    for (let i = 32; i < 160; i += 2) {
      // σ0(W[t-15]) and σ1(W[t-2])
      let xh = W[i - 30], xl = W[i - 29];
      const s0h = ((xh >>> 1) | (xl << 31)) ^ ((xh >>> 8) | (xl << 24)) ^ (xh >>> 7);
      const s0l = ((xl >>> 1) | (xh << 31)) ^ ((xl >>> 8) | (xh << 24)) ^ ((xl >>> 7) | (xh << 25));
      xh = W[i - 4];
      xl = W[i - 3];
      const s1h = ((xh >>> 19) | (xl << 13)) ^ ((xl >>> 29) | (xh << 3)) ^ (xh >>> 6);
      const s1l = ((xl >>> 19) | (xh << 13)) ^ ((xh >>> 29) | (xl << 3)) ^ ((xl >>> 6) | (xh << 26));
      const lo = (s0l >>> 0) + (s1l >>> 0) + (W[i - 13] >>> 0) + (W[i - 31] >>> 0);
      const hi = s0h + s1h + W[i - 14] + W[i - 32] + Math.floor(lo / 0x100000000);
      W[i] = hi | 0;
      W[i + 1] = lo | 0;
    }
    let [ah, al, bh, bl, ch, cl, dh, dl, eh, el, fh, fl, gh, gl, hh, hl] = h;
    for (let i = 0; i < 160; i += 2) {
      const S1h = ((eh >>> 14) | (el << 18)) ^ ((eh >>> 18) | (el << 14)) ^ ((el >>> 9) | (eh << 23));
      const S1l = ((el >>> 14) | (eh << 18)) ^ ((el >>> 18) | (eh << 14)) ^ ((eh >>> 9) | (el << 23));
      const chh = (eh & fh) ^ (~eh & gh);
      const chl = (el & fl) ^ (~el & gl);
      let t1l = (hl >>> 0) + (S1l >>> 0) + (chl >>> 0) + (K[i + 1] >>> 0) + (W[i + 1] >>> 0);
      const t1h = hh + S1h + chh + K[i] + W[i] + Math.floor(t1l / 0x100000000);
      t1l |= 0;
      const S0h = ((ah >>> 28) | (al << 4)) ^ ((al >>> 2) | (ah << 30)) ^ ((al >>> 7) | (ah << 25));
      const S0l = ((al >>> 28) | (ah << 4)) ^ ((ah >>> 2) | (al << 30)) ^ ((ah >>> 7) | (al << 25));
      const majh = (ah & bh) ^ (ah & ch) ^ (bh & ch);
      const majl = (al & bl) ^ (al & cl) ^ (bl & cl);
      const t2l = (S0l >>> 0) + (majl >>> 0);
      const t2h = S0h + majh + Math.floor(t2l / 0x100000000);
      hh = gh; hl = gl; gh = fh; gl = fl; fh = eh; fl = el;
      let x = (dl >>> 0) + (t1l >>> 0);
      eh = (dh + t1h + Math.floor(x / 0x100000000)) | 0;
      el = x | 0;
      dh = ch; dl = cl; ch = bh; cl = bl; bh = ah; bl = al;
      x = (t1l >>> 0) + (t2l >>> 0);
      ah = (t1h + t2h + Math.floor(x / 0x100000000)) | 0;
      al = x | 0;
    }
    const add = [ah, al, bh, bl, ch, cl, dh, dl, eh, el, fh, fl, gh, gl, hh, hl];
    for (let i = 0; i < 16; i += 2) {
      const lo = (h[i + 1] >>> 0) + (add[i + 1] >>> 0);
      h[i] = (h[i] + add[i] + Math.floor(lo / 0x100000000)) | 0;
      h[i + 1] = lo | 0;
    }
  }
  const out = new Uint8Array(64);
  const ov = new DataView(out.buffer);
  h.forEach((v, i) => ov.setInt32(i * 4, v));
  return out;
}

// ---- Agile encryption ---------------------------------------------------------------------------------------------

const SPIN = 100000;
const BLOCK = {
  verifierInput: [0xfe, 0xa7, 0xd2, 0x76, 0x3b, 0x4b, 0x9e, 0x79],
  verifierValue: [0xd7, 0xaa, 0x0f, 0x6d, 0x30, 0x61, 0x34, 0x4e],
  keyValue: [0x14, 0x6e, 0x0b, 0xe7, 0xab, 0xac, 0xd0, 0xd6],
  hmacKey: [0x5f, 0xb2, 0xad, 0x01, 0x0c, 0xb9, 0xe1, 0xf6],
  hmacValue: [0xa0, 0x67, 0x7f, 0x02, 0xb2, 0x2c, 0x84, 0x33],
};

/** AES-256-CBC without padding (the data is already a multiple of 16: WebCrypto's extra block is dropped). */
async function aes(keyBytes, iv, data) {
  const padded = data.length % 16 ? concat(data, new Uint8Array(16 - (data.length % 16))) : data;
  const key = await subtle.importKey('raw', keyBytes, 'AES-CBC', false, ['encrypt']);
  return new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv }, key, padded)).slice(0, padded.length);
}

/** The password's hash after the 100,000 rounds (MS-OFFCRYPTO 2.3.4.11). */
function passwordHash(password, salt) {
  const utf16 = new Uint8Array(password.length * 2);
  for (let i = 0; i < password.length; i++) {
    utf16[i * 2] = password.charCodeAt(i) & 0xff;
    utf16[i * 2 + 1] = password.charCodeAt(i) >> 8;
  }
  let h = sha512(concat(salt, utf16));
  const buf = new Uint8Array(68);
  for (let i = 0; i < SPIN; i++) {
    buf.set(le32(i), 0);
    buf.set(h, 4);
    h = sha512(buf);
  }
  return h;
}

const blockKey = (hash, block) => sha512(concat(hash, new Uint8Array(block))).slice(0, 32);
const blockIv = (salt, block) => sha512(concat(salt, block)).slice(0, 16);

/** The .xlsx bytes encrypted with the key, in 4096-byte pieces, after its size (8 bytes). */
async function encryptPackage(bytes, key, salt) {
  const parts = [le32(bytes.length), le32(0)];
  for (let i = 0, n = 0; i < bytes.length; i += 4096, n++) {
    parts.push(await aes(key, blockIv(salt, le32(n)), bytes.subarray(i, i + 4096)));
  }
  return concat(...parts);
}

/** The .xlsx (bytes) locked with the PIN, as the bytes of the Compound File. */
export async function lockXlsx(xlsx, pin) {
  const password = String(pin);
  const keySalt = random(16);
  const passwordSalt = random(16);
  const secretKey = random(32);

  const pkg = await encryptPackage(xlsx, secretKey, keySalt);

  // Data integrity: an HMAC of the encrypted package, with a random key, both encrypted with the file's key.
  const hmacKey = random(64);
  const hk = await subtle.importKey('raw', hmacKey, { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
  const hmac = new Uint8Array(await subtle.sign('HMAC', hk, pkg));
  const encHmacKey = await aes(secretKey, blockIv(keySalt, new Uint8Array(BLOCK.hmacKey)), hmacKey);
  const encHmacValue = await aes(secretKey, blockIv(keySalt, new Uint8Array(BLOCK.hmacValue)), hmac);

  // The password's lock: a check value and the file's key, encrypted with keys made from the password.
  const hash = passwordHash(password, passwordSalt);
  const verifier = random(16);
  const encVerifierInput = await aes(blockKey(hash, BLOCK.verifierInput), passwordSalt, verifier);
  const encVerifierValue = await aes(blockKey(hash, BLOCK.verifierValue), passwordSalt, sha512(verifier));
  const encKeyValue = await aes(blockKey(hash, BLOCK.keyValue), passwordSalt, secretKey);

  const params = 'saltSize="16" blockSize="16" keyBits="256" hashSize="64" cipherAlgorithm="AES" cipherChaining="ChainingModeCBC" hashAlgorithm="SHA512"';
  const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
    '<encryption xmlns="http://schemas.microsoft.com/office/2006/encryption" ' +
    'xmlns:p="http://schemas.microsoft.com/office/2006/keyEncryptor/password" ' +
    'xmlns:c="http://schemas.microsoft.com/office/2006/keyEncryptor/certificate">' +
    `<keyData ${params} saltValue="${b64(keySalt)}"/>` +
    `<dataIntegrity encryptedHmacKey="${b64(encHmacKey)}" encryptedHmacValue="${b64(encHmacValue)}"/>` +
    '<keyEncryptors><keyEncryptor uri="http://schemas.microsoft.com/office/2006/keyEncryptor/password">' +
    `<p:encryptedKey spinCount="${SPIN}" ${params} saltValue="${b64(passwordSalt)}" ` +
    `encryptedVerifierHashInput="${b64(encVerifierInput)}" encryptedVerifierHashValue="${b64(encVerifierValue)}" ` +
    `encryptedKeyValue="${b64(encKeyValue)}"/></keyEncryptor></keyEncryptors></encryption>`;
  // Version 4.4, «agile» (flag 0x40), then the XML.
  const info = concat(new Uint8Array([4, 0, 4, 0, 0x40, 0, 0, 0]), new TextEncoder().encode(xml));

  return compoundFile([
    { name: 'EncryptionInfo', data: info },
    { name: 'EncryptedPackage', data: pkg },
  ]);
}

// ---- Compound File (MS-CFB, version 3: 512-byte sectors, 64-byte mini sectors under 4096 bytes) ------------------

const FREE = 0xffffffff;
const END = 0xfffffffe;
const FATSECT = 0xfffffffd;
const NOSTREAM = 0xffffffff;

/** A Compound File with these streams in its root (names under 32 characters). */
export function compoundFile(streams) {
  const big = streams.filter((s) => s.data.length >= 4096);
  const small = streams.filter((s) => s.data.length < 4096);

  // The mini stream: the small streams in 64-byte pieces, one after the other.
  const miniFat = [];
  const miniParts = [];
  for (const s of small) {
    const n = Math.max(1, Math.ceil(s.data.length / 64));
    s.start = miniFat.length;
    for (let i = 0; i < n; i++) miniFat.push(i === n - 1 ? END : miniFat.length + 1);
    const chunk = new Uint8Array(n * 64);
    chunk.set(s.data);
    miniParts.push(chunk);
  }
  const miniStream = concat(...miniParts);

  // Sectors in order: FAT, directory, mini FAT, mini stream, then each big stream.
  const sectors = (bytes) => Math.ceil(bytes / 512);
  const dirSectors = sectors((streams.length + 1) * 128);
  const miniFatSectors = miniFat.length ? sectors(miniFat.length * 4) : 0;
  const miniStreamSectors = sectors(miniStream.length);
  const dataSectors = big.reduce((n, s) => n + sectors(s.data.length), 0);
  let fatSectors = 1;
  while (fatSectors * 128 < fatSectors + dirSectors + miniFatSectors + miniStreamSectors + dataSectors) fatSectors++;
  if (fatSectors > 109) throw new Error('El archivo es demasiado grande para protegerlo.');

  const total = fatSectors + dirSectors + miniFatSectors + miniStreamSectors + dataSectors;
  const fat = new Uint32Array(fatSectors * 128).fill(FREE);
  let next = 0;
  const chain = (count, special) => {
    const start = next;
    for (let i = 0; i < count; i++, next++) fat[next] = special ?? (i === count - 1 ? END : next + 1);
    return count ? start : END;
  };
  chain(fatSectors, FATSECT);
  const dirStart = chain(dirSectors);
  const miniFatStart = chain(miniFatSectors);
  const miniStreamStart = chain(miniStreamSectors);
  for (const s of big) s.start = chain(sectors(s.data.length));

  // Directory: the root, then the streams as a balanced tree, sorted the CFB way (shorter names first, then A–Z);
  // the nodes on an incomplete last level are red, the rest black.
  const sorted = [...streams].sort((a, b) => a.name.length - b.name.length || (a.name.toUpperCase() < b.name.toUpperCase() ? -1 : 1));
  const depth = Math.floor(Math.log2(sorted.length));
  const perfect = sorted.length === 2 ** (depth + 1) - 1;
  const node = new Map();
  const build = (lo, hi, level) => {
    if (lo > hi) return NOSTREAM;
    const mid = (lo + hi + 1) >> 1;
    node.set(mid, { left: build(lo, mid - 1, level + 1), right: build(mid + 1, hi, level + 1), red: !perfect && level === depth });
    return mid + 1;
  };
  const top = build(0, sorted.length - 1, 0);
  const dir = new Uint8Array(dirSectors * 512);
  const dv = new DataView(dir.buffer);
  const entry = (i, { name, type, left = NOSTREAM, right = NOSTREAM, child = NOSTREAM, start = 0, size = 0, red = false }) => {
    const o = i * 128;
    for (let c = 0; c < name.length; c++) dv.setUint16(o + c * 2, name.charCodeAt(c), true);
    dv.setUint16(o + 64, name ? (name.length + 1) * 2 : 0, true);
    dir[o + 66] = type;
    dir[o + 67] = red ? 0 : 1;
    dv.setUint32(o + 68, left, true);
    dv.setUint32(o + 72, right, true);
    dv.setUint32(o + 76, child, true);
    dv.setUint32(o + 116, start, true);
    dv.setUint32(o + 120, size, true);
  };
  for (let i = 0; i < dirSectors * 4; i++) entry(i, { name: '', type: 0 });
  entry(0, { name: 'Root Entry', type: 5, child: top, start: miniStream.length ? miniStreamStart : END, size: miniStream.length });
  sorted.forEach((s, i) => entry(i + 1, { name: s.name, type: 2, ...node.get(i), start: s.start, size: s.data.length }));

  const header = new Uint8Array(512);
  const hv = new DataView(header.buffer);
  header.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  hv.setUint16(24, 0x003e, true); // minor version
  hv.setUint16(26, 0x0003, true); // major version 3
  hv.setUint16(28, 0xfffe, true); // little-endian
  hv.setUint16(30, 9, true); // 512-byte sectors
  hv.setUint16(32, 6, true); // 64-byte mini sectors
  hv.setUint32(44, fatSectors, true);
  hv.setUint32(48, dirStart, true);
  hv.setUint32(56, 4096, true); // mini stream cutoff
  hv.setUint32(60, miniFatSectors ? miniFatStart : END, true);
  hv.setUint32(64, miniFatSectors, true);
  hv.setUint32(68, END, true); // no DIFAT sectors
  for (let i = 0; i < 109; i++) hv.setUint32(76 + i * 4, i < fatSectors ? i : FREE, true);

  const out = new Uint8Array(512 + total * 512);
  out.set(header);
  const put = (sector, bytes) => out.set(bytes, 512 + sector * 512);
  const fatBytes = new Uint8Array(fat.buffer);
  put(0, fatBytes);
  put(dirStart, dir);
  if (miniFatSectors) {
    const mf = new Uint32Array(miniFatSectors * 128).fill(FREE);
    mf.set(miniFat);
    put(miniFatStart, new Uint8Array(mf.buffer));
  }
  if (miniStream.length) put(miniStreamStart, miniStream);
  for (const s of big) put(s.start, s.data);
  return out;
}
