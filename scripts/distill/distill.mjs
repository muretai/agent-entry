#!/usr/bin/env node
/**
 * Traces → generated/skills.json + rules.json.
 * Empty Distiller: --empty (mutation). Never writes the running card.
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inferRules, loadCases, proposedSkills, readJsonl, tracesFromCases, respond } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const OUT = resolve(ROOT, 'generated');

function localTraces(path) {
  return readJsonl(path).map((row, i) => {
    const text = row.text || row.doc?.text || '';
    const env = respond(text);
    return {
      id: row.id || `local-${i + 1}`,
      intent: /\b(book|reserve|slot)\b/i.test(text) ? 'book' : (/\b(price|cost|how much)\b/i.test(text) ? 'price' : 'other'),
      text,
      tag: env.tag,
      environment_useful: env.useful,
    };
  });
}

const empty = process.argv.includes('--empty');
const tracesPath = process.env.AE_TRACES || resolve(ROOT, 'var/traces.jsonl');
const train = tracesFromCases(loadCases(), 'train');
const local = existsSync(tracesPath) ? localTraces(tracesPath) : [];
const rules = empty ? { empty: true, examples: [], evidence: [] } : inferRules([...train, ...local]);
const skills = proposedSkills(rules);

mkdirSync(OUT, { recursive: true });
writeFileSync(resolve(OUT, 'rules.json'), JSON.stringify(rules, null, 2) + '\n');
writeFileSync(resolve(OUT, 'skills.json'), JSON.stringify(skills, null, 2) + '\n');
writeFileSync(resolve(OUT, 'R.json'), JSON.stringify({
  traces: train.length + local.length,
  local: local.length,
  empty,
  book_require_day: Boolean(rules.book_require_day),
  examples: rules.examples || [],
}, null, 2) + '\n');

process.stdout.write(
  `distilled ${train.length} fixture + ${local.length} local traces`
  + (empty ? ' (empty Distiller)' : '')
  + ` → generated/skills.json (${skills.length} skill(s))\n`,
);
