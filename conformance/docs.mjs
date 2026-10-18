#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/*
 * conformance/docs.mjs — Suite S4: the README, the CHANGELOG record and connectors/muse.md say
 * what the code does.
 *
 * WHERE THE NAMES COME FROM. Every list this file checks the documents against is read from the
 * code at run time, never copied here:
 *
 *   - the verbs and their defaults: `VERBS` and `VERB_EFFECTS`, exported by the module;
 *   - the counting events: `COLLECTOR_EVENTS`, exported by the module, plus every event name the
 *     page runtime (`agent-entry-page.mjs`) emits;
 *   - the CLI commands: the usage line the CLI itself prints when it is run with no command;
 *   - the signed contract's paths: `TOOLS_PATH` and `TOOLS_SIG_PATH`, exported by the module.
 *
 * So a verb, an event or a command added later is a red row here until the README names it.
 *
 * WHAT IS PINNED, BY SECTION.
 *   - "Put it on a site": `npx @muretai/agent-entry init` is the first way; the curl/copy of the
 *     one file is still there as the second.
 *   - "What a customer can do here": one table row per verb — the verb, its default, an example.
 *   - "Pairs with WebMCP": the signed contract (both paths, the `agenttools` envelope) and the
 *     page runtime `agent-entry-page.mjs`.
 *   - "Counting visits": `gaSink`, the collector, `counts`, `entry.counts`.
 *   - connectors/muse.md: a passage on asking the shop's card which verbs it offers (`skills[]`,
 *     one per offer).
 *   - Every example URL in those sections that was not already there before S4 uses a placeholder
 *     host (example.com, *.test, *.invalid, 192.0.2.0/24) — and the check is shown to refuse a
 *     real one.
 *   - CHANGELOG.md: the 1.13.0 record carries a "Suite S4" heading beside S2 and S3.
 *   - package.json: the version is the released one, read from CHANGELOG.md's newest dated
 *     section (a heading ending in "(YYYY-MM-DD)"), never a literal here; an undated heading
 *     such as "(not yet published)" is not a release.
 *   - Hosted counts (S6a-4): "Counting visits" says the door and the page runtime post to
 *     `entry.counts` and the card publishes it, and no longer says it is planned; the newest
 *     CHANGELOG section records hosted counts. An unpublished heading still passes. A dated
 *     heading passes only for 2.0.0 when that section records hosted counts.
 *
 * Run:  node conformance/docs.mjs      (from the package root)
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as door from '../muretai-agent-entry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let pass = 0;
const failures = [];

function check(ok, label, detail) {
  if (ok) { pass += 1; return true; }
  failures.push(detail ? `${label}\n      ${detail}` : label);
  return false;
}

/** One block; a throw inside it is ONE red row rather than the end of the run. */
async function section(name, fn) {
  try { await fn(); } catch (e) {
    check(false, `${name}/threw`, `${e && e.constructor ? e.constructor.name : 'Error'}: ${e && e.message}`);
  }
}

const read = (rel) => (existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel), 'utf8') : '');
const README = read('README.md');
const MUSE = read('connectors/muse.md');
const SPEC_TOOLS = read('spec/tools-v1.md');
const CHANGELOG = read('CHANGELOG.md');
const PAGE_SRC = read('agent-entry-page.mjs');
const GRANDFATHERED = JSON.parse(read('conformance/fixtures/docs/pre-s4-example-urls.json'));

/** The released version: the version of the newest `## ` heading that ends in "(YYYY-MM-DD)"
 *  and does not say it is unreleased. Throws, naming the problem, when there is no dated
 *  heading or the newest one does not start with a version. */
