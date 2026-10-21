#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/*
 * conformance/package-test-files.mjs - npm test must run from the published package.
 *
 * scripts.test names the conformance scripts. This module reads package.json and each
 * of those scripts' source and derives the repo-relative files they read. It does not
 * hardcode a pair of names. A read is:
 *   - readFileSync / readFile of a path built with join() from ROOT (the package root)
 *     or HERE (the script's directory), including bindings and a for-of over literal
 *     paths and join() calls;
 *   - a call to a one-argument helper whose body passes that argument to
 *     readFileSync(join(ROOT|HERE, argument)).
 * A URL basename in a fetch assertion (special-crawlers.json in the vendor-ranges
 * helper) is not a package-file read. Paths that are only known at run time are not
 * invented.
 *
 * Each derived file must be in the shipped listing, or the script must skip with a
 * clear message when the file is absent outside a source checkout. Either fix is
 * enough. The shipped listing is package.json "files" plus the files npm always
 * includes: package.json, a root README*, a root LICENSE / LICENCE / COPYING*, the
 * "main" file, and the "bin" files. CHANGELOG.md is not in that always-included set.
 * A "files" entry covers that exact path, and it covers a directory and everything
 * under it (trailing slash optional). No network and no npm pack.
 *
 * A skip is existsSync on that path or on a directory prefix of it, together with a
 * string literal that contains "skip:", names that same path or prefix, and says the
 * file is absent outside a checkout: one of "absent", "not a source checkout",
 * "outside a checkout", "published package". An existsSync that substitutes an empty
 * string and keeps going is not a skip.
 *
 * Refusal: a "files" entry of docs, docs/, or any path under docs/ fails the check
 * even when that entry would otherwise ship a read.
 *
 * Run: node conformance/package-test-files.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/**
 * Drop block comments and // comments. A quote inside a comment must not open a
 * string, and a // inside a block comment must not eat the next line of code.
 * Strings, including the // of a URL, are kept.
 */
function stripComments(source) {
  let out = '';
  let state = 'code';
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    const n = source[i + 1];
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c; }
      continue;
    }
    if (state === 'block') {
      if (c === '*' && n === '/') { state = 'code'; i += 1; continue; }
      if (c === '\n') out += '\n';
      continue;
    }
    if (state === 'sq' || state === 'dq' || state === 'tmpl') {
      out += c;
      if (c === '\\') { out += n || ''; i += 1; continue; }
      const end = state === 'sq' ? "'" : state === 'dq' ? '"' : '`';
      if (c === end) state = 'code';
      continue;
    }
    if (c === '/' && n === '/') { state = 'line'; continue; }
    if (c === '/' && n === '*') { state = 'block'; i += 1; continue; }
    if (c === "'") { state = 'sq'; out += c; continue; }
    if (c === '"') { state = 'dq'; out += c; continue; }
    if (c === '`') { state = 'tmpl'; out += c; continue; }
    out += c;
  }
  return out;
}

