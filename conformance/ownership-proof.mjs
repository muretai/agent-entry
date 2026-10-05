#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/*
 * conformance/ownership-proof.mjs
 *
 * Ownership proof seam, written before the implementation. These checks are red
 * until the door grows the seam. Nothing here resolves a public name or dials
 * off this machine: every request is an HTTP client to 127.0.0.1, and every
 * command-line child is started under the loopback guard.
 *
 * createAgentEntry({ ownershipProof }) accepts either an object { path, body }
 * or a function. The function is called and returns that same { path, body }
 * shape; its arguments, and how many times it runs beyond at least once, are
 * not part of this pin. GET of that exact path returns the body unchanged,
 * with a text/plain content type. Any other path under /.well-known/ that this
 * seam does not own is 404, and the proof body is not the response. Omitting
 * ownershipProof serves no proof. A malformed value throws TypeError from
 * createAgentEntry and the message names ownershipProof, so a bad seam does
 * not start and does not silently answer as something else.
 *
 * The package bin drives the same object seam:
 *   serve --proof-path <path> --proof-body <body>
 * AGENT_ENTRY_SEED_HEX is the 64-hex seed slot. The process binds 127.0.0.1,
 * chooses an ephemeral port, and prints one stdout line http://127.0.0.1:<port>/.
 * A missing flag, an empty body, a path that is not an exact file under
 * /.well-known/, or --host outside loopback exits non-zero and prints no such line.
 *
 * This file does not remove or re-pin the built-in claim workflow, and it does
 * not touch frame step order.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { guardLog } from './fixtures/cli/loopback-only.mjs';
import {
  AGENT_CARD_PATH,
  createAgentEntry,
} from '../muretai-agent-entry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const BIN = join(ROOT, 'muretai-agent-entry.mjs');
const GUARD = join(HERE, 'fixtures', 'cli', 'loopback-only.mjs');
const SEED = 'ab'.repeat(32);
const BASE = 'http://127.0.0.1:9';

const PATH_A = '/.well-known/desk-proof.txt';
const BODY_A = 'desk-proof-4417';
const PATH_B = '/.well-known/second-proof.txt';
const BODY_B = 'second-proof-8821';
const PATH_FN = '/.well-known/function-proof.txt';
const PATH_CLI = '/.well-known/cli-proof.txt';
const BODY_CLI = 'cli-proof-3304';

let passed = 0;
const failures = [];

function check(ok, label, detail = '') {
  if (ok) { passed += 1; return true; }
  failures.push(`${label}${detail ? ` - ${String(detail).slice(0, 400)}` : ''}`);
  return false;
}

async function section(name, fn) {
  try { await fn(); } catch (error) { check(false, `${name}/threw`, error?.stack || String(error)); }
}

function door(ownershipProof) {
  const opts = {
    seedHex: SEED,
    name: 'ownership proof seam',
    baseUrl: BASE,
  };
  if (ownershipProof !== undefined) opts.ownershipProof = ownershipProof;
  return createAgentEntry(opts);
}

