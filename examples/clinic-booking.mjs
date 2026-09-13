/**
 * One-file clinic appointment door. This records a request; it never diagnoses or handles
 * emergencies. Put it behind the clinic's TLS origin and connect the responder to scheduling.
 */
import {
  createAgentEntry, didFromSeedHex, newSeedHex,
} from '../muretai-agent-entry.mjs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function createClinicBookingDoor({
  seedHex = process.env.AGENT_ENTRY_SEED_HEX,
  baseUrl = process.env.AGENT_ENTRY_BASE_URL || 'http://127.0.0.1:8789',
  name = process.env.AGENT_ENTRY_NAME || 'Neighborhood Clinic',
} = {}) {
  if (!seedHex) throw new TypeError('Set AGENT_ENTRY_SEED_HEX and keep it: this is the clinic identity.');
  return createAgentEntry({
    seedHex,
    baseUrl,
    name,
    description: 'Accepts signed non-emergency appointment requests. No medical advice.',
    skills: [{
      id: 'request-appointment',
      name: 'clinic-appointment-request',
      description: 'Request a non-emergency appointment by service, date and preferred time.',
      tags: ['clinic', 'appointment', 'booking'],
      examples: ['Request a dental cleaning on 2026-09-16 in the morning'],
    }],
    responder(env) {
      return JSON.stringify({
        type: 'clinic_appointment_request',
        customer_did: env.owner_did || env.peer_did,
        request: env.text,
        emergency: false,
        status: 'pending_clinic_confirmation',
        notice: 'For an emergency, contact local emergency services.',
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
  const port = Number(process.env.AGENT_ENTRY_PORT || 8789);
  createClinicBookingDoor({ seedHex }).listen(port, '127.0.0.1', () => {
    console.log(`Clinic booking door listening on 127.0.0.1:${port}`);
  });
}
