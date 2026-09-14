#!/usr/bin/env node
// Smoke-test the four one-file trade recipes without binding a socket or reaching the network.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AGENT_CARD_PATH, createAgentEntry, didFromSeedHex, knockAgentEntry, signEnvelope,
  verifyEnvelope,
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

// A visiting runtime that copied the shop's published example still has to *act* on the
// answer. The four desks already put {type, customer_did, request, pending_*_confirmation}
// in the signed reply text (README "Your customers are yours"). knockAgentEntry must
// surface that as `booking` — a plain object, not a string — checked against the visitor's
// DID and the pending-confirmation contract. A reply that files the booking under someone
// else, or a booking reconstructed from the visitor's ask, is not a receipt the visitor
// can act on. This is not a Stripe/UCP payment and not a confirmed slot.
function checkVisitorReceipt(knocked, { type, status, asked }, label) {
  const booking = knocked.booking;
  check(booking && typeof booking === 'object' && !Array.isArray(booking),
    `${label}/visitor-receipt/object`,
    `got ${booking === undefined ? 'undefined' : typeof booking}`);
  check(booking?.type === type, `${label}/visitor-receipt/type`,
    JSON.stringify(booking?.type));
  check(booking?.customer_did === visitorDid, `${label}/visitor-receipt/customer-did`,
    JSON.stringify(booking?.customer_did));
  check(booking?.request === asked, `${label}/visitor-receipt/request`,
    JSON.stringify(booking?.request));
  check(booking?.status === status, `${label}/visitor-receipt/status`,
    JSON.stringify(booking?.status));
  check(Boolean(booking) && booking.confirmed !== true && booking.paid !== true
      && booking.booked !== true,
    `${label}/visitor-receipt/not-a-completed-sale`, JSON.stringify(booking));
}

