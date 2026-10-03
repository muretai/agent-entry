#!/usr/bin/env node
// Pins the run-time TLS fixture (fixtures/cli/runtime-tls.mjs) under the Node running it.
// Intake 20261003T232057Z: on Node 26 the fixture died at import of every suite that used it,
// because createPublicKey() refuses a KeyObject that is already public. Here, under the current
// Node: spkiDer() hands back a DER SPKI Buffer for a public KeyObject and for a private one, and
// makeRuntimeTls() mints a leaf that still verifies against the CA it minted.
import { X509Certificate, createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { existsSync } from 'node:fs';

import { makeRuntimeTls, spkiDer } from './fixtures/cli/runtime-tls.mjs';

let passed = 0;
const failures = [];

function check(ok, label, detail = '') {
  if (ok) { passed += 1; return true; }
  failures.push(`${label}${detail ? ` - ${String(detail).slice(0, 600)}` : ''}`);
  return false;
}

function section(name, fn) {
  try { fn(); } catch (error) { check(false, `${name}/threw`, error?.stack || String(error)); }
}

/** A DER SPKI: a Buffer that createPublicKey reads back as the same EC public key. */
function isSpki(der, expected) {
  if (!Buffer.isBuffer(der) || der[0] !== 0x30) return false;
  const back = createPublicKey({ key: der, format: 'der', type: 'spki' });
  return back.asymmetricKeyType === 'ec' && back.equals(expected);
}

section('spki', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  check(isSpki(spkiDer(publicKey), publicKey), 'spki/public-keyobject', `node ${process.version}`);
  check(isSpki(spkiDer(privateKey), publicKey), 'spki/private-keyobject', `node ${process.version}`);
});

section('mint', () => {
  const tls = makeRuntimeTls();
  try {
    const ca = new X509Certificate(tls.ca);
    const leaf = new X509Certificate(tls.cert);
    check(ca.ca === true, 'mint/ca-is-ca');
    check(leaf.ca === false, 'mint/leaf-is-not-ca');
    check(leaf.verify(ca.publicKey), 'mint/leaf-verifies-against-ca');
    check(leaf.checkIssued(ca), 'mint/leaf-issued-by-ca');
    check(leaf.checkIP('127.0.0.1') === '127.0.0.1', 'mint/leaf-names-127.0.0.1');
    check(leaf.checkPrivateKey(createPrivateKey(tls.key)), 'mint/key-matches-leaf');
    check(existsSync(tls.caPath) && existsSync(tls.certPath) && existsSync(tls.keyPath), 'mint/files-written');
  } finally {
    tls.cleanup();
  }
  check(!existsSync(tls.dir), 'mint/cleanup-removes-dir');
});

if (failures.length) {
  console.error(`runtime-tls: ${failures.length} failed, ${passed} passed (node ${process.version})`);
  for (const f of failures) console.error(`  FAIL ${f}`);
  process.exit(1);
}
console.log(`runtime-tls: ${passed} passed (node ${process.version})`);
