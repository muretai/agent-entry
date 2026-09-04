#!/usr/bin/env node
/**
 * Local loop: distill fixtures (+ optional var/traces.jsonl) → measure → mutation.
 * --m0 also runs the door conformance suite. Never uploads. Never edits the card.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const runM0 = process.argv.includes('--m0');

function run(file, extra = []) {
  const r = spawnSync(process.execPath, [resolve(HERE, file), ...extra], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) process.exit(r.status ?? 1);
}

run('distill.mjs');
run('measure.mjs');
process.stdout.write('\n--- mutation (empty Distiller) ---\n');
run('distill.mjs', ['--empty']);
run('measure.mjs', ['--empty']);
run('distill.mjs');

const unit = spawnSync(process.execPath, ['--test', resolve(HERE, 'test.mjs')], {
  cwd: ROOT,
  encoding: 'utf8',
});
if (unit.stdout) process.stdout.write(unit.stdout);
if (unit.stderr) process.stderr.write(unit.stderr);
if (unit.status !== 0) process.exit(unit.status ?? 1);

if (runM0) {
  process.stdout.write('\n--- M0 npm test (conformance) ---\n');
  const t = spawnSync('npm', ['test'], { cwd: ROOT, encoding: 'utf8' });
  if (t.stdout) process.stdout.write(t.stdout);
  if (t.stderr) process.stderr.write(t.stderr);
  if (t.status !== 0) process.exit(t.status ?? 1);
}
