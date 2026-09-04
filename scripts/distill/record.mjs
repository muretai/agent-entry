#!/usr/bin/env node
/**
 * Owner-local observer sink. Writes to a path on THIS machine. Never uploads.
 *
 * Wire it when you construct the door:
 *
 *   import { fileSink } from './scripts/distill/record.mjs';
 *   createAgentEntry({ ..., observer: fileSink() });
 *
 * CLI: print the snippet, or append a JSON row from stdin.
 *
 *   node scripts/distill/record.mjs
 *   node scripts/distill/record.mjs --file var/traces.jsonl --stdin < row.json
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');

export function defaultTracePath() {
  return process.env.AE_TRACES || resolve(ROOT, 'var/traces.jsonl');
}

/**
 * Observer that cannot change a verdict (the door already discards its return).
 * Drops card/notice GETs. Never writes a DID.
 */
export function fileSink(path = defaultTracePath()) {
  return (env) => {
    try {
      if (!env || env.stage === 'card_get' || env.stage === 'notice_get') return;
      const row = {
        ts: new Date().toISOString(),
        text: typeof env.text === 'string' ? env.text : '',
        verified: Boolean(env.verified),
        stage: env.stage || null,
        refuse_code: env.refuse_code ?? null,
      };
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, JSON.stringify(row) + '\n');
    } catch {
      // Observer contract: a throw is swallowed by the door; we swallow here too.
    }
  };
}

function usage(code = 0) {
  process.stdout.write(
    'Local AE traces — this machine only, never uploaded.\n'
    + '\n'
    + '  import { fileSink } from \'./scripts/distill/record.mjs\';\n'
    + '  createAgentEntry({ seedHex, name, baseUrl, responder, observer: fileSink() });\n'
    + '\n'
    + '  node scripts/distill/record.mjs --stdin < row.json\n'
    + `  default file: ${defaultTracePath()}\n`,
  );
  process.exit(code);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('record.mjs')) {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) usage(0);
  let file = defaultTracePath();
  let stdin = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--file') { file = resolve(argv[++i] || ''); continue; }
    if (argv[i] === '--stdin') { stdin = true; continue; }
    usage(1);
  }
  if (!stdin) usage(1);
  const raw = readFileSync(0, 'utf8');
  if (!raw.trim()) {
    process.stderr.write('record.mjs: stdin is empty\n');
    process.exit(1);
  }
  let doc;
  try { doc = JSON.parse(raw); } catch (e) {
    process.stderr.write(`record.mjs: stdin is not JSON: ${e.message}\n`);
    process.exit(1);
  }
  fileSink(file)({
    text: doc.text || '',
    verified: Boolean(doc.verified),
    stage: doc.stage || 'signed_post',
    refuse_code: doc.refuse_code ?? null,
  });
  process.stdout.write(`recorded 1 row → ${file}\n`);
}
