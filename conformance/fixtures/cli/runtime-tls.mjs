// A throwaway test CA, a leaf certificate for 127.0.0.1 / localhost signed by it, and the leaf's
// private key, built at run time with node:crypto only (no openssl, no dependency), so no
// certificate or key is ever committed. Every call mints fresh keys; nothing is reused.
//
//   makeRuntimeTls() -> { dir, ca, caPath, cert, certPath, key, keyPath, cleanup() }
//     ca / cert / key   PEM Buffers (createHttpsServer({ key, cert }), https.request({ ca }))
//     caPath            the CA file, for NODE_EXTRA_CA_CERTS (trust is added, never disabled)
//     dir               a fresh mkdtemp directory under os.tmpdir(); cleanup() removes it
//
// node:crypto signs but does not build X.509, so the two certificates are DER-encoded here by
// hand (RFC 5280): v3, ecdsa-with-SHA256 over P-256 keys, valid from one hour ago for one day.
import { KeyObject, createPublicKey, generateKeyPairSync, randomBytes, sign, createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function derLength(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag, ...content) => {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
};
const seq = (...items) => tlv(0x30, ...items);
const set = (...items) => tlv(0x31, ...items);
const explicit = (n, ...items) => tlv(0xa0 | n, ...items);
const octets = (buf) => tlv(0x04, buf);
const bits = (buf, unused = 0) => tlv(0x03, Buffer.from([unused]), buf);
const bool = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));

function integer(buf) {
  let b = buf;
  while (b.length > 1 && b[0] === 0 && (b[1] & 0x80) === 0) b = b.subarray(1);
  return tlv(0x02, (b[0] & 0x80) ? Buffer.concat([Buffer.from([0]), b]) : b);
}

function oid(dotted) {
  const parts = dotted.split('.').map(Number);
  const out = [40 * parts[0] + parts[1]];
  for (const p of parts.slice(2)) {
    const chunk = [p & 0x7f];
    for (let v = p >>> 7; v > 0; v >>>= 7) chunk.unshift(0x80 | (v & 0x7f));
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

function utcTime(d) {
  const two = (n) => String(n).padStart(2, '0');
  const s = `${two(d.getUTCFullYear() % 100)}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}`
    + `${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(s, 'ascii'));
}

const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));
const name = (cn) => seq(set(seq(oid('2.5.4.3'), utf8(cn))));
const extension = (id, critical, value) => seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));

/** A public KeyObject is exported as is: Node 26 refuses createPublicKey() on a KeyObject that is
 *  already public (ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE). Anything else still goes through it. */
export function spkiDer(publicKey) {
  const key = publicKey instanceof KeyObject && publicKey.type === 'public' ? publicKey : createPublicKey(publicKey);
  return key.export({ type: 'spki', format: 'der' });
}

/** The SHA-1 of the subjectPublicKey bits (RFC 5280 4.2.1.2 method 1). A P-256 SPKI ends with
 *  the 65-byte uncompressed point, which is exactly those bits. */
function keyId(spki) {
  return createHash('sha1').update(spki.subarray(spki.length - 65)).digest();
}

function certificate({ serial, issuer, subject, spki, extensions, signingKey, notBefore, notAfter }) {
  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))),
    integer(serial),
    ECDSA_SHA256,
    name(issuer),
    seq(utcTime(notBefore), utcTime(notAfter)),
    name(subject),
    spki,
    explicit(3, seq(...extensions)),
  );
  const signature = sign('sha256', tbs, signingKey);
  return seq(tbs, ECDSA_SHA256, bits(signature));
}

function pem(label, der) {
  const b64 = der.toString('base64').match(/.{1,64}/g).join('\n');
  return Buffer.from(`-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`, 'ascii');
}

function serialNumber() {
  const s = randomBytes(16);
  s[0] = (s[0] & 0x7f) | 0x01;
  return s;
}

export function makeRuntimeTls({ prefix = 'ae-runtime-tls-' } = {}) {
  const now = Date.now();
  const notBefore = new Date(now - 3600 * 1000);
  const notAfter = new Date(now + 24 * 3600 * 1000);

  const caPair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const caSpki = spkiDer(caPair.publicKey);
  const caKeyId = keyId(caSpki);
  const caName = 'agent-entry conformance throwaway CA';
  const caDer = certificate({
    serial: serialNumber(), issuer: caName, subject: caName, spki: caSpki, signingKey: caPair.privateKey,
    notBefore, notAfter,
    extensions: [
      extension('2.5.29.19', true, seq(bool(true))),                 // basicConstraints: CA
      extension('2.5.29.15', true, bits(Buffer.from([0x06]), 1)),    // keyUsage: keyCertSign, cRLSign
      extension('2.5.29.14', false, octets(caKeyId)),                // subjectKeyIdentifier
    ],
  });

  const leafPair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const leafSpki = spkiDer(leafPair.publicKey);
  const leafDer = certificate({
    serial: serialNumber(), issuer: caName, subject: '127.0.0.1', spki: leafSpki, signingKey: caPair.privateKey,
    notBefore, notAfter,
    extensions: [
      extension('2.5.29.19', true, seq()),                           // basicConstraints: not a CA
      extension('2.5.29.15', true, bits(Buffer.from([0x80]), 7)),    // keyUsage: digitalSignature
      extension('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))),  // extKeyUsage: serverAuth
      extension('2.5.29.17', false, seq(                             // subjectAltName
        tlv(0x87, Buffer.from([127, 0, 0, 1])),
        tlv(0x82, Buffer.from('localhost', 'ascii')),
      )),
      extension('2.5.29.35', false, seq(tlv(0x80, caKeyId))),        // authorityKeyIdentifier
    ],
  });

  const dir = mkdtempSync(join(tmpdir(), prefix));
  const ca = pem('CERTIFICATE', caDer);
  const cert = pem('CERTIFICATE', leafDer);
  const key = Buffer.from(leafPair.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const caPath = join(dir, 'ca.crt');
  const certPath = join(dir, 'leaf.crt');
  const keyPath = join(dir, 'leaf.key');
  writeFileSync(caPath, ca, { mode: 0o644 });
  writeFileSync(certPath, cert, { mode: 0o644 });
  writeFileSync(keyPath, key, { mode: 0o600 });
  return { dir, ca, caPath, cert, certPath, key, keyPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
