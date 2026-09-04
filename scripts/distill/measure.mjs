#!/usr/bin/env node
/**
 * M2: held-out visitor prompts. Naive sends the prompt as-is.
 * Skill rewrites a book request that names no day using a distilled example.
 * Gold = fixture responder. Mutation: --empty → apply == naive, lift 0.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyText, loadCases, naiveText, respond } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const OUT = resolve(ROOT, 'generated');

function loadRules(empty) {
  if (empty) return { empty: true, examples: [] };
  const p = resolve(OUT, 'rules.json');
  if (!existsSync(p)) {
    process.stderr.write('measure.mjs: run distill.mjs first (no generated/rules.json)\n');
    process.exit(1);
  }
  return JSON.parse(readFileSync(p, 'utf8'));
}

function score(cases, textOf) {
  const rows = [];
  let ok = 0;
  for (const c of cases) {
    const text = textOf(c);
    const env = respond(text);
    if (env.useful) ok += 1;
    rows.push({ id: c.id, intent: c.intent, text, useful: env.useful, tag: env.tag });
  }
  return { ok, n: cases.length, pct: cases.length ? ok / cases.length : 0, rows };
}

const empty = process.argv.includes('--empty');
const rules = loadRules(empty);
const holdout = loadCases().filter((c) => c.split === 'holdout');
const without = score(holdout, naiveText);
const withSkill = score(holdout, (c) => applyText(c, rules));
const lift = withSkill.pct - without.pct;

const lines = [
  '# Agent Entry — local distill measure',
  '',
  empty ? 'Arm: **empty Distiller** (mutation).' : 'Arm: distilled `generated/rules.json`.',
  '',
  `| arm | holdout first-knock useful |`,
  `|---|---|`,
  `| without skill (send the prompt) | ${without.ok}/${without.n} (${(without.pct * 100).toFixed(0)}%) |`,
  `| with skill | ${withSkill.ok}/${withSkill.n} (${(withSkill.pct * 100).toFixed(0)}%) |`,
  `| lift | ${(lift * 100).toFixed(0)} pt |`,
  '',
  'Gold is the fixture responder, not a transcript judge.',
  '',
  '### holdout',
  '',
  ...withSkill.rows.map((r) => {
    const w = without.rows.find((x) => x.id === r.id);
    return `- \`${r.id}\` naive="${w.text}" → ${w.tag} | skill="${r.text}" → ${r.tag} ${r.useful ? 'ok' : 'MISS'}`;
  }),
  '',
  'Proposed menu: generated/skills.json — not written onto the running card.',
  '',
];

mkdirSync(OUT, { recursive: true });
writeFileSync(resolve(OUT, 'report.md'), lines.join('\n'));
process.stdout.write(lines.join('\n'));

if (empty && lift !== 0) {
  process.stderr.write('mutation failed: empty Distiller still produced lift\n');
  process.exit(2);
}
if (!empty && lift <= 0) {
  process.stderr.write('no lift on holdout — do not publish the proposed skills[]\n');
  process.exit(2);
}
