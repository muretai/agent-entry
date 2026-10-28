#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/*
 * conformance/ci-workflow.mjs - the required `test` check can run, and is locked down.
 *
 * A static check of .github/workflows/test.yml and of the CODEOWNERS file GitHub
 * honours. It never runs a workflow, never calls npm and never touches the network.
 * Every check is a function over text, so the synthetic cases below can show that
 * each one refuses a small bad workflow, not only that it accepts the real file.
 *
 * The workflow is read line by line, not with a YAML parser. Accepted shapes:
 *   - indentation by spaces only; one key per line;
 *   - unquoted keys (`on:`, `permissions:`, `uses:`, `run:`), with or without a
 *     leading `- ` list marker for `uses:` and `run:`;
 *   - a `#` comment at line start or after whitespace, outside a quoted value;
 *   - `on:` as a scalar (`on: pull_request`), a flow list (`on: [pull_request]`) or
 *     a block mapping / block list of event names; `"on":` and `'on':` too;
 *   - `permissions:` as a block mapping of `scope: value`, a flow mapping
 *     (`permissions: { contents: read }`) or a scalar (`read-all`, `write-all`);
 *   - `run:` as a single line, or a block scalar (`|`, `>`, with chomping or an
 *     indentation digit). Every line indented deeper than the `run` key that follows
 *     it belongs to that run, which also covers a plain scalar folded over lines.
 * Anything else (anchors, aliases, quoted keys other than "on", tabs) is not
 * understood and must not be used in this workflow.
 *
 * What is pinned:
 *   1. Install. package.json at this tree declares no dependencies, devDependencies
 *      or optionalDependencies, so no install step is needed: the workflow may run
 *      `npm test` (or plain `node conformance/...` steps) with no install at all.
 *      If it uses `npm ci` (or an alias: clean-install, ic, install-clean, cit,
 *      install-ci-test), or setup-node's `cache: npm`, a lockfile (package-lock.json
 *      or npm-shrinkwrap.json) must be TRACKED by git (`git ls-files`); present on
 *      disk but untracked is refused, because the CI checkout would not have it.
 *      If package.json ever gains dependencies, the workflow must install them
 *      with `npm ci` from a tracked lockfile. Some step must run the suite
 *      (`npm test`, `npm run test`, `npm t`, or `node conformance/<file>`).
 *   2. A top-level `permissions:` block with `contents: read`. Every other scope
 *      is `read` or `none`; `write`, `read-all` and `write-all` are refused, at the
 *      top level and in any job-level `permissions:` block too. A job-level block
 *      alone does not count.
 *   3. Every `uses:` is `owner/repo[/path]@<40 lowercase hex>`. A tag, a branch,
 *      a short sha, a missing ref, a local `./` action and a `docker://` image
 *      are refused. A trailing `# v4` comment is fine.
 *   4. The trigger includes `pull_request` and the text never names
 *      `pull_request_target`.
 *   5. No `${{` inside a run line (single-line run, block-scalar lines, comments in
 *      them included: Actions expands an expression before the shell sees it). An
 *      expression in `env:` or `with:` is allowed.
 *   6. CODEOWNERS: GitHub reads the first of .github/CODEOWNERS, CODEOWNERS,
 *      docs/CODEOWNERS that exists; that file must be tracked and hold at least one
 *      rule line (not blank, not a comment) with a path pattern and at least one
 *      owner starting with @. A pattern with no owner is refused, and so is an
 *      owner that is neither @user, @org/team nor an e-mail address.
 *
 * Outside a source checkout (the published package carries no .github/) the live
 * part is skipped; the synthetic cases still run.
 *
 * Run: node conformance/ci-workflow.mjs
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const WORKFLOW = '.github/workflows/test.yml';
const CODEOWNERS_PLACES = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];
const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json'];
const DEP_KEYS = ['dependencies', 'devDependencies', 'optionalDependencies'];

function lines(text) {
  return String(text).replace(/\r\n?/g, '\n').split('\n');
}