function releasedVersionFrom(text) {
  const headings = String(text).split('\n').filter((l) => /^## /.test(l));
  const dated = headings.find((l) => /\(\d{4}-\d{2}-\d{2}\)\s*$/.test(l)
    && !/unreleased|not yet published/i.test(l));
  if (!dated) throw new Error('CHANGELOG.md has no dated section: no "## " heading ends in "(YYYY-MM-DD)"');
  const m = /^## (\d+\.\d+\.\d+)(?=\s)/.exec(dated);
  if (!m) throw new Error(`CHANGELOG.md's newest dated heading does not start with a version: ${JSON.stringify(dated)}`);
  return { version: m[1], heading: dated };
}

/** Equal versions only: two missing versions are never the same release. */
const sameVersion = (a, b) => typeof a === 'string' && a.length > 0 && a === b;

let RELEASED = null;
let releasedError = '';
try { RELEASED = releasedVersionFrom(CHANGELOG); } catch (e) { releasedError = e.message; }
const RELEASED_VERSION = RELEASED ? RELEASED.version : undefined;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const code = (name) => `\`${name}\``;

/** The markdown section whose heading line starts with `#{level} <title>`, up to the next
 *  heading of the same or a higher level. Headings inside fenced code are not headings. */
function mdSection(text, level, title) {
  const lines = text.split('\n');
  let inFence = false;
  let start = -1;
  let end = lines.length;
  const hashes = '#'.repeat(level);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = /^(#{1,6}) /.exec(line);
    if (!m) continue;
    if (start < 0) {
      if (line.startsWith(`${hashes} ${title}`)) start = i;
    } else if (m[1].length <= level) { end = i; break; }
  }
  return start < 0 ? null : lines.slice(start, end).join('\n');
}

/** Every URL inside fenced code blocks and inline code spans: the examples. Links in prose
 *  point at real documents and are not examples. Trailing punctuation is not part of a URL. */
function exampleUrls(text) {
  const blocks = [];
  for (const m of text.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)) blocks.push(m[1]);
  const prose = text.replace(/^```[^\n]*\n[\s\S]*?^```/gm, '');
  for (const m of prose.matchAll(/`([^`\n]+)`/g)) blocks.push(m[1]);
  const urls = [];
  for (const block of blocks) {
    for (const m of block.matchAll(/\bhttps?:\/\/[^\s'"`<>)]+/g)) urls.push(m[0].replace(/[;,.:]+$/, ''));
  }
  return urls;
}

/** A placeholder host (RFC 2606 / RFC 5737), as the brief lists them: example.com (and names
 *  under it), *.test, *.invalid, and the 192.0.2.0/24 documentation block. Nothing else —
 *  not a real domain, not loopback, not a neighbouring block. */
function isPlaceholderHost(host) {
  const h = String(host).toLowerCase().replace(/\.$/, '');
  if (h === 'example.com' || h.endsWith('.example.com')) return true;
  if (/^(?:[a-z0-9-]+\.)+(?:test|invalid)$/.test(h)) return true;
  const v4 = /^192\.0\.2\.(\d{1,3})$/.exec(h);
  return Boolean(v4 && Number(v4[1]) <= 255);
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^\[|\]$/g, ''); } catch { return null; }
}

/** The example URLs in `text` that are neither grandfathered nor on a placeholder host. */
function offendingUrls(text, grandfathered) {
  const allowed = new Set(grandfathered || []);
  return exampleUrls(text).filter((u) => !allowed.has(u) && !isPlaceholderHost(hostOf(u)));
}

/** Rows of the first pipe table in `text` whose header names a verb, a default and an example
 *  column: [{verb, dflt, example}] with the cell text as written. */
function verbTable(text) {
  const lines = text.split('\n');
  for (let i = 0; i + 1 < lines.length; i += 1) {
    if (!/^\s*\|/.test(lines[i]) || !/^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) continue;
    const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    const head = cells(lines[i]).map((c) => c.toLowerCase());
    const v = head.findIndex((c) => /verb/.test(c));
    const d = head.findIndex((c) => /default|effect/.test(c));
    const x = head.findIndex((c) => /example/.test(c));
    if (v < 0 || d < 0 || x < 0) continue;
    const rows = [];
    for (let j = i + 2; j < lines.length && /^\s*\|/.test(lines[j]); j += 1) {
      const c = cells(lines[j]);
      rows.push({ verb: c[v] || '', dflt: c[d] || '', example: c[x] || '' });
    }
    return rows;
  }
  return null;
}

/** The verbs of `verbs` that `rows` does not give a row with the verb, its default and an
 *  example. */
