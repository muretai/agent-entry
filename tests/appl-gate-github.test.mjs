#!/usr/bin/env node
// Intake 20261028T151339Z, the skeleton item split from parent intake 20261028T131235Z
// under relayed owner ruling 20261028T144142Z, released by the P0 ruling in intake
// 20261031T163052Z: flip the agent-entry landing gate to github.
//   appl.toml        at the repository root, carries exactly one gate key, gate = "github"
//   docs/LANDING.md  names the required check by the workflow's job name, and names no
//                    other required check
// The job name is read from .github/workflows/test.yml, never hard-coded. No TOML or YAML
// parser is installed (zero dependencies), so both are read with minimal line checks
// below. The checks are functions, exercised on the real files and on bad inputs.
// Out of scope: the publisher's publisher.json and branch protection (owner steps), the
// trunk publisher, and the appl hook that marks an intake landed.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const APPL_TOML = join(ROOT, 'appl.toml');
const WORKFLOW = join(ROOT, '.github', 'workflows', 'test.yml');
const LANDING = join(ROOT, 'docs', 'LANDING.md');

// Drop a `#` comment that is outside a quoted value.
function stripComment(line) {
  let quote = '';
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#') {
      return line.slice(0, i);
    }
  }
  return line;
}

function unquote(value) {
  const v = value.trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) {
    return { quoted: true, value: v.slice(1, -1) };
  }
  return { quoted: false, value: v };
}

