#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Kind fuzz: the /.well-known/poppy.json route and poppyDocument, over a request target and a
// Host header that arrive from outside the process, and a card name and description that the
// operator types.
//
// WRITTEN BEFORE THE IMPLEMENTATION (test author only). The implementer may not edit this file.
// Run it as `node conformance/poppy-fuzz.mjs`.
//
// Property: no_crash plus equivalent --
//   (a) for every generated request target and Host header, the door answers without throwing;
//       the answer is 200 only when the target is exactly '/.well-known/poppy.json', and then
//       its bytes are equal to the bytes of the plain request (Host never moves a byte); every
//       other target is the ordinary 404, `{"error":"not found"}`.
//   (b) for every generated card name and description, createAgentEntry either refuses with a
//       TypeError or starts; a started door answers 404 or a document that parses, passes the
//       spec validator, carries no control character in any string, has no raw '<' or control
//       byte in its served bytes, and is at most 8192 bytes. poppyDocument never throws on it.
//
// Deterministic: a local seeded generator (mulberry32, fixed seed), no network. A failure names
// the case index and the input, so it reproduces exactly.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as door from '../muretai-agent-entry.mjs';
import { CONTROL, poppyProblems, strings } from './fixtures/poppy-validator.mjs';

const SEED = '5b'.repeat(32);
const PATH = '/.well-known/poppy.json';
const NOT_FOUND = '{"error":"not found"}';
const FUZZ_SEED = 0x90bb1e5;
const CASES = 400;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rand, list) => list[Math.floor(rand() * list.length)];

// No lone '?' and no '#': an empty query and a fragment are not pinned by the requirement.
const PIECES = ['/', '.', '..', '%2e', '%2E', '%2f', '%00', '?a=1', '?x', ';', '\\', '//', 'POPPY', 'Poppy',
  '.json', '.JSON', '.well-known', '.WELL-KNOWN', 'poppy', '%20', ' ', '\t', 'é', '\u0000', '~', '*'];

/** A mutation of the canonical path: insert, delete, replace or case-flip at a random place. */
function target(rand) {
  let s = PATH;
  const n = 1 + Math.floor(rand() * 3);
  for (let i = 0; i < n; i += 1) {
    const at = Math.floor(rand() * (s.length + 1));
    const op = Math.floor(rand() * 5);
    if (op === 0) s = s.slice(0, at) + pick(rand, PIECES) + s.slice(at);
    else if (op === 1) s = s.slice(0, at) + s.slice(at + 1 + Math.floor(rand() * 3));
    else if (op === 2) s = s.slice(0, at) + pick(rand, PIECES) + s.slice(at + 1);
    else if (op === 3) s = s.slice(0, at) + s.slice(at, at + 1).toUpperCase() + s.slice(at + 1);
    else s = pick(rand, ['https://victim.example', 'http://shop.example', '//', '']) + s;
  }
  return s;
}

const HOSTS = ['shop.example', 'victim.example', 'SHOP.EXAMPLE', 'shop.example:8443', 'shop.example.victim.example',
  '127.0.0.1:8788', '[::1]', '', 'a'.repeat(300), 'shop.example\u0000victim.example', 'xn--pppy-0qa.example'];

const ALPHABET = ['P', 'o', 'p', 'y', ' ', '<', '>', '&', '"', '\'', '\\', '/', '\u0000', '\u0007', '\u001b', '\u007f',
  '\u0085', '\u009f', ' ', ' ', '﻿', 'é', '\u{1f33a}', '\ud800', '\udfff', '\n', '\r', '\t'];

function text(rand) {
  const kind = Math.floor(rand() * 6);
  if (kind === 0) return '';
  if (kind === 1) return 'x'.repeat(1 + Math.floor(rand() * 70000));
  if (kind === 2) return '<script>alert(1)</script>';
  let s = '';
  const len = Math.floor(rand() * 200);
  for (let i = 0; i < len; i += 1) s += pick(rand, ALPHABET);
  return s;
}

function call(e, method, path, headers) {
  const r = e.handleRequest(method, path, headers, Buffer.alloc(0));
  return { status: r.status, body: Buffer.from(r.body || Buffer.alloc(0)) };
}

test('fuzz (a): only the exact path answers, and Host never moves a byte', () => {
  const rand = mulberry32(FUZZ_SEED);
  const e = door.createAgentEntry({ seedHex: SEED, name: 'Poppy Shop', description: 'Flowers.',
    baseUrl: 'https://shop.example', poppy: true });
  const plain = call(e, 'GET', PATH, {});
  assert.equal(plain.status, 200, 'the plain request is not served');
  for (let i = 0; i < CASES; i += 1) {
    const path = rand() < 0.15 ? PATH : target(rand);
    if (path.includes('#') || /\?$/.test(path)) continue;
    const host = pick(rand, HOSTS);
    const method = rand() < 0.5 ? 'GET' : 'HEAD';
    let r;
    try { r = call(e, method, path, { host, 'x-forwarded-host': pick(rand, HOSTS) }); } catch (err) {
      assert.fail(`case ${i}: ${method} ${JSON.stringify(path)} Host ${JSON.stringify(host)} threw ${err?.stack || err}`);
    }
    const label = `case ${i}: ${method} ${JSON.stringify(path)} Host ${JSON.stringify(host)}`;
    if (path === PATH) {
      assert.equal(r.status, 200, label);
      assert.ok(r.body.equals(plain.body), `${label}: bytes moved`);
    } else {
      assert.notEqual(r.status, 200, `${label}: answered 200`);
      assert.ok(!r.body.toString('utf8').includes('protocol_version'), `${label}: leaked the document`);
      if (r.status === 404) assert.equal(r.body.toString('utf8'), NOT_FOUND, label);
    }
  }
});

test('fuzz (b): any card name and description yields a clean, bounded document or none', () => {
  const rand = mulberry32(FUZZ_SEED ^ 0x5a5a5a5a);
  assert.equal(typeof door.poppyDocument, 'function', 'poppyDocument is not exported');
  for (let i = 0; i < CASES / 4; i += 1) {
    const name = text(rand);
    const description = text(rand);
    const label = `case ${i}: name ${JSON.stringify(name.slice(0, 60))} (${name.length}) description `
      + `${JSON.stringify(description.slice(0, 60))} (${description.length})`;
    let e;
    try {
      e = door.createAgentEntry({ seedHex: SEED, baseUrl: 'https://shop.example', poppy: true,
        name: name || undefined, description });
    } catch (err) {
      assert.ok(err instanceof TypeError, `${label}: start failed with ${err?.stack || err}`);
      continue;
    }
    let doc;
    try { doc = door.poppyDocument(e.card, 'https://shop.example'); } catch (err) {
      assert.fail(`${label}: poppyDocument threw ${err?.stack || err}`);
    }
    if (doc !== null) assert.deepEqual(poppyProblems(doc, 'https://shop.example'), [], label);
    const r = call(e, 'GET', PATH, {});
    if (r.status === 404) continue;
    assert.equal(r.status, 200, label);
    assert.ok(r.body.length <= 8192, `${label}: ${r.body.length} bytes`);
    const raw = r.body.toString('utf8');
    assert.ok(!raw.includes('<'), `${label}: raw < in the served bytes`);
    assert.ok(!/[\u0000-\u001f]/.test(raw), `${label}: raw control byte in the served bytes`);
    const served = JSON.parse(raw);
    assert.deepEqual(poppyProblems(served, 'https://shop.example'), [], label);
    for (const s of strings(served)) assert.ok(!CONTROL.test(s), `${label}: control character in ${JSON.stringify(s.slice(0, 80))}`);
  }
});