function verbRowsMissing(rows, verbs, effects) {
  return verbs.filter((verb) => !(rows || []).some((r) => r.verb.includes(code(verb))
    && new RegExp(`\\b${escapeRe(effects[verb])}\\b`).test(r.dflt)
    && r.example.replace(/[`*_"'\s—–-]/g, '').length > 0));
}

/** A paragraph that tells the connector to ask the card which verbs the shop offers. */
function asksCardForVerbs(text) {
  return text.split(/\n\s*\n/).some((p) => /\bskills\b/.test(p) && /\bverbs?\b/i.test(p)
    && /\boffers?\b/i.test(p) && /\bcard\b/i.test(p) && /\bask\b/i.test(p));
}

// ---------------------------------------------------------------- what the code says

const VERBS = Array.isArray(door.VERBS) ? [...door.VERBS] : [];
const EFFECTS = door.VERB_EFFECTS && typeof door.VERB_EFFECTS === 'object' ? door.VERB_EFFECTS : {};

/** The events the page runtime emits, read from its source: `.emit('<name>'`. */
const PAGE_EVENTS = [...new Set([...PAGE_SRC.matchAll(/\.emit\(\s*['"]([a-z_]+)['"]/g)].map((m) => m[1]))];
const EVENTS = [...new Set([...(Array.isArray(door.COLLECTOR_EVENTS) ? door.COLLECTOR_EVENTS : []), ...PAGE_EVENTS])];

/** The CLI's commands, from the usage line it prints when run with none. */
function cliCommands() {
  const run = spawnSync(process.execPath, [join(ROOT, 'muretai-agent-entry.mjs')], {
    cwd: ROOT, encoding: 'utf8', timeout: 15000, env: { ...process.env, HOME: join(ROOT, '.no-home') },
  });
  const m = /agent-entry <([a-z|-]+)>/.exec(`${run.stderr}\n${run.stdout}`);
  return m ? m[1].split('|') : [];
}
const COMMANDS = cliCommands();

await section('live-lists', async () => {
  check(VERBS.length > 0 && VERBS.every((v) => typeof EFFECTS[v] === 'string'), 'live-lists/VERBS-and-VERB_EFFECTS',
    `VERBS=${JSON.stringify(VERBS)}`);
  check(EVENTS.length > 0, 'live-lists/COLLECTOR_EVENTS', 'no event names read from the module or the page runtime');
  check(PAGE_EVENTS.length > 0 && PAGE_EVENTS.every((e) => (door.COLLECTOR_EVENTS || []).includes(e)),
    'live-lists/page-events-are-collector-events', `page emits ${JSON.stringify(PAGE_EVENTS)}`);
  check(COMMANDS.length > 0 && COMMANDS.includes('init') && COMMANDS.includes('knock'), 'live-lists/cli-usage-line',
    `commands read from the CLI: ${JSON.stringify(COMMANDS)}`);
});

// ---------------------------------------------------------------- 1. the verbs

await section('verbs', async () => {
  for (const verb of VERBS) {
    check(README.includes(code(verb)), `verbs/readme-names/${verb}`, '');
    check(SPEC_TOOLS.includes(code(verb)), `verbs/spec-tools-v1-names/${verb}`, '');
  }
  const can = mdSection(README, 2, 'What a customer can do here');
  check(can !== null, 'verbs/readme-has-What-a-customer-can-do-here', 'a "## What a customer can do here" section');
  const rows = can === null ? null : verbTable(can);
  check(rows !== null, 'verbs/section-has-a-verb-default-example-table',
    'a table whose header has a verb column, a default (or effect) column and an example column');
  for (const verb of verbRowsMissing(rows, VERBS, EFFECTS)) {
    check(false, `verbs/row/${verb}`, `no row with ${code(verb)}, its default "${EFFECTS[verb]}" and an example`);
  }
  if (rows) {
    const extra = rows.map((r) => (/`([a-z_]+)`/.exec(r.verb) || [])[1]).filter((v) => v && !VERBS.includes(v));
    check(extra.length === 0, 'verbs/section-names-no-verb-the-registry-lacks', extra.join(', '));
  }
  check(/\(#what-a-customer-can-do-here\)/.test(README), 'verbs/contents-links-the-section', '');

  // The row check discriminates: a row without an example, or with the wrong default, is a miss.
  const probe = '| verb | default | example |\n|---|---|---|\n| `find` | none | "Do you have size 42?" |\n'
    + '| `buy` | changes | "Buy it" |\n| `ask` | none | |\n';
  const missed = verbRowsMissing(verbTable(probe), ['find', 'buy', 'ask', 'join'],
    { find: 'none', buy: 'pays', ask: 'none', join: 'changes' });
  check(JSON.stringify(missed) === JSON.stringify(['buy', 'ask', 'join']), 'verbs/refusal/row-check-discriminates',
    `missed ${JSON.stringify(missed)}`);
});

// ---------------------------------------------------------------- 2. the events

await section('events', async () => {
  for (const name of EVENTS) check(README.includes(code(name)), `events/readme-names/${name}`, '');
});

// ---------------------------------------------------------------- 3. the CLI

await section('cli', async () => {
  for (const cmd of COMMANDS) {
    check(new RegExp(`agent-entry(?:\\.mjs)? ${escapeRe(cmd)}\\b`).test(README),
      `cli/readme-shows-agent-entry-${cmd}`, `README.md never shows "agent-entry ${cmd}"`);
  }
});

// ---------------------------------------------------------------- 4. put it on a site

await section('put-it-on-a-site', async () => {
  const site = mdSection(README, 2, 'Put it on a site');
  check(site !== null, 'put-it-on-a-site/section-exists', '');
  const s = site || '';
  const npx = s.indexOf('npx @muretai/agent-entry init');
  const curl = s.indexOf('curl -O https://raw.githubusercontent.com/muretai/agent-entry/main/muretai-agent-entry.mjs');
  check(npx >= 0, 'put-it-on-a-site/npx-init-is-a-way', 'no "npx @muretai/agent-entry init" in the section');
  check(curl >= 0, 'put-it-on-a-site/curl-copy-is-still-a-way', 'the curl -O copy of the one file was removed');
  check(npx >= 0 && curl >= 0 && npx < curl, 'put-it-on-a-site/npx-init-comes-first',
    `npx at ${npx}, curl at ${curl}`);
  check(/Or copy the file/.test(s) || /copy/i.test(s.slice(Math.max(npx, 0))), 'put-it-on-a-site/copy-is-named-as-the-second-way', '');
});

// ---------------------------------------------------------------- 5. counting visits

await section('counting', async () => {
  const counting = mdSection(README, 3, 'Counting visits') ?? mdSection(README, 2, 'Counting visits');
  check(counting !== null, 'counting/section-exists', '');
  const s = counting || '';
  check(s.includes(code('gaSink')), 'counting/names-gaSink', '');
  check(/\bcollector\b/i.test(s), 'counting/names-the-collector', '');
  check(/agent-entry counts\b/.test(s) || s.includes(code('counts')), 'counting/names-counts', '');
  check(s.includes('entry.counts'), 'counting/names-entry.counts', '');
});

// ---------------------------------------------------------------- 6. pairs with WebMCP

await section('webmcp', async () => {
  const pairs = mdSection(README, 2, 'Pairs with WebMCP');
  check(pairs !== null, 'webmcp/section-exists', '');
  const s = pairs || '';
  check(typeof door.TOOLS_PATH === 'string' && s.includes(door.TOOLS_PATH), 'webmcp/names-the-contract-path',
    `TOOLS_PATH=${door.TOOLS_PATH}`);
  check(typeof door.TOOLS_SIG_PATH === 'string' && s.includes(door.TOOLS_SIG_PATH), 'webmcp/names-the-signed-envelope-path',
    `TOOLS_SIG_PATH=${door.TOOLS_SIG_PATH}`);
  check(s.includes('agenttools'), 'webmcp/names-the-agenttools-envelope', '');
  check(s.includes('agent-entry-page.mjs'), 'webmcp/names-the-page-runtime', '');
});

// ---------------------------------------------------------------- 7. connectors/muse.md

await section('muse', async () => {
  check(MUSE.length > 0, 'muse/connectors-muse-md-exists', '');
  check(asksCardForVerbs(MUSE), 'muse/asks-the-card-which-verbs-it-offers',
    'one paragraph must say to ask the shop\'s card which verbs it offers (its `skills`, one per offer)');
  check(MUSE.includes('skills[]'), 'muse/names-skills[]', '');
  check(!asksCardForVerbs('Knock on the card with one command.\n\nThe shop answers.'),
    'muse/refusal/passage-check-discriminates', '');
});

// ---------------------------------------------------------------- 8. placeholder hosts

await section('hosts', async () => {
  const targets = [
    ['README.md#Put it on a site', mdSection(README, 2, 'Put it on a site')],
    ['README.md#What a customer can do here', mdSection(README, 2, 'What a customer can do here')],
    ['README.md#Pairs with WebMCP', mdSection(README, 2, 'Pairs with WebMCP')],
    ['README.md#Counting visits', mdSection(README, 3, 'Counting visits')],
    ['connectors/muse.md', MUSE],
  ];
  for (const [key, text] of targets) {
    if (text === null) continue;   // a missing section is already a red row above
    const bad = offendingUrls(text, GRANDFATHERED[key]);
    check(bad.length === 0, `hosts/${key}/examples-use-placeholder-hosts`, bad.join(', '));
  }

  // The predicate itself.
  for (const h of ['example.com', 'shop.example.com', 'shop.test', 'door.invalid', '192.0.2.1', '192.0.2.255']) {
    check(isPlaceholderHost(h), `hosts/placeholder/${h}`, '');
  }
  for (const h of ['muretai.com', 'example.co', 'example.com.evil.net', 'test', 'test.com', 'invalid.org',
    '192.0.3.1', '192.0.2.256', '198.51.100.1', '127.0.0.1', 'localhost', 'shop.acme-foods.com']) {
    check(!isPlaceholderHost(h), `hosts/refusal/not-a-placeholder/${h}`, '');
  }

  // A new section with a real host is flagged; the same section on a placeholder host is not;
  // grandfathering one URL does not let a new one through on the same real host.
  const real = '## What a customer can do here\n\n```bash\ncurl https://shop.acme-foods.com/.well-known/agent-tools.json\n```\n'
    + 'Or `https://www.acme-foods.com/buy`.\n';
  check(JSON.stringify(offendingUrls(real, [])) === JSON.stringify([
    'https://shop.acme-foods.com/.well-known/agent-tools.json', 'https://www.acme-foods.com/buy']),
  'hosts/refusal/real-host-in-a-new-section-is-flagged', JSON.stringify(offendingUrls(real, [])));
  const fine = real.replace(/shop\.acme-foods\.com/g, 'shop.example.com').replace(/www\.acme-foods\.com/g, '192.0.2.10');
  check(offendingUrls(fine, []).length === 0, 'hosts/control/placeholder-hosts-pass', JSON.stringify(offendingUrls(fine, [])));
  check(offendingUrls('`https://muretai.com/new-example`', ['https://muretai.com/.well-known/agent-card.json']).length === 1,
    'hosts/refusal/grandfathering-is-per-url-not-per-host', '');
  check(offendingUrls('```js\nfetch("https://studio.example/new");\n```\n', GRANDFATHERED['README.md#Put it on a site']).length === 1,
    'hosts/refusal/a-new-url-on-an-old-non-placeholder-host-is-flagged', '');
});

// ---------------------------------------------------------------- 9. no release

await section('no-release', async () => {
  const raw = read('package.json');
  const pkg = JSON.parse(raw);
  check(RELEASED !== null, 'release/changelog-names-a-released-version', releasedError);
  check(sameVersion(pkg.version, RELEASED_VERSION), 'release/package-version-is-the-released-version',
    `package.json version is ${JSON.stringify(pkg.version)}, expected ${JSON.stringify(RELEASED_VERSION)} — the newest dated CHANGELOG section`);
  const lines = raw.split('\n').filter((l) => /^\s*"version"\s*:/.test(l));
  check(lines.length === 1 && lines[0] === `  "version": "${RELEASED_VERSION}",`, 'no-release/version-line-byte-identical',
    JSON.stringify(lines));
});

// ---------------------------------------------------------------- 10. the CHANGELOG record

await section('changelog', async () => {
  const headings = CHANGELOG.split('\n').filter((l) => /^## /.test(l));
  const v = RELEASED_VERSION || '';
  const hRel = v ? headings.filter((l) => l.startsWith(`## ${v} `)) : [];
  check(hRel.length === 1, 'changelog/one-released-version-section', `${JSON.stringify(v)}: ${JSON.stringify(hRel)}`);
  check(hRel.length === 1 && /\(20\d\d-\d\d-\d\d\)/.test(hRel[0])
    && !/unreleased/i.test(hRel[0]), 'changelog/released-version-is-released-and-dated', hRel[0] || '');
  const h113 = headings.filter((l) => /^## 1\.13\.0\b/.test(l));
  check(h113.length === 1, 'changelog/one-1.13.0-section', JSON.stringify(h113));
  const rec = mdSection(CHANGELOG, 2, '1.13.0') || '';
  const sub = rec.split('\n').filter((l) => /^### /.test(l));
  check(sub.some((l) => /^### Suite S4\b/.test(l)), 'changelog/1.13.0-has-a-Suite-S4-heading',
    `sub-headings: ${JSON.stringify(sub)}`);
  for (const n of ['S2', 'S3']) {
    check(sub.some((l) => new RegExp(`^### Suite ${n}\\b`).test(l)), `changelog/1.13.0-keeps-Suite-${n}`, '');
  }
  // The next version: above the newest dated section below it, its section records the breaking
  // CLI change, and once its heading is dated it is the version package.json carries.
  const top = headings[0] || '';
  let below = null;
  try { below = releasedVersionFrom(headings.slice(1).join('\n')); } catch { below = null; }
  const topVersion = (/^## (\d+\.\d+\.\d+)(?=\s)/.exec(top) || [])[1];
  const above = (a, b) => {
    const [x, y] = [a, b].map((s) => s.split('.').map(Number));
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
    return false;
  };
  const topRec = topVersion ? mdSection(CHANGELOG, 2, topVersion) || '' : '';
  const topDated = /\(\d{4}-\d{2}-\d{2}\)\s*$/.test(top);
  check(topVersion !== undefined && below !== null && above(topVersion, below.version)
    && /breaking CLI change/i.test(topRec)
    && (!topDated || sameVersion(JSON.parse(read('package.json')).version, topVersion)),
    'changelog/next-version-records-the-breaking-cli-change', `${top} / below it ${below && below.version}`);
  check(hRel.length === 1 && headings.indexOf(hRel[0]) === 1, 'changelog/released-version-follows-the-next-version',
    JSON.stringify(headings.slice(0, 2)));
  check(!/\(\d{4}-\d{2}-\d{2}\)\s*$/.test(headings[0] || '') && RELEASED !== null && RELEASED.heading !== headings[0],
    'changelog/undated-next-version-is-not-the-released-one', `${headings[0]} / ${RELEASED && RELEASED.heading}`);
});

// ---------------------------------------------------------------- 11. the released-version reader

await section('released-version-reader', async () => {
  const refuses = (text, re) => {
    try { releasedVersionFrom(text); return false; } catch (e) { return re.test(e.message); }
  };
  const DATED = '## 1.2.3 — a release (2026-01-02)\n\nBody.\n';
  check(releasedVersionFrom(DATED).version === '1.2.3', 'reader/control/dated-heading-gives-its-version',
    JSON.stringify(releasedVersionFrom(DATED)));
  const undatedAbove = '# Changelog\n\n## 9.0.0 — breaking (not yet published)\n\nX.\n\n' + DATED
    + '\n## 1.0.0 — older (2025-01-01)\n';
  check(releasedVersionFrom(undatedAbove).version === '1.2.3', 'reader/undated-heading-above-a-dated-one-is-skipped',
    JSON.stringify(releasedVersionFrom(undatedAbove)));
  check(releasedVersionFrom('## 2.0.0 — soon (unreleased, 2026-03-01)\n' + DATED).version === '1.2.3',
    'reader/a-date-inside-an-unreleased-heading-is-not-a-release', '');
  check(releasedVersionFrom('## 1.12.0 — v2 (landed 2026-09-19, not yet published)\n' + DATED).version === '1.2.3',
    'reader/landed-but-not-published-is-not-a-release', '');
  check(refuses('# Changelog\n\n## 9.0.0 — breaking (not yet published)\n\nX.\n', /no dated section/),
    'reader/refusal/no-dated-section-throws', '');
  check(refuses('', /no dated section/), 'reader/refusal/empty-changelog-throws', '');
  check(refuses('## Next big thing (2026-01-02)\n' + DATED, /does not start with a version/),
    'reader/refusal/unparseable-newest-dated-heading-throws', '');
  check(refuses('## v1.2 — short (2026-01-02)\n', /does not start with a version/),
    'reader/refusal/partial-version-throws', '');
  check(!sameVersion(undefined, undefined), 'reader/refusal/undefined-is-never-equal-to-undefined', '');
  check(!sameVersion('', ''), 'reader/refusal/empty-is-never-a-version', '');
  check(!sameVersion(null, null), 'reader/refusal/null-is-never-a-version', '');
  check(!sameVersion('1.13.1', undefined) && !sameVersion(undefined, '1.13.1'),
    'reader/refusal/a-missing-side-is-never-equal', '');
  check(sameVersion('1.13.1', '1.13.1') && !sameVersion('1.13.1', '1.13.0'), 'reader/control/equal-and-unequal', '');
});

// ---------------------------------------------------------------- 12. hosted counts (S6a-4)
//
// Agent Entry S6a-4 (split 4 of 4 of intake 20261002T130609Z, intake 20261002T215209Z, after
// S6a-3 20261002T215208Z), WRITTEN BEFORE THE DOCS. What landed: the door posts the AT-14 body
// to `entry.counts` (at most 2048 bytes, offer ids trunk refuses dropped, S6a-2), the page
// runtime posts the same body, and the door publishes the counts URL on the card (S6a-3). The
// README's "Counting visits" says so and no longer says it is planned; the newest, unpublished
// CHANGELOG section records it, with no release heading and no version bump. Loose phrases,
// never sentences.

/** The paragraphs of `text` that name the counts field (`entry.counts` or `agentEntry.counts`). */
const countsParas = (text) => String(text).split(/\n\s*\n/)
  .filter((p) => /\b(?:entry|agentEntry)\.counts\b/.test(p));

/** What a passage on hosted counts must say: each key phrase, case-insensitive. */
const HOSTED_PHRASES = {
  'hosted': (t) => /\bhosted\b/i.test(t),
  'door-posts': (t) => /\bdoor\b/i.test(t) && /\bpost(?:s|ed|ing)?\b/i.test(t),
  'page-runtime-posts': (t) => /\bpage runtime\b|agent-entry-page/i.test(t),
  '2048-byte-cap': (t) => /\b2048\b|\b2\s?KB\b|\b2\s?KiB\b/i.test(t),
  'trunk-refused-ids-dropped': (t) => /\btrunk\b/i.test(t)
    && /\b(?:drop(?:s|ped)?|omit(?:s|ted)?|left out|skip(?:s|ped)?)\b/i.test(t),
  'counts-url-on-card-or-contract': (t) => /\b(?:card|contract)\b/i.test(t)
    && (/agentEntry\.counts/.test(t) || /\b(?:publish(?:es|ed)?|names?|carries)\b/i.test(t)),
};
const hostedMissing = (t) => Object.keys(HOSTED_PHRASES).filter((k) => !HOSTED_PHRASES[k](t));

await section('hosted-counts', async () => {
  const counting = mdSection(README, 3, 'Counting visits') ?? mdSection(README, 2, 'Counting visits') ?? '';
  const paras = countsParas(counting).join('\n\n');
  check(paras.length > 0, 'hosted-counts/readme/counting-names-entry.counts', '');
  for (const k of hostedMissing(paras)) {
    check(false, `hosted-counts/readme/${k}`, 'the "Counting visits" paragraphs naming entry.counts do not say it');
  }

  // Refusals: what was planned is now shipped, and the README says so nowhere else.
  check(!/planned,?\s+not\s+shipped/i.test(README), 'hosted-counts/refusal/readme-no-longer-says-planned-not-shipped', '');
  check(!/not\s+yet\s+accepted/i.test(counting), 'hosted-counts/refusal/readme-no-longer-says-entry.counts-not-yet-accepted', '');
  check(!/until\s+it\s+ships/i.test(counting), 'hosted-counts/refusal/readme-no-longer-says-until-it-ships', '');
  check(!/\bwould\s+send\b/i.test(paras), 'hosted-counts/refusal/readme-no-longer-in-the-conditional', '');

  // The CHANGELOG: an unpublished newest section still passes. A dated newest section
  // passes only for 2.0.0, and only when that section records hosted counts.
  const headings = CHANGELOG.split('\n').filter((l) => /^## /.test(l));
  const top = headings[0] || '';
  const undated = (l) => !/\(\d{4}-\d{2}-\d{2}\)\s*$/.test(l);
  const rec = (top && mdSection(CHANGELOG, 2, top.slice(3))) || '';
  const newestOk = (heading, section) => (undated(heading)
    ? /not yet published|unreleased/i.test(heading)
    : /^## 2\.0\.0(?=\s)/.test(heading) && /\bhosted counts\b/i.test(section));
  check(newestOk(top, rec)
    && newestOk('## 2.0.0 -- next (unreleased)', '')
    && newestOk('## 2.0.0 -- hosted counts (2026-10-18)', 'added: hosted counts')
    && !newestOk('## 2.0.0 -- other work (2026-10-18)', 'other work only')
    && !newestOk('## 2.1.0 -- hosted counts (2026-10-18)', 'hosted counts'),
    'hosted-counts/changelog/newest-section-is-unpublished', top);
  check(/\bhosted counts\b/i.test(rec), 'hosted-counts/changelog/names-hosted-counts', '');
  check(rec.includes('entry.counts'), 'hosted-counts/changelog/names-entry.counts', '');
  for (const k of hostedMissing(rec).filter((x) => x !== 'trunk-refused-ids-dropped')) {
    check(false, `hosted-counts/changelog/${k}`, `the newest CHANGELOG section (${top}) does not say it`);
  }

  // Refusals: no release heading, no second unpublished heading, no bump.
  const aboveReleased = RELEASED ? headings.slice(0, headings.indexOf(RELEASED.heading)) : headings;
  check(aboveReleased.length === 1 && undated(aboveReleased[0]), 'hosted-counts/refusal/changelog-adds-no-second-unpublished-heading',
    JSON.stringify(aboveReleased));
  check(RELEASED !== null && headings.indexOf(RELEASED.heading) === 1 && !/hosted counts/i.test(RELEASED.heading),
    'hosted-counts/refusal/changelog-adds-no-release-heading', RELEASED ? RELEASED.heading : releasedError);

  // The checks discriminate: the 1.13.0 paragraph is refused, a shipped one passes.
  const OLD = '**A hosted dashboard is planned, not shipped.** The planned field is `entry.counts` in\n'
    + '`agent-entry.json`: a URL for a Muretai-hosted counts endpoint. The page runtime and the door\n'
    + 'would send the same events there.';
  check(hostedMissing(OLD).length > 0 && /planned,?\s+not\s+shipped/i.test(OLD), 'hosted-counts/refusal/old-paragraph-is-refused',
    JSON.stringify(hostedMissing(OLD)));
  const NEW = 'Hosted counts: the door posts the AT-14 body to `entry.counts`, at most 2048 bytes, and drops\n'
    + 'an offer id trunk refuses. The page runtime posts the same body, and the card names the URL as\n'
    + '`agentEntry.counts`.';
  check(hostedMissing(NEW).length === 0, 'hosted-counts/control/shipped-paragraph-passes', JSON.stringify(hostedMissing(NEW)));
});

// ---------------------------------------------------------------- verdict

if (failures.length) {
  console.log(`\nFAILED — ${failures.length} of ${pass + failures.length} checks:\n`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  console.log('\nThe documents are read by people and agents deciding what this door does. A row above');
  console.log('is a place where they say less than the code, or something the code does not.\n');
  process.exit(1);
}
console.log(`OK — ${pass} checks: the README, the CHANGELOG record and the Muse page name what the code does.\n`);
