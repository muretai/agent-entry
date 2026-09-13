/**
 * One-file Fetch API serverless handler for a repair shop.
 *
 *   export default createRepairShopHandler({
 *     seedHex: env.AGENT_ENTRY_SEED_HEX,
 *     baseUrl: 'https://repairs.example',
 *     store: durableStore, // the seven-method Agent Entry store seam
 *   });
 *
 * Route GET /.well-known/agent-card*.json and POST / to the returned handler. A durable
 * store is required in production so replay, customer, device-owner and KeyState pins survive
 * cold starts; omitting it is useful only for a local function preview.
 */
import { createAgentEntry } from '../muretai-agent-entry.mjs';

export function createRepairShopHandler({
  seedHex,
  baseUrl,
  name = 'Neighborhood Repair Shop',
  store = null,
} = {}) {
  if (!seedHex) throw new TypeError('seedHex is required and must live in the platform secret store');
  if (!baseUrl) throw new TypeError('baseUrl is required and must be the public function URL');
  const entry = createAgentEntry({
    seedHex,
    baseUrl,
    name,
    ...(store ? { store } : {}),
    description: 'Accepts signed repair assessment and drop-off booking requests.',
    skills: [{
      id: 'book-repair',
      name: 'repair-booking',
      description: 'Request repair by item, problem and preferred drop-off date.',
      tags: ['repair', 'service', 'booking'],
      examples: ['Book a bicycle brake repair for drop-off on 2026-09-17'],
    }],
    responder(env) {
      return JSON.stringify({
        type: 'repair_booking_request',
        customer_did: env.owner_did || env.peer_did,
        request: env.text,
        estimate: 'inspection_required',
        status: 'pending_shop_confirmation',
      });
    },
  });

  const handler = async (request) => {
    const url = new URL(request.url);
    const body = request.method === 'GET' || request.method === 'HEAD'
      ? Buffer.alloc(0) : Buffer.from(await request.arrayBuffer());
    const out = await entry.handleRequestAsync(
      request.method,
      url.pathname + url.search,
      Object.fromEntries(request.headers.entries()),
      body,
    );
    return new Response(out.body, { status: out.status, headers: out.headers });
  };
  handler.entry = entry;
  return handler;
}
