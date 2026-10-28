#!/usr/bin/env node
// Intake 20261028T131235Z, narrowed by owner ruling 20261028T144142Z: the GitHub test
// workflow item must NOT set gate = "github" in appl.toml. That switch is a separate,
// later item (agent-entry backlog 20261028T144301Z). This pin holds the gate key absent:
// an appl.toml at the repository root, when there is one, carries no gate = "github".

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APPL_TOML = join(HERE, '..', 'appl.toml');

export function gateLines(text) {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, '').trim())
    .filter((l) => /^gate\s*=\s*["']github["']$/.test(l));
}

test('appl.toml does not carry gate = "github"', () => {
  if (!existsSync(APPL_TOML)) return;
  assert.deepEqual(gateLines(readFileSync(APPL_TOML, 'utf8')), []);
});

test('the gate check finds a gate = "github" line', () => {
  assert.deepEqual(gateLines('[land]\ngate = "github"\n'), ['gate = "github"']);
  assert.deepEqual(gateLines("gate='github' # later\n"), ["gate='github'"]);
  assert.deepEqual(gateLines('# gate = "github"\npin = "0.1.7"\n'), []);
});