function bind(entry) {
  return new Promise((resolve, reject) => {
    const server = entry.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function get(port, path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1', port, path, method,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        type: String(res.headers['content-type'] || ''),
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.setTimeout(5000, () => { req.destroy(); reject(new Error(`timeout ${method} ${path}`)); });
    req.on('error', reject);
    req.end();
  });
}

function textPlain(type) {
  return type.toLowerCase().split(';', 1)[0].trim() === 'text/plain';
}

function otherPaths(path) {
  const file = path.slice('/.well-known/'.length);
  return [
    '/.well-known/not-the-proof.txt',
    `${path}x`,
    `${path}/`,
    `/.well-known/${file.toUpperCase()}`,
    '/.well-known/did-configuration.json',
    '/desk-proof.txt',
  ];
}

async function servesProof(label, entry, path, body) {
  const server = await bind(entry);
  try {
    const { port } = server.address();
    const got = await get(port, path);
    check(got.status === 200, `${label}/status-200`, `HTTP ${got.status}`);
    check(got.body === body, `${label}/body`, JSON.stringify(got.body));
    check(textPlain(got.type), `${label}/text-plain`, JSON.stringify(got.type));
    for (const other of otherPaths(path)) {
      const res = await get(port, other);
      check(res.status === 404, `${label}/other-404${other}`, `HTTP ${res.status}`);
      check(res.body !== body, `${label}/other-not-the-body${other}`, JSON.stringify(res.body).slice(0, 120));
    }
    const card = await get(port, AGENT_CARD_PATH);
    check(card.body !== body, `${label}/card-is-not-the-proof`, `HTTP ${card.status}`);
    const root = await get(port, '/');
    check(root.body !== body, `${label}/root-is-not-the-proof`, `HTTP ${root.status}`);
    const posted = await get(port, path, 'POST');
    check(!(posted.status === 200 && posted.body === body), `${label}/post-does-not-serve-the-proof`,
      `HTTP ${posted.status}`);
    return got;
  } finally {
    await close(server);
  }
}

function mustRefuse(label, ownershipProof) {
  let error = null;
  try { door(ownershipProof); } catch (e) { error = e; }
  check(error instanceof TypeError, `${label}/refused`, error ? `${error.name}: ${error.message}` : 'started');
  if (error) check(/ownershipProof/.test(String(error.message)), `${label}/names-the-seam`, error.message);
}

const BAD_OBJECTS = [
  ['null', null],
  ['number', 1],
  ['string', BODY_A],
  ['array', [PATH_A]],
  ['empty-object', {}],
  ['path-only', { path: PATH_A }],
  ['body-only', { body: BODY_A }],
  ['body-not-string', { path: PATH_A, body: 1 }],
  ['empty-body', { path: PATH_A, body: '' }],
  ['empty-path', { path: '', body: 'x' }],
  ['outside-prefix', { path: '/desk-proof.txt', body: 'x' }],
  ['prefix-only', { path: '/.well-known/', body: 'x' }],
  ['bare-prefix', { path: '/.well-known', body: 'x' }],
  ['dot-dot', { path: '/.well-known/../secret', body: 'x' }],
  ['query', { path: `${PATH_A}?x=1`, body: 'x' }],
  ['fragment', { path: `${PATH_A}#x`, body: 'x' }],
  ['backslash', { path: '/.well-known\\desk-proof.txt', body: 'x' }],
  ['double-slash', { path: '/.well-known//desk-proof.txt', body: 'x' }],
  ['trailing-slash', { path: `${PATH_A}/`, body: 'x' }],
  ['absolute-url', { path: `http://127.0.0.1${PATH_A}`, body: 'x' }],
  ['newline', { path: `${PATH_A}\n`, body: 'x' }],
  ['encoded-dot-dot', { path: '/.well-known/%2e%2e/secret', body: 'x' }],
  ['wrong-case-prefix', { path: '/.Well-known/desk-proof.txt', body: 'x' }],
];

await section('object', async () => {
  await servesProof('object/first-path', door({ path: PATH_A, body: BODY_A }), PATH_A, BODY_A);
  await servesProof('object/second-path', door({ path: PATH_B, body: BODY_B }), PATH_B, BODY_B);
});

await section('object-absent', async () => {
  const entry = door(undefined);
  const server = await bind(entry);
  try {
    const { port } = server.address();
    const missing = await get(port, PATH_A);
    check(missing.status === 404, 'object-absent/no-default-proof', `HTTP ${missing.status} ${missing.body.slice(0, 80)}`);
    check(missing.body !== BODY_A, 'object-absent/body-is-not-a-proof');
    const card = await get(port, AGENT_CARD_PATH);
    check(card.status === 200, 'object-absent/card-still-served', `HTTP ${card.status}`);
  } finally {
    await close(server);
  }
});

await section('object-refused', async () => {
  for (const [name, value] of BAD_OBJECTS) mustRefuse(`object/${name}`, value);
});

await section('function', async () => {
  const produced = [];
  let calls = 0;
  const ownershipProof = () => {
    calls += 1;
    const body = `function-proof-${calls}`;
    const spec = { path: PATH_FN, body };
    produced.push(spec);
    return spec;
  };
  const entry = door(ownershipProof);
  const server = await bind(entry);
  try {
    const { port } = server.address();
    const got = await get(port, PATH_FN);
    check(calls >= 1, 'function/invoked', `calls=${calls}`);
    check(produced.some((spec) => spec.body === got.body), 'function/body-is-the-result',
      `HTTP ${got.status} body ${JSON.stringify(got.body)} produced ${JSON.stringify(produced.map((s) => s.body))}`);
    check(got.status === 200, 'function/status-200', `HTTP ${got.status}`);
    check(textPlain(got.type), 'function/text-plain', JSON.stringify(got.type));
    for (const other of otherPaths(PATH_FN)) {
      const res = await get(port, other);
      check(res.status === 404, `function/other-404${other}`, `HTTP ${res.status}`);
      check(!produced.some((spec) => spec.body === res.body), `function/other-not-the-result${other}`);
    }
  } finally {
    await close(server);
  }
});

await section('function-refused', async () => {
  const bad = [
    ['returns-string', () => BODY_A],
    ['returns-null', () => null],
    ['returns-empty', () => ({})],
    ['returns-outside-prefix', () => ({ path: '/tmp/proof.txt', body: 'secret' })],
    ['returns-dot-dot', () => ({ path: '/.well-known/../secret', body: 'secret' })],
    ['returns-empty-body', () => ({ path: PATH_FN, body: '' })],
    ['throws', () => { throw new Error('seam failed'); }],
  ];
  for (const [name, fn] of bad) {
    let calls = 0;
    let error = null;
    try {
      door(() => { calls += 1; return fn(); });
    } catch (e) { error = e; }
    check(error instanceof TypeError, `function/${name}/refused`, error ? `${error.name}: ${error.message}` : 'started');
    check(calls >= 1, `function/${name}/invoked`, `calls=${calls}`);
    if (error) check(/ownershipProof/.test(String(error.message)), `function/${name}/names-the-seam`, error.message);
  }
});

function childEnv(log) {
  const env = {};
  for (const key of ['PATH', 'TMPDIR', 'LANG', 'SystemRoot']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.HOME = tmpdir();
  env.AGENT_ENTRY_SEED_HEX = SEED;
  env.AE_CLI_GUARD_LOG = log;
  return env;
}

function readGuard(log) {
  try {
    return readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/** Run `serve` until it prints a loopback URL, or until it exits, or until `timeout`. */
function runServe(args, timeout) {
  const dir = mkdtempSync(join(tmpdir(), 'ownership-proof-'));
  const log = join(dir, 'guard.jsonl');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', pathToFileURL(GUARD).href, BIN, 'serve', ...args], {
      cwd: dir,
      env: childEnv(log),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const url = stdout.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
      resolve({
        code: extra.code ?? null,
        signal: extra.signal ?? null,
        stdout,
        stderr,
        timedOut: Boolean(extra.timedOut),
        port: url ? Number(url[1]) : null,
        child: extra.child ?? null,
        guard: readGuard(log),
        dir,
      });
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ timedOut: true, child });
    }, timeout);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (stdout.match(/http:\/\/127\.0\.0\.1:(\d+)\//)) finish({ child });
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('close', (code, signal) => finish({ code, signal }));
  });
}

