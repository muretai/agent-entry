// SPDX-License-Identifier: MIT
/*
 * conformance/fixtures/poppy-validator.mjs - a small Poppy 1.0 discovery-document validator,
 * written from the spec facts alone (personalagentprotocol.org/docs/1.0/spec, read 2026-11-17):
 *   - protocol_version is "1.0";
 *   - organization has name and domain; domain is the host that serves the document, with its
 *     port when the port is not 443, compared ignoring case;
 *   - at least one of agent, apis, web;
 *   - agent.protocols is a list, every entry with type, an https endpoint and a description (8.1);
 *   - apis types are openapi or mcp only;
 *   - every URL in the document is https.
 * Shared by conformance/poppy.mjs and conformance/poppy-fuzz.mjs. Test-author file.
 */

export const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** Every string anywhere in the value. */
export function strings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) strings(v, out);
  return out;
}

/** Problems with `doc` as served from `servedOrigin` (an https origin); empty means valid. */
export function poppyProblems(doc, servedOrigin) {
  const p = [];
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return ['not a JSON object'];
  if (doc.protocol_version !== '1.0') p.push('protocol_version is not "1.0"');
  const org = doc.organization;
  if (!org || typeof org !== 'object' || Array.isArray(org)) p.push('organization missing');
  else {
    if (typeof org.name !== 'string' || !org.name.trim()) p.push('organization.name missing');
    if (typeof org.domain !== 'string' || !org.domain) p.push('organization.domain missing');
    else {
      const served = new URL(servedOrigin);
      // URL.host keeps the port only when it is not the scheme default (443 for https).
      if (org.domain.toLowerCase() !== served.host.toLowerCase()) {
        p.push(`organization.domain ${org.domain} is not the served host ${served.host}`);
      }
    }
  }
  if (!('agent' in doc) && !('apis' in doc) && !('web' in doc)) p.push('none of agent, apis, web');
  if ('agent' in doc) {
    const protocols = doc.agent && doc.agent.protocols;
    if (!Array.isArray(protocols) || protocols.length === 0) p.push('agent.protocols is not a non-empty list');
    else {
      for (const [i, e] of protocols.entries()) {
        if (!e || typeof e !== 'object') { p.push(`agent.protocols[${i}] not an object`); continue; }
        if (typeof e.type !== 'string' || !e.type) p.push(`agent.protocols[${i}].type missing`);
        if (typeof e.endpoint !== 'string' || !/^https:\/\//i.test(e.endpoint)) p.push(`agent.protocols[${i}].endpoint not https`);
        else { try { new URL(e.endpoint); } catch { p.push(`agent.protocols[${i}].endpoint not a URL`); } }
        if (typeof e.description !== 'string' || !e.description.trim()) p.push(`agent.protocols[${i}].description missing (spec 8.1)`);
      }
    }
  }
  if ('apis' in doc) {
    if (!Array.isArray(doc.apis)) p.push('apis is not a list');
    else for (const a of doc.apis) if (!a || (a.type !== 'openapi' && a.type !== 'mcp')) p.push('apis type outside openapi/mcp');
  }
  for (const s of strings(doc)) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !/^https:\/\//i.test(s)) p.push(`non-https URL ${s}`);
  }
  return p;
}