function splitArgs(inner) {
  const args = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < inner.length; i += 1) {
    const c = inner[i];
    if (quote) {
      if (c === '\\') { i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    else if (c === ',' && depth === 0) {
      args.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  const tail = inner.slice(start).trim();
  if (tail) args.push(tail);
  return args;
}

function parseExpr(text) {
  const s = String(text || '').trim();
  if (!s) return { kind: 'unknown' };
  if ((s[0] === "'" || s[0] === '"') && s[s.length - 1] === s[0] && s.length >= 2) {
    return { kind: 'lit', value: s.slice(1, -1) };
  }
  if (/^[A-Za-z_$][\w$]*$/.test(s)) return { kind: 'id', name: s };
  const joinAt = /^join\s*\(/.exec(s);
  if (joinAt && s.endsWith(')')) {
    const open = s.indexOf('(');
    return { kind: 'join', args: splitArgs(s.slice(open + 1, -1)).map(parseExpr) };
  }
  return { kind: 'unknown' };
}

function splitPath(value) {
  return String(value).split('/').filter((part) => part !== '' && part !== '.');
}

/** Append path segments. `..` that would leave the package root is a non-path. */
function applySegs(base, extra) {
  const out = base.slice();
  for (const part of extra) {
    if (part === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else {
      out.push(part);
    }
  }
  return out;
}

function evalExpr(expr, bindings) {
  if (!expr || expr.kind === 'unknown') return null;
  if (expr.kind === 'lit') return { rooted: false, items: [splitPath(expr.value)] };
  if (expr.kind === 'id') return bindings.has(expr.name) ? bindings.get(expr.name) : null;
  if (expr.kind !== 'join' || expr.args.length === 0) return null;
  let acc = null;
  for (const arg of expr.args) {
    const value = evalExpr(arg, bindings);
    if (!value) return null;
    if (!acc) {
      acc = { rooted: value.rooted, items: value.items.map((segs) => segs.slice()) };
      continue;
    }
    const next = [];
    for (const base of acc.items) {
      for (const extra of value.items) {
        const joined = applySegs(base, extra);
        if (joined === null) return null;
        next.push(joined);
      }
    }
    acc = { rooted: acc.rooted || value.rooted, items: next };
  }
  return acc;
}

function rootedPaths(value) {
  if (!value || !value.rooted) return [];
  const out = [];
  for (const segs of value.items) {
    if (segs.length === 0) continue;
    const file = segs.join('/');
    if (!file || file.startsWith('/') || file.includes('..') || file.includes('://') || file.startsWith('node:')) continue;
    out.push(file);
  }
  return out;
}

function firstArg(source, openParen) {
  let depth = 1;
  let quote = null;
  const start = openParen + 1;
  for (let i = start; i < source.length; i += 1) {
    const c = source[i];
    if (quote) {
      if (c === '\\') { i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i);
    } else if (c === ',' && depth === 1) return source.slice(start, i);
  }
  return null;
}

function untilSemicolon(source, start) {
  let depth = 0;
  let quote = null;
  for (let i = start; i < source.length; i += 1) {
    const c = source[i];
    if (quote) {
      if (c === '\\') { i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    else if (c === ';' && depth === 0) return source.slice(start, i);
  }
  return source.slice(start);
}

function balanced(source, open, left, right) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < source.length; i += 1) {
    const c = source[i];
    if (quote) {
      if (c === '\\') { i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === left) depth += 1;
    else if (c === right) {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return source.slice(open);
}

function helperBase(body, param) {
  const root = new RegExp(`\\breadFile(?:Sync)?\\s*\\(\\s*join\\s*\\(\\s*ROOT\\s*,\\s*${param}\\b`);
  const here = new RegExp(`\\breadFile(?:Sync)?\\s*\\(\\s*join\\s*\\(\\s*HERE\\s*,\\s*${param}\\b`);
  if (root.test(body)) return 'ROOT';
  if (here.test(body)) return 'HERE';
  return null;
}

function findHelpers(source) {
  const helpers = [];
  const arrow = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(\s*([A-Za-z_$][\w$]*)\s*\)\s*=>/g;
  for (const match of source.matchAll(arrow)) {
    const body = untilSemicolon(source, match.index + match[0].length);
    const base = helperBase(body, match[2]);
    if (base) helpers.push({ name: match[1], base, index: match.index });
  }
  const fn = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\{/g;
  for (const match of source.matchAll(fn)) {
    const body = balanced(source, match.index + match[0].length - 1, '{', '}');
    const base = helperBase(body, match[2]);
    if (base) helpers.push({ name: match[1], base, index: match.index });
  }
  return helpers;
}

function skipMessages(source) {
  const msgs = [];
  let quote = null;
  let buf = '';
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    if (quote) {
      if (c === '\\') {
        buf += source[i + 1] || '';
        i += 1;
        continue;
      }
      if (c === quote) {
        if (/skip\s*:/i.test(buf)) msgs.push(buf);
        quote = null;
        buf = '';
        continue;
      }
      buf += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      buf = '';
    }
  }
  return msgs;
}

function mergeValues(values) {
  if (values.some((value) => !value)) return null;
  const rooted = values.every((value) => value.rooted);
  const unrooted = values.every((value) => !value.rooted);
  if (!rooted && !unrooted) return null;
  return { rooted, items: values.flatMap((value) => value.items) };
}

function scriptDir(script) {
  const parts = String(script).split('/').filter(Boolean);
  parts.pop();
  return parts;
}

function literalPath(base, literal, dirSegs) {
  const extra = splitPath(literal);
  const baseSegs = base === 'HERE' ? dirSegs.slice() : [];
  const segs = applySegs(baseSegs, extra);
  if (!segs || segs.length === 0) return null;
  const file = segs.join('/');
  if (!file || file.includes('..') || file.includes('://')) return null;
  return file;
}

/**
 * @returns {{ reads: Set<string>, existsPaths: string[], messages: string[] }}
 */
function analyze(source, script) {
  const text = stripComments(source);
  const dirSegs = scriptDir(script);
  const helpers = findHelpers(text);
  const events = [];

  for (const match of text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) {
    events.push({
      type: 'assign',
      index: match.index,
      name: match[1],
      expr: parseExpr(untilSemicolon(text, match.index + match[0].length)),
    });
  }
  for (const match of text.matchAll(/\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s+of\s+\[/g)) {
    const open = match.index + match[0].length - 1;
    const body = balanced(text, open, '[', ']');
    const inner = body.slice(1, -1);
    events.push({
      type: 'for',
      index: match.index,
      name: match[1],
      values: splitArgs(inner).filter((part) => part !== '').map(parseExpr),
    });
  }
  for (const match of text.matchAll(/\breadFile(?:Sync)?\s*\(/g)) {
    const arg = firstArg(text, match.index + match[0].length - 1);
    events.push({ type: 'read', index: match.index, expr: parseExpr(arg || '') });
  }
  for (const match of text.matchAll(/\bexistsSync\s*\(/g)) {
    const arg = firstArg(text, match.index + match[0].length - 1);
    events.push({ type: 'exists', index: match.index, expr: parseExpr(arg || '') });
  }
  for (const helper of helpers) {
    const call = new RegExp(`\\b${helper.name}\\s*\\(\\s*(['"])((?:\\\\.|(?!\\1).)*)\\1`, 'g');
    for (const match of text.matchAll(call)) {
      if (match.index > helper.index) {
        events.push({
          type: 'helper',
          index: match.index,
          file: literalPath(helper.base, match[2], dirSegs),
        });
      }
    }
  }

  events.sort((a, b) => a.index - b.index);
  const bindings = new Map();
  bindings.set('HERE', { rooted: true, items: [dirSegs.slice()] });
  bindings.set('ROOT', { rooted: true, items: [[]] });
  const reads = new Set();
  const existsPaths = [];

  const remember = (kind, value) => {
    for (const file of rootedPaths(value)) {
      if (kind === 'read') reads.add(file);
      else if (!existsPaths.includes(file)) existsPaths.push(file);
    }
  };

  for (const event of events) {
    if (event.type === 'assign') {
      const value = evalExpr(event.expr, bindings);
      if (value) bindings.set(event.name, value);
      else if (event.name !== 'HERE' && event.name !== 'ROOT') bindings.set(event.name, null);
    } else if (event.type === 'for') {
      const merged = mergeValues(event.values.map((expr) => evalExpr(expr, bindings)));
      bindings.set(event.name, merged);
    } else if (event.type === 'read') {
      remember('read', evalExpr(event.expr, bindings));
    } else if (event.type === 'exists') {
      remember('exists', evalExpr(event.expr, bindings));
    } else if (event.type === 'helper' && event.file) {
      reads.add(event.file);
    }
  }

  return { reads, existsPaths, messages: skipMessages(text) };
}

export function testScriptPaths(testScript) {
  if (typeof testScript !== 'string') return [];
  const out = [];
  for (const part of testScript.split('&&')) {
    const match = /^\s*node\s+(\S+)/.exec(part);
    if (!match) continue;
    let path = match[1];
    if ((path.startsWith('"') && path.endsWith('"')) || (path.startsWith("'") && path.endsWith("'"))) {
      path = path.slice(1, -1);
    }
    if (path && !out.includes(path)) out.push(path);
  }
  return out;
}

function normEntry(entry) {
  return String(entry).replace(/^\.\//, '').replace(/\/+$/, '');
}

/** A files entry covers its own path and, as a directory, everything under it. */
function covered(rel, files) {
  for (const entry of files || []) {
    const raw = String(entry).replace(/^\.\//, '');
    if (raw.startsWith('!')) continue;
    const base = normEntry(raw);
    if (!base) continue;
    if (rel === base || rel.startsWith(`${base}/`)) return true;
  }
  return false;
}

function alwaysIncluded(rel, pkg) {
  if (rel === 'package.json') return true;
  if (!rel.includes('/')) {
    if (/^README(\.|$)/i.test(rel)) return true;
    if (/^(LICENSE|LICENCE|COPYING)(\.|$)/i.test(rel)) return true;
  }
  if (typeof pkg.main === 'string' && normEntry(pkg.main) === rel) return true;
  const bins = pkg.bin == null ? [] : (typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin));
  return bins.some((bin) => typeof bin === 'string' && normEntry(bin) === rel);
}

/** docs, docs/, and anything under docs/ are never a legal files entry. */
export function docsFilesEntries(files) {
  const bad = [];
  for (const entry of files || []) {
    const raw = String(entry).replace(/^\.\//, '');
    if (raw.startsWith('!')) continue;
    const base = normEntry(raw);
    if (base === 'docs' || raw.startsWith('docs/')) bad.push(String(entry));
  }
  return bad;
}

function isGuarded(file, existsPaths, messages) {
  const prefixes = existsPaths.filter((guard) => guard === file || file.startsWith(`${guard}/`));
  if (prefixes.length === 0) return false;
  return messages.some((msg) => {
    if (!/skip\s*:/i.test(msg)) return false;
    if (!/absent|not a source checkout|outside a (?:source )?checkout|published package/i.test(msg)) return false;
    return msg.includes(file) || prefixes.some((guard) => msg.includes(guard));
  });
}

/**
 * @param {object} packageJson parsed package.json (files, scripts.test, main, bin)
 * @param {Record<string, string>} sources script path from scripts.test -> source text
 * @returns {{ docs: string[], gaps: { script: string, file: string }[] }}
 */
export function packageTestFileGaps(packageJson, sources) {
  const pkg = packageJson && typeof packageJson === 'object' ? packageJson : {};
  const files = Array.isArray(pkg.files) ? pkg.files : [];
  const docs = docsFilesEntries(files);
  const gaps = [];
  const map = sources && typeof sources === 'object' ? sources : {};
  for (const script of testScriptPaths(pkg.scripts && pkg.scripts.test)) {
    const source = map[script];
    if (typeof source !== 'string') {
      gaps.push({ script, file: script });
      continue;
    }
    const { reads, existsPaths, messages } = analyze(source, script);
    for (const file of reads) {
      if (alwaysIncluded(file, pkg) || covered(file, files)) continue;
      if (isGuarded(file, existsPaths, messages)) continue;
      gaps.push({ script, file });
    }
  }
  gaps.sort((a, b) => (a.script === b.script ? a.file.localeCompare(b.file) : a.script.localeCompare(b.script)));
  const seen = new Set();
  const unique = [];
  for (const gap of gaps) {
    const key = `${gap.script}\0${gap.file}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(gap);
  }
  return { docs, gaps: unique };
}

export function gapLine(gap) {
  return `${gap.script} reads ${gap.file}, which is neither shipped nor skipped when absent outside a checkout`;
}

export function docsLine(entry) {
  return `package.json files entry ${JSON.stringify(entry)} is docs or lies under docs/`;
}

const SAMPLE = 'conformance/sample.mjs';
const HEADER = [
  "import { existsSync, readFileSync } from 'node:fs';",
  "import { dirname, join } from 'node:path';",
  "import { fileURLToPath } from 'node:url';",
  'const HERE = dirname(fileURLToPath(import.meta.url));',
  "const ROOT = join(HERE, '..');",
  '',
].join('\n');

function sample(body) {
  return `${HEADER}${body}\n`;
}

function pkg(files, extra = {}) {
  return {
    files,
    scripts: { test: `node ${SAMPLE}` },
    ...extra,
  };
}

function only(files, body, extra) {
  return packageTestFileGaps(pkg(files, extra), { [SAMPLE]: sample(body) });
}

const syntheticFailures = [];
function expect(ok, label) {
  if (!ok) syntheticFailures.push(label);
}

const readNotes = "readFileSync(join(ROOT, 'NOTES.md'), 'utf8');";
const refused = only(['conformance/'], readNotes);
expect(refused.gaps.length === 1 && refused.gaps[0].file === 'NOTES.md' && refused.gaps[0].script === SAMPLE,
  'negative/an unshipped read with no skip is a failure naming the file and the script');

const emptyStandIn = only(['conformance/'], [
  "const notes = join(ROOT, 'NOTES.md');",
  "const text = existsSync(notes) ? readFileSync(notes, 'utf8') : '';",
].join('\n'));
expect(emptyStandIn.gaps.some((gap) => gap.file === 'NOTES.md'),
  'negative/existsSync that substitutes an empty string is not a skip');

const shippedFile = only(['NOTES.md', 'conformance/'], readNotes);
expect(shippedFile.gaps.length === 0, 'shipped-form/a files entry for the exact path is accepted');

const shippedDir = only(['notes/'], "readFileSync(join(ROOT, 'notes', 'a.md'), 'utf8');");
expect(shippedDir.gaps.length === 0, 'shipped-form/a directory entry covers files under it');

const sibling = only(['scripts/vendor-ranges.mjs'], "readFileSync(join(ROOT, 'scripts', 'build-vectors.mjs'), 'utf8');");
expect(sibling.gaps.some((gap) => gap.file === 'scripts/build-vectors.mjs'),
  'shipped-form/a file entry does not cover a different file');

const skipped = only(['conformance/'], [
  "if (!existsSync(join(ROOT, 'NOTES.md'))) {",
  "  console.log('skip: NOTES.md is absent outside a source checkout');",
  '  process.exit(0);',
  '}',
  readNotes,
].join('\n'));
expect(skipped.gaps.length === 0, 'skip-form/a named skip when the file is absent is accepted');

const prefixSkip = only(['conformance/'], [
  "if (!existsSync(join(ROOT, 'vendor', 'agent-seam'))) {",
  "  console.log('skip: not a source checkout - the published package carries no vendor/agent-seam/.');",
  '  process.exit(0);',
  '}',
  "readFileSync(join(ROOT, 'vendor', 'agent-seam', 'seam.mjs'), 'utf8');",
].join('\n'));
expect(prefixSkip.gaps.length === 0, 'skip-form/a directory prefix named in the skip covers files under it');

const vague = only(['conformance/'], [
  "if (!existsSync(join(ROOT, 'NOTES.md'))) {",
  "  console.log('skip: absent outside a source checkout');",
  '  process.exit(0);',
  '}',
  readNotes,
].join('\n'));
expect(vague.gaps.some((gap) => gap.file === 'NOTES.md'),
  'negative/a skip that does not name the file is not a skip for that file');

for (const entry of ['docs', 'docs/', 'docs/guide.md']) {
  const result = only([entry], '/* no reads */');
  expect(result.docs.length === 1 && result.docs[0] === entry, `docs-refusal/${entry}`);
}
expect(only(['docs.md'], '/* no reads */').docs.length === 0, 'docs-refusal/docs.md is not docs');
expect(only(['documentation/'], '/* no reads */').docs.length === 0, 'docs-refusal/documentation is not docs');

const docsShipsTheRead = only(
  ['docs/secret.md'],
  "readFileSync(join(ROOT, 'docs', 'secret.md'), 'utf8');",
);
expect(docsShipsTheRead.docs.length === 1, 'docs-refusal/shipping a read by listing docs/ still fails');
expect(!docsShipsTheRead.gaps.some((gap) => gap.file === 'docs/secret.md'),
  'docs-refusal/the docs entry is its own failure');

expect(only([], "readFileSync(join(ROOT, 'package.json'), 'utf8');").gaps.length === 0,
  'always/package.json');
expect(only([], "readFileSync(join(ROOT, 'README.md'), 'utf8');").gaps.length === 0,
  'always/root-readme');
expect(only([], "readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');").gaps.some((gap) => gap.file === 'CHANGELOG.md'),
  'always/changelog-is-not-an-always-included-file');
expect(only([], "readFileSync(join(ROOT, 'door.mjs'), 'utf8');", { main: 'door.mjs' }).gaps.length === 0,
  'always/main');
expect(only([], "readFileSync(join(ROOT, 'bin/run.mjs'), 'utf8');", { bin: { run: 'bin/run.mjs' } }).gaps.length === 0,
  'always/bin');

const split = testScriptPaths('node conformance/a.mjs &&node conformance/b.mjs && node conformance/c.mjs');
expect(split.join(',') === 'conformance/a.mjs,conformance/b.mjs,conformance/c.mjs',
  'scripts-test/splits-on-andand-with-or-without-a-space');

const helperRead = packageTestFileGaps(pkg(['conformance/']), {
  [SAMPLE]: sample([
    'const read = (rel) => (existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel), \'utf8\') : \'\');',
    "read('NOTES.md');",
  ].join('\n')),
});
expect(helperRead.gaps.some((gap) => gap.file === 'NOTES.md'),
  'negative/a helper that reads its argument is a read of that file');

const pkgOnDisk = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const sources = {};
for (const script of testScriptPaths(pkgOnDisk.scripts && pkgOnDisk.scripts.test)) {
  sources[script] = readFileSync(join(ROOT, script), 'utf8');
}
const live = packageTestFileGaps(pkgOnDisk, sources);

if (syntheticFailures.length) {
  console.log(`synthetic failures (${syntheticFailures.length}):`);
  for (const label of syntheticFailures) console.log(`  ${label}`);
}
for (const entry of live.docs) console.log(docsLine(entry));
for (const gap of live.gaps) console.log(gapLine(gap));

if (syntheticFailures.length || live.docs.length || live.gaps.length) process.exit(1);
console.log('package test files: every script read is shipped or skipped');