function indentOf(line) {
  return line.length - line.replace(/^ +/, '').length;
}

/** Drop a trailing `#` comment that is outside a quoted value. */
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    const prev = i === 0 ? ' ' : line[i - 1];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if ((c === '"' || c === "'") && /[\s[{,:]/.test(prev)) { quote = c; continue; }
    if (c === '#' && /\s/.test(prev)) return line.slice(0, i).replace(/\s+$/, '');
  }
  return line.replace(/\s+$/, '');
}

function unquote(value) {
  const v = String(value).trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) return v.slice(1, -1);
  return v;
}

function isNoise(line) {
  const t = line.trim();
  return t === '' || t.startsWith('#');
}

/** Children of the key on line i: the `key: value` lines at the first deeper indent. */
function childEntries(ls, i) {
  const parent = indentOf(ls[i]);
  const entries = [];
  let childIndent = -1;
  for (let j = i + 1; j < ls.length; j += 1) {
    if (isNoise(ls[j])) continue;
    const ind = indentOf(ls[j]);
    if (ind <= parent) break;
    if (childIndent < 0) childIndent = ind;
    if (ind !== childIndent) continue;
    const body = stripComment(ls[j]).trim();
    const item = /^-\s+(.*)$/.exec(body);
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(item ? item[1] : body);
    if (kv) entries.push({ key: kv[1], value: unquote(kv[2]), line: j + 1 });
    else if (item) entries.push({ key: unquote(item[1]), value: '', line: j + 1 });
  }
  return entries;
}

function flowItems(inner) {
  return inner.split(',').map((part) => part.trim()).filter(Boolean);
}

/** A key's value: { scalar } for an inline value, { entries } for a mapping or list. */
function valueAt(ls, i, rest) {
  const inline = stripComment(rest).trim();
  if (inline === '') return { entries: childEntries(ls, i) };
  if (inline.startsWith('{') && inline.endsWith('}')) {
    const entries = flowItems(inline.slice(1, -1)).map((pair) => {
      const kv = /^([^:]+?)\s*:\s*(.*)$/.exec(pair);
      return kv ? { key: unquote(kv[1]), value: unquote(kv[2]), line: i + 1 } : { key: unquote(pair), value: '', line: i + 1 };
    });
    return { entries };
  }
  if (inline.startsWith('[') && inline.endsWith(']')) {
    return { entries: flowItems(inline.slice(1, -1)).map((name) => ({ key: unquote(name), value: '', line: i + 1 })) };
  }
  return { scalar: unquote(inline) };
}

/** Every line that a `run:` key carries, raw (comments kept). */
export function runLines(text) {
  const ls = lines(text);
  const out = [];
  for (let i = 0; i < ls.length; i += 1) {
    const m = /^( *)(- +)?run:(.*)$/.exec(ls[i]);
    if (!m) continue;
    const keyCol = m[1].length + (m[2] ? m[2].length : 0);
    const head = stripComment(m[3]).trim();
    if (!/^[|>][-+0-9]*$/.test(head) && m[3].trim() !== '') out.push({ line: i + 1, text: m[3].trim() });
    for (let j = i + 1; j < ls.length; j += 1) {
      if (ls[j].trim() === '') continue;
      if (indentOf(ls[j]) <= keyCol) break;
      out.push({ line: j + 1, text: ls[j].trim() });
      i = j;
    }
  }
  return out;
}

function hasDependencies(pkg) {
  const p = pkg && typeof pkg === 'object' ? pkg : {};
  return DEP_KEYS.some((key) => p[key] && typeof p[key] === 'object' && Object.keys(p[key]).length > 0);
}

/**
 * 1. The install step.
 * @param {string} text the workflow
 * @param {{ pkg: object, tracked: string[], present: string[] }} tree
 *   tracked: lockfiles `git ls-files` lists; present: lockfiles on disk
 */