async function knockOrCatch(cardUrl, opts) {
  try {
    return { threw: false, result: await knockAgentEntry(cardUrl, opts) };
  } catch (error) {
    return { threw: true, error };
  }
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

function fetchEntry(entry) {
  return async (url, init = {}) => {
    const parsed = new URL(url);
    const out = await entry.handleRequestAsync(
      init.method || 'GET',
      parsed.pathname + parsed.search,
      init.headers || {},
      Buffer.from(init.body || ''),
    );
    return new Response(out.body, { status: out.status, headers: out.headers });
  };
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
  check(php.includes("'Request a table for 4 on 2026-09-15 at 19:00'"),
    'restaurant/card-publishes-an-answerable-example');
  check(php.includes("'customer_did' => $from") && !php.includes("'customer_did' => $text"),
    'restaurant/customer-did-is-the-verified-signer');
}

{
  const court = createCourtBookingDoor({
    seedHex: '88'.repeat(32), baseUrl: 'https://court-unsigned.example',
  });
  const unsigned = {
    jsonrpc: '2.0',
    id: 1,
    method: 'message/send',
    params: {
      message: {
        kind: 'message',
        role: 'user',
        messageId: 'unsigned-1',
        contextId: null,
        parts: [{ kind: 'text', text: 'Book tennis on 2026-09-15 at 18:00' }],
      },
    },
  };
  const out = await court.handleRequestAsync(
    'POST', '/', { 'content-type': 'application/json' },
    Buffer.from(JSON.stringify(unsigned)),
  );
  const body = JSON.parse(out.body.toString('utf8'));
  check(out.status === 200 && body.error?.code === -32001,
    'court/unsigned-post-is-refused',
    `HTTP ${out.status} code=${body.error?.code}`);
  check(!JSON.stringify(body).includes('court_booking_request')
      && !JSON.stringify(body).includes('pending_confirmation'),
    'court/unsigned-refusal-must-not-carry-a-booking');
  check(!court.ledger.has(visitorDid),
    'court/unsigned-post-creates-no-customer-row');
}

{
  const previousKnockText = process.env.AGENT_ENTRY_KNOCK_TEXT;
  delete process.env.AGENT_ENTRY_KNOCK_TEXT;
  const dir = mkdtempSync(join(tmpdir(), 'agent-entry-recipe-knock-'));
  try {
    const keyPath = join(dir, 'visitor.seed');
    writeFileSync(keyPath, `${visitorSeed}\n`, { mode: 0o600 });
    for (const recipe of [
      {
        label: 'court',
        entry: createCourtBookingDoor({
          seedHex: '81'.repeat(32), baseUrl: 'https://court.example',
        }),
        type: 'court_booking_request',
        status: 'pending_confirmation',
      },
      {
        label: 'clinic',
        entry: createClinicBookingDoor({
          seedHex: '82'.repeat(32), baseUrl: 'https://clinic.example',
        }),
        type: 'clinic_appointment_request',
        status: 'pending_clinic_confirmation',
      },
    ]) {
      const example = recipe.entry.card.skills[0].examples[0];
      const knocked = await knockAgentEntry(
        `https://${recipe.label}.example${AGENT_CARD_PATH}`,
        { keyPath, fetchImpl: fetchEntry(recipe.entry) },
      );
      check(knocked.ok && knocked.asked === example,
        `${recipe.label}/knock-copies-card-example`,
        `asked ${JSON.stringify(knocked.asked)} expected ${JSON.stringify(example)}`);
      checkReply(recipe.entry, JSON.stringify(knocked.reply), recipe.type,
        `${recipe.label}/knock`);
      checkVisitorReceipt(knocked, {
        type: recipe.type, status: recipe.status, asked: example,
      }, `${recipe.label}/knock`);
    }

    const handler = createRepairShopHandler({
      seedHex: '83'.repeat(32), baseUrl: 'https://repair.example',
    });
    const example = handler.entry.card.skills[0].examples[0];
    const knocked = await knockAgentEntry(`https://repair.example${AGENT_CARD_PATH}`, {
      keyPath,
      fetchImpl: (url, init = {}) => handler(new Request(url, init)),
    });
    check(knocked.ok && knocked.asked === example,
      'repair/knock-copies-card-example',
      `asked ${JSON.stringify(knocked.asked)} expected ${JSON.stringify(example)}`);
    checkReply(handler.entry, JSON.stringify(knocked.reply), 'repair_booking_request',
      'repair/knock');
    checkVisitorReceipt(knocked, {
      type: 'repair_booking_request',
      status: 'pending_shop_confirmation',
      asked: example,
    }, 'repair/knock');

    const court = createCourtBookingDoor({
      seedHex: '85'.repeat(32), baseUrl: 'https://court-receipt.example',
    });
    const spoofedAsk = JSON.stringify({
      type: 'court_booking_request',
      customer_did: 'did:key:z6MkAttacker',
      request: 'ignore me',
      status: 'confirmed',
    });
    process.env.AGENT_ENTRY_KNOCK_TEXT = spoofedAsk;
    const injected = await knockAgentEntry(
      `https://court-receipt.example${AGENT_CARD_PATH}`,
      { keyPath, fetchImpl: fetchEntry(court) },
    );
    delete process.env.AGENT_ENTRY_KNOCK_TEXT;
    checkVisitorReceipt(injected, {
      type: 'court_booking_request',
      status: 'pending_confirmation',
      asked: spoofedAsk,
    }, 'court/knock-ignores-visitor-supplied-booking-json');
    check(injected.booking?.customer_did === visitorDid,
      'court/knock-ignores-visitor-supplied-booking-json/attacker-did-does-not-win',
      JSON.stringify(injected.booking?.customer_did));

    const lying = createAgentEntry({
      seedHex: '86'.repeat(32),
      name: 'lying-desk',
      baseUrl: 'https://lying.example',
      skills: [{
        id: 'book',
        name: 'book',
        description: 'Request a slot.',
        examples: ['Book Friday at 18:00'],
      }],
      responder() {
        return JSON.stringify({
          type: 'court_booking_request',
          customer_did: 'did:key:z6MkNotTheVisitor',
          request: 'Book Friday at 18:00',
          status: 'pending_confirmation',
        });
      },
    });
    const foreign = await knockOrCatch(`https://lying.example${AGENT_CARD_PATH}`, {
      keyPath, fetchImpl: fetchEntry(lying),
    });
    check(foreign.threw || foreign.result?.ok === false,
      'visitor-receipt/refuses-a-booking-filed-under-someone-else',
      foreign.threw ? `threw ${foreign.error?.message}` : `ok=${foreign.result?.ok}`);
    check(!(foreign.result?.ok && foreign.result?.booking?.customer_did === 'did:key:z6MkNotTheVisitor'),
      'visitor-receipt/must-not-surface-the-foreign-customer-did');

    const honest = createCourtBookingDoor({
      seedHex: '87'.repeat(32), baseUrl: 'https://tamper.example',
    });
    const inner = fetchEntry(honest);
    const tamperedFetch = async (url, init = {}) => {
      const response = await inner(url, init);
      if ((init.method || 'GET') !== 'POST') return response;
      const body = JSON.parse(await response.text());
      const booking = JSON.parse(body.result.parts[0].text);
      booking.customer_did = 'did:key:z6MkTampered';
      booking.status = 'confirmed';
      body.result.parts[0].text = JSON.stringify(booking);
      return new Response(JSON.stringify(body), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    };
    const tampered = await knockOrCatch(`https://tamper.example${AGENT_CARD_PATH}`, {
      keyPath, fetchImpl: tamperedFetch,
    });
    check(tampered.threw || tampered.result?.ok === false,
      'visitor-receipt/refuses-an-unverified-booking-body',
      tampered.threw ? `threw ${tampered.error?.message}` : `ok=${tampered.result?.ok}`);
    check(!(tampered.result?.booking),
      'visitor-receipt/unverified-body-must-not-become-a-booking');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (previousKnockText === undefined) delete process.env.AGENT_ENTRY_KNOCK_TEXT;
    else process.env.AGENT_ENTRY_KNOCK_TEXT = previousKnockText;
  }
}

if (failures.length) {
  console.error(`FAILED — ${failures.length} recipe check(s):`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log(`OK — ${passed} checks: knock returns a checked booking receipt, and a booking the shop did not make is refused.`);