async function stopChild(run) {
  if (run.child && run.child.exitCode === null && run.child.signalCode === null) {
    run.child.kill('SIGKILL');
    await new Promise((resolve) => run.child.on('close', () => resolve()));
  }
  rmSync(run.dir, { recursive: true, force: true });
}

await section('cli', async () => {
  const run = await runServe(['--proof-path', PATH_CLI, '--proof-body', BODY_CLI], 8000);
  try {
    check(run.port !== null, 'cli/prints-loopback-url', `stdout ${JSON.stringify(run.stdout)} stderr ${JSON.stringify(run.stderr).slice(0, 200)}`);
    check(run.guard.some((row) => row.kind === 'loaded'), 'cli/guard-loaded');
    check(run.guard.every((row) => row.allowed !== false), 'cli/never-dials-out',
      JSON.stringify(run.guard.filter((row) => row.allowed === false).slice(0, 3)));
    if (run.port !== null) {
      const got = await get(run.port, PATH_CLI);
      check(got.status === 200, 'cli/status-200', `HTTP ${got.status}`);
      check(got.body === BODY_CLI, 'cli/body', JSON.stringify(got.body));
      check(textPlain(got.type), 'cli/text-plain', JSON.stringify(got.type));
      for (const other of otherPaths(PATH_CLI)) {
        const res = await get(run.port, other);
        check(res.status === 404, `cli/other-404${other}`, `HTTP ${res.status}`);
        check(res.body !== BODY_CLI, `cli/other-not-the-body${other}`);
      }
    }
  } finally {
    await stopChild(run);
  }
});

await section('cli-refused', async () => {
  const cases = [
    ['path-only', ['--proof-path', PATH_CLI]],
    ['body-only', ['--proof-body', BODY_CLI]],
    ['neither', []],
    ['empty-body', ['--proof-path', PATH_CLI, '--proof-body', '']],
    ['outside-prefix', ['--proof-path', '/desk-proof.txt', '--proof-body', BODY_CLI]],
    ['dot-dot', ['--proof-path', '/.well-known/../secret', '--proof-body', BODY_CLI]],
    ['public-host', ['--proof-path', PATH_CLI, '--proof-body', BODY_CLI, '--host', '0.0.0.0']],
  ];
  for (const [name, args] of cases) {
    const run = await runServe(args, 4000);
    try {
      check(run.port === null && run.code !== 0 && run.code !== null && !run.timedOut,
        `cli/${name}/refused`,
        `code=${run.code} timedOut=${run.timedOut} stdout=${JSON.stringify(run.stdout).slice(0, 160)} stderr=${JSON.stringify(run.stderr).slice(0, 160)}`);
      check(run.guard.every((row) => row.allowed !== false), `cli/${name}/never-dials-out`);
    } finally {
      await stopChild(run);
    }
  }
});

check(guardLog.every((row) => row.allowed !== false), 'runner/never-dials-out',
  JSON.stringify(guardLog.filter((row) => row.allowed === false).slice(0, 3)));

if (failures.length) {
  console.error(`FAILED - ${failures.length} ownership proof seam check(s), ${passed} passed:`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(`OK - ${passed} ownership proof seam checks`);
