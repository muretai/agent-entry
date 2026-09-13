#!/usr/bin/env node
// Smoke-test the four one-file trade recipes without binding a socket or reaching the network.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  didFromSeedHex, signEnvelope, verifyEnvelope,
} from '../muretai-agent-entry.mjs';
import { createCourtBookingDoor } from '../examples/court-booking.mjs';
import { createClinicBookingDoor } from '../examples/clinic-booking.mjs';
import { createRepairShopHandler } from '../examples/repair-shop-serverless.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const visitorSeed = '77'.repeat(32);
const visitorDid = didFromSeedHex(visitorSeed);
let sequence = 0;
let passed = 0;
const failures = [];

function check(ok, label, detail = '') {
  if (ok) { passed += 1; return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
}

function requestFor(entry, text) {
  const fields = {
    from: visitorDid,
    to: entry.did,
    messageId: `recipe-${++sequence}`,
    contextId: null,
    timestamp: Math.floor(Date.now() / 1000),
    text,
  };
  return {
    jsonrpc: '2.0',
    id: fields.messageId,
    method: 'message/send',
    params: {
      message: {
        kind: 'message',
        role: 'user',
        messageId: fields.messageId,
        contextId: null,
        parts: [{ kind: 'text', text }],
        metadata: {
          from: visitorDid,
          to: entry.did,
          timestamp: fields.timestamp,
          sig: signEnvelope(visitorSeed, fields),
        },
      },
    },
  };
}

function checkReply(entry, body, expectedType, label) {
  const reply = JSON.parse(body);
  const message = reply.result;
  const text = message?.parts?.[0]?.text;
  const fields = {
    from: message?.metadata?.from,
    to: message?.metadata?.to,
    messageId: message?.messageId,
    contextId: message?.contextId ?? null,
    timestamp: message?.metadata?.timestamp,
    text,
    sig: message?.metadata?.sig,
  };
  check(Boolean(message) && verifyEnvelope(fields, {
    recipientDid: visitorDid, signerDid: entry.did,
  }), `${label}/signed-reply`);
  let booking = null;
  try { booking = JSON.parse(text); } catch { /* reported below */ }
  check(booking?.type === expectedType && booking?.customer_did === visitorDid
    && typeof booking?.request === 'string' && booking?.status?.includes('confirmation'),
  `${label}/booking-shape`, JSON.stringify(booking));
}

for (const recipe of [
  {
    label: 'court',
    entry: createCourtBookingDoor({
      seedHex: '81'.repeat(32), baseUrl: 'https://court.example',
    }),
    text: 'Book tennis on 2026-09-15 at 18:00',
    type: 'court_booking_request',
  },
  {
    label: 'clinic',
    entry: createClinicBookingDoor({
      seedHex: '82'.repeat(32), baseUrl: 'https://clinic.example',
    }),
    text: 'Request a cleaning on 2026-09-16 in the morning',
    type: 'clinic_appointment_request',
  },
]) {
  const out = await recipe.entry.handleRequestAsync(
    'POST',
    '/',
    { 'content-type': 'application/json' },
    Buffer.from(JSON.stringify(requestFor(recipe.entry, recipe.text))),
  );
  check(out.status === 200, `${recipe.label}/post-root`, `HTTP ${out.status}`);
  checkReply(recipe.entry, out.body.toString('utf8'), recipe.type, recipe.label);
}

{
  const handler = createRepairShopHandler({
    seedHex: '83'.repeat(32), baseUrl: 'https://repair.example',
  });
  const request = requestFor(handler.entry, 'Book bicycle brake repair for Thursday');
  const response = await handler(new Request('https://repair.example/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  }));
  check(response.status === 200, 'repair/post-root', `HTTP ${response.status}`);
  checkReply(handler.entry, await response.text(), 'repair_booking_request', 'repair');
}

{
  const php = readFileSync(join(HERE, '..', 'examples', 'restaurant-wordpress.php'), 'utf8');
  check(php.includes("Plugin Name: Restaurant Agent Entry")
    && php.includes("sodium_crypto_sign_verify_detached")
    && php.includes("$method === 'POST' && $path === '/'")
    && php.includes("'type' => 'restaurant_reservation_request'"),
  'restaurant/wordpress-one-file-verifier');
  check(!php.includes('http://127.0.0.1') && !php.includes('shell_exec'),
    'restaurant/no-hidden-sidecar');
}

if (failures.length) {
  console.error(`FAILED — ${failures.length} recipe check(s):`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log(`OK — ${passed} checks: all four trade recipes answer with their booking shape.`);
