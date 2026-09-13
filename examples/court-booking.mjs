/**
 * One-file court booking door.
 *
 * Run:
 *   AGENT_ENTRY_SEED_HEX=<saved-32-byte-hex> \
 *   AGENT_ENTRY_BASE_URL=https://courts.example node examples/court-booking.mjs
 */
import {
  createAgentEntry, didFromSeedHex, newSeedHex,
} from '../muretai-agent-entry.mjs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function createCourtBookingDoor({
  seedHex = process.env.AGENT_ENTRY_SEED_HEX,
  baseUrl = process.env.AGENT_ENTRY_BASE_URL || 'http://127.0.0.1:8788',
  name = process.env.AGENT_ENTRY_NAME || 'Community Courts',
} = {}) {
  if (!seedHex) throw new TypeError('Set AGENT_ENTRY_SEED_HEX and keep it: this is the court identity.');
  return createAgentEntry({
    seedHex,
    baseUrl,
    name,
    description: 'Checks court availability and accepts signed booking requests.',
    skills: [{
      id: 'book-court',
      name: 'court-booking',
      description: 'Request a tennis or pickleball court by date and start time.',
      tags: ['court', 'tennis', 'pickleball', 'booking'],
      examples: ['Book a tennis court on 2026-09-15 at 18:00'],
    }],
    responder(env) {
      return JSON.stringify({
        type: 'court_booking_request',
        customer_did: env.owner_did || env.peer_did,
        request: env.text,
        duration_minutes: 60,
        status: 'pending_confirmation',
      });
    },
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let seedHex = process.env.AGENT_ENTRY_SEED_HEX;
  if (!seedHex) {
    seedHex = newSeedHex();
    console.log(`Save this identity before production: AGENT_ENTRY_SEED_HEX=${seedHex}`);
    console.log(`DID: ${didFromSeedHex(seedHex)}`);
  }
  const port = Number(process.env.AGENT_ENTRY_PORT || 8788);
  createCourtBookingDoor({ seedHex }).listen(port, '127.0.0.1', () => {
    console.log(`Court booking door listening on 127.0.0.1:${port}`);
  });
}
