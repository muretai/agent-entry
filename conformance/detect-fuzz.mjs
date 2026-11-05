#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Kind fuzz: the store's answers that source detection decodes.
//
// WRITTEN BEFORE THE IMPLEMENTATION (test author only). Intake 20261031T165410Z: `init <store url>`
// detects its source. The implementer may not edit this file. Run it as
// `node conformance/detect-fuzz.mjs`.
//
// Property: no_crash -- for every generated set of answers (status, content type and body bytes,
// drawn afresh for each request: robots.txt, the Store API products path, the sitemap and any page)
// detectSource(storeUrl) either resolves the name of a registered detector, or rejects with a named
// refusal: an Error, not one of the built-in TypeError, RangeError, SyntaxError or ReferenceError,
// whose message names the store host and says either that no source was detected or why robots.txt
// stopped the read. It never throws anything else and never hangs.
//
// Deterministic: a local seeded generator (mulberry32, fixed seed), a stubbed globalThis.fetch, no
// network. A failure names the case index, so it reproduces exactly.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as door from '../muretai-agent-entry.mjs';

const FUZZ_SEED = 0xde7ec7;
const CASES = 400;
const STORE = 'https://fuzz.example/';
const HOST = 'fuzz.example';
const NAMED = /no source (was )?detected|robots/i;
const BUILTIN = [TypeError, RangeError, SyntaxError, ReferenceError];

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

const STATUSES = [200, 200, 200, 200, 204, 301, 404, 410, 500, 503];
const TYPES = ['application/json; charset=UTF-8', 'text/html; charset=utf-8', 'text/xml', 'text/plain', 'application/octet-stream', ''];

const FIXED = [
  '', '[]', '{}', 'null', '[null]', '[{}]', '[1,2,3]', '"x"', '﻿[]', '[{"id":1}]',
  '[{"id":1,"name":"Lamp","prices":{"price":"100","currency_minor_unit":2,"currency_code":"EUR"},"is_in_stock":true,"permalink":"https://fuzz.example/p/1"}]',
  '[{"id":"__proto__","prices":{"price":"1e999","currency_minor_unit":-1}}]',
  '<?xml version="1.0"?><urlset><url><loc>https://fuzz.example/p/1</loc></url></urlset>',
  '<?xml version="1.0"?><sitemapindex><sitemap><loc>https://fuzz.example/s.xml</loc></sitemap></sitemapindex>',
  '<urlset><url><loc>https://other.example/p/1</loc></url><url><loc>javascript:alert(1)</loc></url></urlset>',
  '<script type="application/ld+json">{"@type":"Product","name":"L","offers":{"price":"1","priceCurrency":"EUR","availability":"InStock","url":"https://fuzz.example/p/1"}}</script>',
  '<script type="application/ld+json">{"@type":"Product","offers":[null,{"price":{}}]}</script>',
  '<script type="application/ld+json">{"@graph":[{"@graph":[{"@type":["Product"]}]}]}</script>',
  '<script type="application/ld+json">{</script>',
  'User-agent: *\nAllow: /\n', 'User-agent: *\nDisallow: /wp-json/\n', 'User-agent: *\nDisallow: /\n',
  'User-agent: agent-entry\nDisallow: *$\n', '\u0000\u0001\u0002', '\ud800', '😀'.repeat(50),
];

/** One answer of a random kind: a fixed tricky body, random bytes, random text, or a spliced fixed body. */
function answerFrom(rand) {
  const pick = (s) => s[Math.floor(rand() * s.length)];
  const status = pick(STATUSES);
  const type = pick(TYPES);
  const kind = Math.floor(rand() * 5);
  const len = Math.floor(rand() * 2048);
  let body;
  switch (kind) {
    case 0: body = Buffer.from(pick(FIXED)); break;
    case 1: body = Buffer.from(Array.from({ length: len }, () => Math.floor(rand() * 256))); break;
    case 2: {
      let s = '';
      for (let i = 0; i < len; i += 1) s += String.fromCharCode(0x20 + Math.floor(rand() * 95));
      body = Buffer.from(s);
      break;
    }
    case 3: {
      const s = pick(FIXED);
      const cut = Math.floor(rand() * (s.length + 1));
      body = Buffer.from(s.slice(0, cut) + pick(FIXED) + s.slice(cut));
      break;
    }
    default: body = Buffer.from(pick(FIXED).repeat(1 + Math.floor(rand() * 8)));
  }
  const headers = { 'content-type': type };
  if (status >= 300 && status < 400) headers.location = pick(['https://fuzz.example/elsewhere', 'https://other.example/', '::not a url']);
  if (rand() < 0.2) headers['x-wp-totalpages'] = pick(['1', '0', '-1', '99999999999999999999', 'abc', '']);
  if (rand() < 0.1) headers['content-length'] = String(body.length);
  return { status, headers, body };
}

async function withFuzzFetch(rand, fn) {
  const real = globalThis.fetch;
  let requests = 0;
  const offHost = [];
  globalThis.fetch = async (input) => {
    requests += 1;
    const url = String(input?.url ?? input);
    if (new URL(url).host !== HOST) offHost.push(url);
    if (rand() < 0.03) throw new TypeError('fetch failed');
    const { status, headers, body } = answerFrom(rand);
    return new Response(status === 204 ? null : body, { status, headers });
  };
  try {
    return await fn(() => requests);
  } finally {
    globalThis.fetch = real;
    // Recorded, not thrown inside fetch: a detector would read a throw there as "no answer".
    assert.deepEqual(offHost, [], 'detection asks only the store host');
  }
}

test('kind fuzz: detectSource resolves a registered source or refuses by name, never crashes', async () => {
  const { SOURCE_DETECTORS, detectSource } = door;
  assert.equal(typeof detectSource, 'function', 'detectSource is exported');
  assert.ok(Array.isArray(SOURCE_DETECTORS), 'SOURCE_DETECTORS is exported');
  const names = new Set(SOURCE_DETECTORS.map((d) => d.name));
  const rand = mulberry32(FUZZ_SEED);
  const seen = { resolved: 0, refused: 0 };
  for (let i = 0; i < CASES; i += 1) {
    const what = `case ${i}`;
    await withFuzzFetch(rand, async (requests) => {
      let value;
      let error = null;
      try {
        value = await Promise.race([
          detectSource(STORE),
          new Promise((_, reject) => { setTimeout(() => reject(new Error('__hung__')), 10000).unref(); }),
        ]);
      } catch (e) { error = e; }
      if (error === null) {
        assert.ok(names.has(value), `${what}: resolved ${JSON.stringify(value)}, not a registered source`);
        seen.resolved += 1;
        return;
      }
      assert.notEqual(error?.message, '__hung__', `${what}: detection hung`);
      assert.ok(error instanceof Error, `${what}: threw a non-Error ${String(error)}`);
      assert.ok(!BUILTIN.some((C) => error.constructor === C),
        `${what}: an uncaught ${error.constructor.name}: ${error.message} (${requests()} requests)`);
      assert.ok(error.message.includes(HOST), `${what}: the refusal names the store: ${error.message}`);
      assert.ok(NAMED.test(error.message), `${what}: a named refusal, not ${JSON.stringify(error.message.slice(0, 200))}`);
      seen.refused += 1;
    });
  }
  // A harness whose every case ended the same way would prove little.
  assert.ok(seen.refused > 0, `some cases are refused (${JSON.stringify(seen)})`);
});