// Every gate key in the TOML text, in any table: { table, value, quoted, line }.
// A dotted key (land.gate = ...) and a quoted key ("gate" = ...) count as gate keys too.
export function gateKeys(text) {
  const out = [];
  let table = '';
  String(text).split(/\r?\n/).forEach((raw, i) => {
    const line = stripComment(raw).trim();
    if (line === '') return;
    const header = line.match(/^\[\[?\s*([^\]]*?)\s*\]\]?$/);
    if (header) {
      table = header[1];
      return;
    }
    const kv = line.match(/^((?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*'))*)\s*=(.*)$/);
    if (!kv) return;
    const parts = kv[1].split('.').map((p) => unquote(p).value);
    if (parts[parts.length - 1] !== 'gate') return;
    const { quoted, value } = unquote(kv[2]);
    out.push({ table: [table, ...parts.slice(0, -1)].filter(Boolean).join('.'), value, quoted, line: i + 1 });
  });
  return out;
}

// Returns the list of problems; an empty list means appl.toml sets the github gate.
export function checkGate(text) {
  if (typeof text !== 'string') return ['appl.toml is missing'];
  if (text.trim() === '') return ['appl.toml is empty'];
  const keys = gateKeys(text);
  if (keys.length === 0) return ['appl.toml has no gate key'];
  const problems = [];
  if (keys.length > 1) {
    problems.push(`appl.toml has ${keys.length} gate keys (lines ${keys.map((k) => k.line).join(', ')}); exactly one is allowed`);
  }
  for (const k of keys) {
    if (!k.quoted) problems.push(`line ${k.line}: gate = ${k.value || '(empty)'} is not a quoted string`);
    else if (k.value !== 'github') problems.push(`line ${k.line}: gate = "${k.value}" is not "github"`);
  }
  return problems;
}

// The check name GitHub shows for each job under jobs: its name: when set, else its id.
export function jobNames(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((raw) => stripComment(raw).replace(/\s+$/, ''))
    .filter((l) => l.trim() !== '')
    .map((l) => ({ indent: l.length - l.trimStart().length, text: l.trim() }));
  const start = lines.findIndex((l) => l.indent === 0 && /^jobs\s*:\s*$/.test(l.text));
  if (start < 0) return [];
  const body = [];
  for (let j = start + 1; j < lines.length && lines[j].indent > 0; j += 1) body.push(lines[j]);
  if (body.length === 0) return [];
  const idIndent = Math.min(...body.map((l) => l.indent));
  const names = [];
  for (let i = 0; i < body.length; i += 1) {
    const id = body[i].indent === idIndent && body[i].text.match(/^["']?([A-Za-z0-9_-]+)["']?\s*:\s*$/);
    if (!id) continue;
    const job = [];
    for (let j = i + 1; j < body.length && body[j].indent > idIndent; j += 1) job.push(body[j]);
    const top = job.length ? Math.min(...job.map((l) => l.indent)) : 0;
    const name = job.find((l) => l.indent === top && /^name\s*:/.test(l.text));
    names.push(name ? unquote(name.text.replace(/^name\s*:/, '')).value : id[1]);
  }
  return names;
}

// Every check LANDING.md calls required: "required check `x`", "required status check
// `x`", and "`x` as a required (status) check".
export function requiredChecks(text) {
  const found = new Set();
  const s = String(text).replace(/\s+/g, ' ');
  for (const m of s.matchAll(/required (?:status )?checks? `([^`]+)`/gi)) found.add(m[1]);
  for (const m of s.matchAll(/`([^`]+)` as (?:a|the) required (?:status )?check/gi)) found.add(m[1]);
  return [...found];
}

// Returns the list of problems; an empty list means LANDING.md names the job's check only.
export function checkLandingCheck(text, jobName) {
  if (typeof text !== 'string' || text.trim() === '') return ['LANDING.md is empty'];
  if (!jobName) return ['the workflow names no job'];
  const named = requiredChecks(text);
  const problems = [];
  if (!named.includes(jobName)) problems.push(`LANDING.md does not name ${jobName} as the required check`);
  for (const other of named.filter((n) => n !== jobName)) {
    problems.push(`LANDING.md names the required check ${other}, not the workflow job ${jobName}`);
  }
  return problems;
}

const GOOD_TOML = '# APPL settings for agent-entry\n[land]\ngate = "github" # merged PRs land\n';

const GOOD_WORKFLOW = `name: test
on:
  pull_request:
    branches: [main]
jobs:
  test:
    name: test
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`;

const GOOD_LANDING = `# Landing
3. The pull request must pass the required check \`test\`. That check is the
   \`test\` job in \`.github/workflows/test.yml\`.
3. Turn on "Require status checks to pass before merging" and add \`test\` as a
   required status check.
`;

// --- the real files -------------------------------------------------------------

test('appl.toml exists at the repository root', () => {
  assert.ok(existsSync(APPL_TOML), 'appl.toml is missing');
});

test('appl.toml sets gate = "github", exactly once', () => {
  const text = existsSync(APPL_TOML) ? readFileSync(APPL_TOML, 'utf8') : undefined;
  assert.deepEqual(checkGate(text), []);
  assert.deepEqual(gateKeys(text).map((k) => k.value), ['github']);
});

test('the workflow names exactly one job, the required check', () => {
  assert.ok(existsSync(WORKFLOW), '.github/workflows/test.yml is missing');
  const names = jobNames(readFileSync(WORKFLOW, 'utf8'));
  assert.equal(names.length, 1, `jobs: ${names.join(', ')}`);
  assert.ok(names[0]);
});

test('docs/LANDING.md names the workflow job as the required check, and no other', () => {
  assert.ok(existsSync(LANDING), 'docs/LANDING.md is missing');
  const [job] = jobNames(readFileSync(WORKFLOW, 'utf8'));
  assert.deepEqual(checkLandingCheck(readFileSync(LANDING, 'utf8'), job), []);
});

// --- the checks accept good inputs -----------------------------------------------

test('the gate check accepts the github gate in any table or at top level', () => {
  assert.deepEqual(checkGate(GOOD_TOML), []);
  assert.deepEqual(checkGate('gate = "github"\n'), []);
  assert.deepEqual(checkGate("gate = 'github'\n"), []);
  assert.deepEqual(checkGate('pin = "0.1.7"\n\n[land]\n  gate   =   "github"\n'), []);
  assert.deepEqual(checkGate('land.gate = "github"\n'), []);
});

test('the gate check ignores comments and lookalike keys', () => {
  assert.deepEqual(checkGate('# gate = "lint"\ngate = "github"\n'), []);
  assert.deepEqual(checkGate('gate = "github"\ngate_note = "lint"\nnogate = "x"\n'), []);
  assert.deepEqual(checkGate('gate = "github"\nnote = "gate = lint # not a key"\n'), []);
});

test('the job name is the name: of the job, else its id', () => {
  assert.deepEqual(jobNames(GOOD_WORKFLOW), ['test']);
  assert.deepEqual(jobNames(GOOD_WORKFLOW.replace('    name: test\n', '').replace('  test:\n', '  unit:\n')), ['unit']);
  assert.deepEqual(jobNames(GOOD_WORKFLOW.replace('    name: test\n', "    name: 'ci tests' # shown\n")), ['ci tests']);
});

test('the landing check accepts a doc that names the job in both spellings', () => {
  assert.deepEqual(requiredChecks(GOOD_LANDING), ['test']);
  assert.deepEqual(checkLandingCheck(GOOD_LANDING, 'test'), []);
});

// --- refusals ---------------------------------------------------------------------

function refused(problems, pattern) {
  assert.ok(problems.some((p) => pattern.test(p)), `expected ${pattern}, got ${JSON.stringify(problems)}`);
}

test('a gate other than github is refused', () => {
  refused(checkGate('gate = "lint"\n'), /"lint" is not "github"/);
  refused(checkGate('[land]\ngate = "local"\n'), /not "github"/);
  refused(checkGate('gate = "GitHub"\n'), /not "github"/);
  refused(checkGate('gate = "github "\n'), /not "github"/);
  refused(checkGate('gate = "github-pr"\n'), /not "github"/);
});

test('an empty gate is refused', () => {
  refused(checkGate('gate = ""\n'), /not "github"/);
  refused(checkGate('gate =\n'), /not a quoted string/);
});

test('an unquoted or non-string gate is refused', () => {
  refused(checkGate('gate = github\n'), /not a quoted string/);
  refused(checkGate('gate = true\n'), /not a quoted string/);
  refused(checkGate('gate = ["github"]\n'), /not a quoted string/);
});

test('a missing gate key is refused', () => {
  refused(checkGate('pin = "0.1.7"\n[tests]\ncommand = "npm test"\n'), /no gate key/);
  refused(checkGate('# gate = "github"\npin = "0.1.7"\n'), /no gate key/);
  refused(checkGate('gate_mode = "github"\n'), /no gate key/);
});

test('a missing or empty appl.toml is refused', () => {
  refused(checkGate(undefined), /missing/);
  refused(checkGate(''), /empty/);
  refused(checkGate('\n# only a comment\n'), /no gate key/);
});

test('more than one gate key is refused, even when both say github', () => {
  refused(checkGate('gate = "github"\ngate = "github"\n'), /2 gate keys/);
  refused(checkGate('gate = "github"\n[land]\ngate = "lint"\n'), /2 gate keys/);
  refused(checkGate('[land]\ngate = "github"\n[other]\ngate = "github"\n'), /exactly one/);
  refused(checkGate('land.gate = "github"\n[land]\ngate = "github"\n'), /exactly one/);
});

test('a LANDING.md that names a different required check is refused', () => {
  refused(checkLandingCheck(GOOD_LANDING, 'unit'), /does not name unit/);
  refused(checkLandingCheck(GOOD_LANDING, 'unit'), /names the required check test, not the workflow job unit/);
  const drifted = GOOD_LANDING.replace('add `test` as', 'add `ci` as');
  refused(checkLandingCheck(drifted, 'test'), /required check ci, not the workflow job test/);
  const renamed = GOOD_LANDING.replace('required check `test`', 'required check `build`');
  refused(checkLandingCheck(renamed, 'test'), /required check build/);
});

test('a LANDING.md that names no required check is refused', () => {
  refused(checkLandingCheck('# Landing\nChanges land through pull requests.\n', 'test'), /does not name test/);
  refused(checkLandingCheck('', 'test'), /empty/);
  refused(checkLandingCheck(GOOD_LANDING, ''), /no job/);
});