export function checkInstall(text, tree) {
  const errors = [];
  const tracked = (tree && tree.tracked) || [];
  const present = (tree && tree.present) || [];
  const lock = LOCKFILES.find((name) => tracked.includes(name));
  const untracked = LOCKFILES.filter((name) => present.includes(name) && !tracked.includes(name));
  const runs = runLines(text);
  const ci = runs.find((r) => /\bnpm\s+(ci|clean-install|ic|install-clean|cit|install-ci-test)\b/.test(r.text));
  const cache = lines(text).findIndex((l) => /^\s*cache\s*:\s*['"]?npm['"]?$/.test(stripComment(l)));
  const noLock = untracked.length
    ? `the lockfile ${untracked.join(', ')} exists but git does not track it`
    : 'the tree tracks no package-lock.json or npm-shrinkwrap.json';
  if (ci && !lock) errors.push(`line ${ci.line}: npm ci needs a tracked lockfile, and ${noLock}`);
  if (cache >= 0 && !lock) errors.push(`line ${cache + 1}: setup-node cache: npm needs a tracked lockfile, and ${noLock}`);
  if (hasDependencies(tree && tree.pkg) && !(ci && lock)) {
    errors.push('package.json declares dependencies: install them with npm ci from a tracked lockfile');
  }
  const test = runs.some((r) => /\bnpm\s+(test|t|run\s+test)\b|\bnode\s+conformance\//.test(r.text));
  if (!test) errors.push('no run step runs the suite (npm test, or node conformance/<file>)');
  return errors;
}

function permissionErrors(value, where, top) {
  const errors = [];
  if (value.scalar !== undefined) {
    errors.push(`${where}: permissions: ${value.scalar} is not a scope mapping with contents: read`);
    return errors;
  }
  const seen = new Map(value.entries.map((e) => [e.key, e.value]));
  for (const e of value.entries) {
    if (e.value !== 'read' && e.value !== 'none') errors.push(`${where} line ${e.line}: ${e.key}: ${e.value || '(empty)'} is broader than read`);
  }
  if (top && seen.get('contents') !== 'read') errors.push(`${where}: contents: read is missing`);
  return errors;
}

/** 2. A top-level permissions block with contents: read and nothing broader. */
export function checkPermissions(text) {
  const ls = lines(text);
  const errors = [];
  let top = false;
  for (let i = 0; i < ls.length; i += 1) {
    const m = /^( *)permissions\s*:(.*)$/.exec(stripComment(ls[i]));
    if (!m) continue;
    const atTop = m[1].length === 0;
    if (atTop) top = true;
    errors.push(...permissionErrors(valueAt(ls, i, m[2]), atTop ? 'top-level permissions' : `job permissions (line ${i + 1})`, atTop));
  }
  if (!top) errors.unshift('no top-level permissions: block (a job-level one alone does not count)');
  return errors;
}

/** 3. Every uses: names owner/repo[/path]@<40 hex>. */
export function checkUses(text) {
  const errors = [];
  lines(text).forEach((line, i) => {
    const m = /^ *(?:- +)?uses\s*:(.*)$/.exec(stripComment(line));
    if (!m) return;
    const ref = unquote(m[1]);
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\/[A-Za-z0-9_./-]+)?@[0-9a-f]{40}$/.test(ref)) {
      errors.push(`line ${i + 1}: uses: ${ref || '(empty)'} is not pinned to a 40-hex commit sha`);
    }
  });
  return errors;
}

/** The event names under the top-level on: key, or null when there is none. */
export function triggers(text) {
  const ls = lines(text);
  for (let i = 0; i < ls.length; i += 1) {
    const m = /^(?:on|"on"|'on')\s*:(.*)$/.exec(stripComment(ls[i]));
    if (!m) continue;
    const value = valueAt(ls, i, m[1]);
    return value.scalar !== undefined ? [value.scalar] : value.entries.map((e) => e.key);
  }
  return null;
}

/** 4. pull_request, never pull_request_target. */
export function checkTriggers(text) {
  const errors = [];
  const events = triggers(text);
  if (!events) errors.push('no top-level on: key');
  else if (!events.includes('pull_request')) errors.push(`the trigger (${events.join(', ') || 'none'}) has no pull_request`);
  lines(text).forEach((line, i) => {
    if (/\bpull_request_target\b/.test(stripComment(line))) errors.push(`line ${i + 1}: pull_request_target is refused`);
  });
  return errors;
}

/** 5. No ${{ ... }} expression in a run line. */
export function checkRunExpressions(text) {
  return runLines(text)
    .filter((r) => r.text.includes('${{'))
    .map((r) => `line ${r.line}: a \${{ }} expression inside run: (${r.text}); pass it through env: instead`);
}

/** 6. At least one rule line, and every rule line names an owner. */
export function checkCodeowners(text) {
  const errors = [];
  let rules = 0;
  lines(text).forEach((line, i) => {
    const body = line.replace(/(^|[^\\])#.*$/, '$1').trim();
    if (body === '') return;
    const [pattern, ...owners] = body.split(/\s+/);
    if (owners.length === 0) {
      errors.push(`line ${i + 1}: the pattern ${pattern} names no owner`);
      return;
    }
    const bad = owners.filter((o) => !/^@[A-Za-z0-9-]+(\/[A-Za-z0-9._-]+)?$/.test(o) && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(o));
    if (bad.length) errors.push(`line ${i + 1}: ${bad.join(' ')} is not an @user, @org/team or e-mail owner`);
    else if (owners.some((o) => o.startsWith('@'))) rules += 1;
  });
  if (rules === 0) errors.unshift('CODEOWNERS has no rule line with a pattern and an @owner');
  return errors;
}

export function checkWorkflow(text, tree) {
  return [
    ...checkInstall(text, tree),
    ...checkPermissions(text),
    ...checkUses(text),
    ...checkTriggers(text),
    ...checkRunExpressions(text),
  ];
}

// ---- synthetic cases -------------------------------------------------------

const SHA = 'b4ffde65f46336ab88eb53be808477a3936bae11';
const SHA2 = '60edb5dd545a775178f52524783378180af0d1f8';

function workflow({
  on = 'on:\n  pull_request:\n    branches: [main]\n  merge_group:\n    branches: [main]',
  permissions = 'permissions:\n  contents: read',
  checkout = `actions/checkout@${SHA} # v4`,
  setup = `actions/setup-node@${SHA2} # v4`,
  setupWith = '        with:\n          node-version: 22',
  steps = '      - run: npm test',
  job = '',
} = {}) {
  return [
    'name: test',
    '',
    on,
    '',
    permissions,
    '',
    'jobs:',
    '  test:',
    '    name: test',
    '    runs-on: ubuntu-latest',
    job,
    '    steps:',
    `      - uses: ${checkout}`,
    `      - uses: ${setup}`,
    setupWith,
    steps,
    '',
  ].filter((line) => line !== '').join('\n');
}

const NO_DEPS = { pkg: { name: 'x' }, tracked: [], present: [] };
const LOCKED = { pkg: { name: 'x' }, tracked: ['package-lock.json'], present: ['package-lock.json'] };
const UNTRACKED = { pkg: { name: 'x' }, tracked: [], present: ['package-lock.json'] };
const WITH_DEPS = { pkg: { name: 'x', devDependencies: { tap: '1.0.0' } }, tracked: [], present: [] };
const WITH_DEPS_LOCKED = { ...WITH_DEPS, tracked: ['package-lock.json'], present: ['package-lock.json'] };

const failures = [];
function accepts(label, errors) {
  if (errors.length) failures.push(`${label}: expected no refusal, got: ${errors.join('; ')}`);
}
function refuses(label, errors) {
  if (!errors.length) failures.push(`${label}: expected a refusal, got none`);
}

// the good shape, whole
accepts('functional/the good workflow passes every check', checkWorkflow(workflow(), NO_DEPS));

// 1. install
accepts('install/no dependencies: npm test with no install', checkInstall(workflow(), NO_DEPS));
accepts('install/no dependencies: plain node steps', checkInstall(workflow({ steps: '      - run: node conformance/run.mjs' }), NO_DEPS));
accepts('install/npm ci with a tracked lockfile', checkInstall(workflow({ steps: '      - run: npm ci\n      - run: npm test' }), LOCKED));
accepts('install/dependencies with npm ci and a tracked lockfile', checkInstall(workflow({ steps: '      - run: npm ci\n      - run: npm test' }), WITH_DEPS_LOCKED));
refuses('install/npm ci with no lockfile', checkInstall(workflow({ steps: '      - run: npm ci\n      - run: npm test' }), NO_DEPS));
refuses('install/npm ci with a lockfile that exists but is untracked', checkInstall(workflow({ steps: '      - run: npm ci\n      - run: npm test' }), UNTRACKED));
refuses('install/npm clean-install in a run block with no lockfile', checkInstall(workflow({ steps: '      - run: |\n          npm clean-install\n          npm test' }), NO_DEPS));
refuses('install/setup-node cache: npm with no lockfile', checkInstall(workflow({ setupWith: '        with:\n          node-version: 22\n          cache: npm' }), NO_DEPS));
refuses('install/dependencies with no install step', checkInstall(workflow(), WITH_DEPS));
refuses('install/dependencies with npm ci and no lockfile', checkInstall(workflow({ steps: '      - run: npm ci\n      - run: npm test' }), WITH_DEPS));
refuses('install/no step runs the suite', checkInstall(workflow({ steps: '      - run: echo hi' }), NO_DEPS));

// 2. permissions
accepts('permissions/contents: read', checkPermissions(workflow()));
accepts('permissions/flow mapping', checkPermissions(workflow({ permissions: 'permissions: { contents: read }' })));
accepts('permissions/an extra scope at read', checkPermissions(workflow({ permissions: 'permissions:\n  contents: read\n  pull-requests: read' })));
refuses('permissions/missing block', checkPermissions(workflow({ permissions: '' })));
refuses('permissions/job level only', checkPermissions(workflow({ permissions: '', job: '    permissions:\n      contents: read' })));
refuses('permissions/contents: write', checkPermissions(workflow({ permissions: 'permissions:\n  contents: write' })));
refuses('permissions/write-all', checkPermissions(workflow({ permissions: 'permissions: write-all' })));
refuses('permissions/read-all', checkPermissions(workflow({ permissions: 'permissions: read-all' })));
refuses('permissions/an extra scope granted write', checkPermissions(workflow({ permissions: 'permissions:\n  contents: read\n  id-token: write' })));
refuses('permissions/no contents scope', checkPermissions(workflow({ permissions: 'permissions:\n  actions: read' })));
refuses('permissions/empty mapping', checkPermissions(workflow({ permissions: 'permissions: {}' })));
refuses('permissions/a job widens to write', checkPermissions(workflow({ job: '    permissions:\n      contents: write' })));

// 3. uses pinned to a sha
accepts('uses/both pinned to 40 hex', checkUses(workflow()));
accepts('uses/quoted and pinned', checkUses(workflow({ checkout: `'actions/checkout@${SHA}'` })));
refuses('uses/a tag', checkUses(workflow({ checkout: 'actions/checkout@v4' })));
refuses('uses/a full version tag', checkUses(workflow({ setup: 'actions/setup-node@v4.0.2' })));
refuses('uses/a branch', checkUses(workflow({ checkout: 'actions/checkout@main' })));
refuses('uses/a short sha', checkUses(workflow({ checkout: 'actions/checkout@b4ffde6' })));
refuses('uses/a missing ref', checkUses(workflow({ checkout: 'actions/checkout' })));
refuses('uses/41 hex', checkUses(workflow({ checkout: `actions/checkout@${SHA}0` })));
refuses('uses/a local action', checkUses(workflow({ checkout: './.github/actions/setup' })));
refuses('uses/a docker image', checkUses(workflow({ checkout: 'docker://alpine:3' })));

// 4. triggers
accepts('trigger/block mapping with pull_request', checkTriggers(workflow()));
accepts('trigger/scalar pull_request', checkTriggers(workflow({ on: 'on: pull_request' })));
accepts('trigger/flow list', checkTriggers(workflow({ on: 'on: [pull_request, merge_group]' })));
refuses('trigger/pull_request_target', checkTriggers(workflow({ on: 'on:\n  pull_request_target:\n    branches: [main]' })));
refuses('trigger/pull_request_target alongside pull_request', checkTriggers(workflow({ on: 'on: [pull_request, pull_request_target]' })));
refuses('trigger/no pull_request', checkTriggers(workflow({ on: 'on:\n  push:\n    branches: [main]' })));
refuses('trigger/no on key', checkTriggers(workflow({ on: '' })));

// 5. expressions in run
accepts('expr/in env: and with: is allowed', checkRunExpressions(workflow({
  setupWith: '        with:\n          node-version: ${{ matrix.node }}',
  steps: '      - run: echo "$TITLE"\n        env:\n          TITLE: ${{ github.event.pull_request.title }}\n      - run: npm test',
})));
refuses('expr/single-line run', checkRunExpressions(workflow({ steps: '      - run: echo ${{ github.event.pull_request.title }}' })));
refuses('expr/inside a run: | block', checkRunExpressions(workflow({ steps: '      - run: |\n          npm test\n          echo "${{ github.head_ref }}"' })));
refuses('expr/inside a run: >- block', checkRunExpressions(workflow({ steps: '      - name: t\n        run: >-\n          echo\n          ${{ github.head_ref }}' })));

// 6. CODEOWNERS
accepts('codeowners/one rule', checkCodeowners('# owners\n* @muretai\n'));
accepts('codeowners/team and e-mail owners', checkCodeowners('/.github/ @muretai/maintainers owner@example.com\n'));
refuses('codeowners/empty file', checkCodeowners(''));
refuses('codeowners/comment-only file', checkCodeowners('# Code owners for Agent Entry.\n# No rules yet.\n'));
refuses('codeowners/a pattern with no owner', checkCodeowners('* @muretai\n/docs/\n'));
refuses('codeowners/only a pattern', checkCodeowners('/.github/\n'));
refuses('codeowners/an owner without @', checkCodeowners('* muretai\n'));

// ---- the live tree ---------------------------------------------------------

function gitTracked(paths) {
  try {
    const out = execFileSync('git', ['ls-files', '--', ...paths], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

const live = [];
if (!existsSync(join(ROOT, '.github'))) {
  console.log('skip: .github/workflows/test.yml is absent outside a source checkout (the published package carries no .github/)');
} else {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const tree = {
    pkg,
    tracked: gitTracked(LOCKFILES),
    present: LOCKFILES.filter((name) => existsSync(join(ROOT, name))),
  };
  if (!existsSync(join(ROOT, WORKFLOW))) live.push(`${WORKFLOW} is missing`);
  else {
    if (!gitTracked([WORKFLOW]).includes(WORKFLOW)) live.push(`${WORKFLOW} is not tracked by git`);
    for (const e of checkWorkflow(readFileSync(join(ROOT, WORKFLOW), 'utf8'), tree)) live.push(`${WORKFLOW}: ${e}`);
  }
  const owners = CODEOWNERS_PLACES.find((p) => existsSync(join(ROOT, p)));
  if (!owners) live.push(`no CODEOWNERS in ${CODEOWNERS_PLACES.join(', ')}`);
  else {
    if (!gitTracked([owners]).includes(owners)) live.push(`${owners} is not tracked by git`);
    for (const e of checkCodeowners(readFileSync(join(ROOT, owners), 'utf8'))) live.push(`${owners}: ${e}`);
  }
}

if (failures.length) {
  console.log(`synthetic failures (${failures.length}):`);
  for (const f of failures) console.log(`  ${f}`);
}
if (live.length) {
  console.log(`live tree failures (${live.length}):`);
  for (const f of live) console.log(`  ${f}`);
}
if (failures.length || live.length) process.exit(1);
console.log('ci workflow: installable, read-only, sha-pinned, pull_request only, no run expressions; CODEOWNERS has rules');
