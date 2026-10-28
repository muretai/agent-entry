#!/usr/bin/env node
// Intake 20261028T131235Z, narrowed by owner ruling 20261028T144142Z. Whole item.
// Agent Entry lands through GitHub pull requests. This item adds three files only:
//   .github/workflows/test.yml  npm ci and npm test on pull_request and merge_group for
//                               main, ubuntu-latest, Node 22, timeout-minutes below 10
//   .github/CODEOWNERS          present, no rule lines yet
//   docs/LANDING.md             English and ASCII; feat/* pull requests, the required
//                               check named by the workflow's job name, the merge queue,
//                               the publisher, and the owner's branch-protection steps
//                               with the exact GitHub setting names
// Written before those files exist. No YAML parser is installed (zero dependencies),
// so the workflow is read with a minimal indentation-based text check below. The
// checks are functions, exercised on the real files and on bad inputs.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const WORKFLOW = join(ROOT, '.github', 'workflows', 'test.yml');
const CODEOWNERS = join(ROOT, '.github', 'CODEOWNERS');
const LANDING = join(ROOT, 'docs', 'LANDING.md');

// GitHub's own setting names for a classic branch protection rule. The push restriction
// is named either way GitHub spells it (classic rule or ruleset).
const SETTING_NAMES = [
  ['Require status checks to pass before merging'],
  ['Require merge queue'],
  ['Restrict who can push to matching branches', 'Restrict updates'],
];

function stripComment(line) {
  let quote = '';
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function unquote(value) {
  const v = value.trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) {
    return v.slice(1, -1);
  }
  return v;
}

// The meaningful lines: comments and blanks dropped, indentation kept.
function yamlLines(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw).replace(/\s+$/, '');
    if (line.trim() === '' || line.trim() === '---') continue;
    out.push({ indent: line.length - line.trimStart().length, text: line.trim() });
  }
  return out;
}

// The lines nested under the first `key:` found at exactly `indent`, within `lines`.
function block(lines, key, indent) {
  const re = new RegExp(`^(?:-\\s+)?["']?${key}["']?\\s*:(.*)$`);
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].indent === indent && lines[i].text.match(re);
    if (!m) continue;
    const inline = m[1].trim();
    const body = [];
    for (let j = i + 1; j < lines.length && lines[j].indent > indent; j += 1) body.push(lines[j]);
    return { inline, body };
  }
  return null;
}

// Keys directly under a block (its shallowest indentation).
function childKeys(body) {
  if (body.length === 0) return [];
  const indent = Math.min(...body.map((l) => l.indent));
  return body
    .filter((l) => l.indent === indent)
    .map((l) => l.text.match(/^["']?([A-Za-z0-9_-]+)["']?\s*:/))
    .filter(Boolean)
    .map((m) => m[1]);
}

function triggerNames(onBlock) {
  if (onBlock.inline) {
    return onBlock.inline.replace(/^\[|\]$/g, '').split(',').map((s) => unquote(s)).filter(Boolean);
  }
  const indent = onBlock.body.length ? Math.min(...onBlock.body.map((l) => l.indent)) : 0;
  const names = [];
  for (const l of onBlock.body) {
    if (l.indent !== indent) continue;
    const m = l.text.match(/^(?:-\s+)?["']?([A-Za-z_]+)["']?\s*:?/);
    if (m) names.push(m[1]);
  }
  return names;
}

// The check name GitHub shows for each job: its `name:` when set, else its id.
export function workflowJobs(text) {
  const lines = yamlLines(text);
  const jobs = block(lines, 'jobs', 0);
  if (!jobs) return [];
  const indent = jobs.body.length ? Math.min(...jobs.body.map((l) => l.indent)) : 0;
  return childKeys(jobs.body).map((id) => {
    const job = block(jobs.body, id, indent);
    const nameLine = job.body.find(
      (l) => l.indent === Math.min(...job.body.map((x) => x.indent)) && /^name\s*:/.test(l.text),
    );
    const name = nameLine ? unquote(nameLine.text.replace(/^name\s*:/, '')) : id;
    return { id, name, body: job.body };
  });
}

// Returns the list of problems; an empty list means the workflow passes.
export function checkWorkflow(text) {
  const problems = [];
  if (typeof text !== 'string' || text.trim() === '') return ['the workflow is empty'];
  if (/^\t/m.test(text)) problems.push('the workflow is indented with a tab, which YAML refuses');
  const lines = yamlLines(text);

  const on = block(lines, 'on', 0);
  if (!on) {
    problems.push('the workflow has no top-level on: key');
  } else {
    const triggers = triggerNames(on);
    for (const t of ['pull_request', 'merge_group']) {
      if (!triggers.includes(t)) problems.push(`the workflow does not trigger on ${t}`);
    }
    const onText = [on.inline, ...on.body.map((l) => l.text)].join('\n');
    if (!/(^|[\s\[,'"-])main(['"\],\s]|$)/m.test(onText)) {
      problems.push('the triggers do not name main');
    }
  }

  const jobs = workflowJobs(text);
  if (jobs.length === 0) {
    problems.push('the workflow has no jobs');
    return problems;
  }
  const all = jobs.flatMap((j) => j.body.map((l) => l.text)).join('\n');

  for (const job of jobs) {
    const top = Math.min(...job.body.map((l) => l.indent));
    const runsOn = job.body.find((l) => l.indent === top && /^runs-on\s*:/.test(l.text));
    if (!runsOn || unquote(runsOn.text.replace(/^runs-on\s*:/, '')) !== 'ubuntu-latest') {
      problems.push(`job ${job.id} does not run on ubuntu-latest`);
    }
    const timeout = job.body.find((l) => l.indent === top && /^timeout-minutes\s*:/.test(l.text));
    if (!timeout) {
      problems.push(`job ${job.id} has no timeout-minutes`);
    } else {
      const value = unquote(timeout.text.replace(/^timeout-minutes\s*:/, ''));
      if (!/^\d+$/.test(value) || Number(value) <= 0 || Number(value) >= 10) {
        problems.push(`job ${job.id} timeout-minutes ${value} is not below 10`);
      }
    }
  }
  // A step-level timeout of 10 or more is refused too.
  for (const m of all.matchAll(/^(?:-\s+)?timeout-minutes\s*:\s*(.*)$/gm)) {
    const value = unquote(m[1]);
    if (!/^\d+$/.test(value) || Number(value) >= 10) {
      problems.push(`a timeout-minutes of ${value} is not below 10`);
    }
  }

  const node = all.match(/^(?:-\s+)?node-version\s*:\s*(.*)$/m);
  if (!node || !/^22(\.x)?$/.test(unquote(node[1]))) {
    problems.push('the workflow does not set node-version 22');
  }
  if (!/actions\/setup-node@/.test(all)) problems.push('the workflow does not use actions/setup-node');

  const runs = all
    .split('\n')
    .filter((l) => /^(?:-\s+)?run\s*:/.test(l))
    .map((l) => unquote(l.replace(/^(?:-\s+)?run\s*:/, '')));
  if (!runs.some((r) => /^npm ci$/.test(r))) problems.push('no step runs npm ci');
  if (!runs.some((r) => /^npm test$/.test(r))) problems.push('no step runs npm test');

  // The plain-HTTP fixture warning is tolerated: nothing silences it or the failure.
  if (/NODE_NO_WARNINGS|--no-warnings|--disable-warning/.test(text)) {
    problems.push('the workflow suppresses node warnings');
  }
  if (/continue-on-error\s*:\s*true/.test(text)) problems.push('the workflow sets continue-on-error');
  if (/npm (ci|test)[^\n]*(\|\||;|&)/.test(text)) problems.push('npm ci or npm test is chained or masked');
  return problems;
}

export function checkCodeowners(text) {
  if (typeof text !== 'string') return ['CODEOWNERS is missing'];
  const rules = text.split(/\r?\n/).filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
  return rules.length ? [`CODEOWNERS has rule lines: ${rules.join(' | ')}`] : [];
}

export function checkLanding(text, jobName) {
  const problems = [];
  if (typeof text !== 'string' || text.trim() === '') return ['LANDING.md is empty'];
  if (/[^\x00-\x7f]/.test(text)) problems.push('LANDING.md is not ASCII');
  if (!jobName || !text.includes(jobName)) problems.push(`LANDING.md does not name the job ${jobName}`);
  if (!text.includes('feat/*')) problems.push('LANDING.md does not mention feat/*');
  if (!/pull request/i.test(text)) problems.push('LANDING.md does not mention pull requests');
  if (!/merge queue/i.test(text)) problems.push('LANDING.md does not mention the merge queue');
  if (!/publisher/i.test(text)) problems.push('LANDING.md does not mention the publisher');
  if (!/\bmain\b/.test(text)) problems.push('LANDING.md does not mention main');
  if (!/protect/i.test(text)) problems.push('LANDING.md does not say main is protected');
  for (const names of SETTING_NAMES) {
    if (!names.some((n) => text.includes(n))) {
      problems.push(`LANDING.md does not name the setting ${names.join(' / ')}`);
    }
  }
  return problems;
}

const GOOD = `name: test
on:
  pull_request:
    branches: [main]
  merge_group:
    branches: [main]
jobs:
  test:
    name: test
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npm test
`;

const GOOD_LANDING = `# Landing
A change lands as a pull request from a feat/* branch. The required check is test.
main is protected and merged by the merge queue. The publisher is the only account
that pushes branches and opens pull requests. No one pushes main.
Require status checks to pass before merging. Require merge queue.
Restrict who can push to matching branches.
`;

// --- the real files -------------------------------------------------------------

test('the workflow file exists and passes the check', () => {
  assert.ok(existsSync(WORKFLOW), '.github/workflows/test.yml is missing');
  assert.deepEqual(checkWorkflow(readFileSync(WORKFLOW, 'utf8')), []);
});

test('the workflow has exactly one job and it has a check name', () => {
  assert.ok(existsSync(WORKFLOW), '.github/workflows/test.yml is missing');
  const jobs = workflowJobs(readFileSync(WORKFLOW, 'utf8'));
  assert.equal(jobs.length, 1, `jobs: ${jobs.map((j) => j.id).join(', ')}`);
  assert.ok(jobs[0].name);
});

test('.github/CODEOWNERS exists and has no rule lines', () => {
  assert.ok(existsSync(CODEOWNERS), '.github/CODEOWNERS is missing');
  assert.deepEqual(checkCodeowners(readFileSync(CODEOWNERS, 'utf8')), []);
});

test('docs/LANDING.md names the job from the workflow and the landing rules', () => {
  assert.ok(existsSync(LANDING), 'docs/LANDING.md is missing');
  assert.ok(existsSync(WORKFLOW), '.github/workflows/test.yml is missing');
  const [job] = workflowJobs(readFileSync(WORKFLOW, 'utf8'));
  assert.ok(job, 'the workflow has no job');
  assert.deepEqual(checkLanding(readFileSync(LANDING, 'utf8'), job.name), []);
});

// --- the checks accept a good input ----------------------------------------------

test('the workflow check accepts a good workflow', () => {
  assert.deepEqual(checkWorkflow(GOOD), []);
  assert.deepEqual(workflowJobs(GOOD).map((j) => j.name), ['test']);
});

test('the workflow check accepts the list form of on and a quoted node version', () => {
  const text = GOOD.replace(/on:\n  pull_request:\n    branches: \[main\]\n  merge_group:\n    branches: \[main\]\n/,
    'on:\n  pull_request:\n    branches:\n      - main\n  merge_group:\n').replace('node-version: 22', "node-version: '22'");
  assert.deepEqual(checkWorkflow(text), []);
});

test('the job id names the check when the job has no name', () => {
  const text = GOOD.replace('    name: test\n', '').replace('  test:\n', '  unit:\n');
  assert.deepEqual(workflowJobs(text).map((j) => j.name), ['unit']);
});

test('the landing and codeowners checks accept good inputs', () => {
  assert.deepEqual(checkLanding(GOOD_LANDING, 'test'), []);
  assert.deepEqual(checkCodeowners(''), []);
  assert.deepEqual(checkCodeowners('# owners come later\n\n'), []);
});

// --- refusals ---------------------------------------------------------------------

function refused(text, pattern) {
  const problems = checkWorkflow(text);
  assert.ok(problems.some((p) => pattern.test(p)), `expected ${pattern}, got ${JSON.stringify(problems)}`);
}

test('a workflow without pull_request is refused', () => {
  refused(GOOD.replace('  pull_request:\n    branches: [main]\n', ''), /pull_request/);
});

test('a workflow without merge_group is refused', () => {
  refused(GOOD.replace('  merge_group:\n    branches: [main]\n', ''), /merge_group/);
});

test('a workflow whose triggers do not name main is refused', () => {
  refused(GOOD.replaceAll('[main]', '[develop]'), /main/);
});

test('a timeout of 10 or more is refused', () => {
  refused(GOOD.replace('timeout-minutes: 5', 'timeout-minutes: 10'), /timeout/);
  refused(GOOD.replace('timeout-minutes: 5', 'timeout-minutes: 30'), /timeout/);
  refused(GOOD.replace('timeout-minutes: 5', 'timeout-minutes: 9.5'), /timeout/);
});

test('a missing timeout is refused', () => {
  refused(GOOD.replace('    timeout-minutes: 5\n', ''), /timeout/);
});

test('a step timeout of 10 or more is refused', () => {
  refused(GOOD.replace('      - run: npm test\n', '      - run: npm test\n        timeout-minutes: 15\n'), /timeout/);
});

test('a workflow missing npm ci is refused', () => {
  refused(GOOD.replace('      - run: npm ci\n', ''), /npm ci/);
  refused(GOOD.replace('run: npm ci', 'run: npm install'), /npm ci/);
});

test('a workflow missing npm test is refused', () => {
  refused(GOOD.replace('      - run: npm test\n', ''), /npm test/);
  refused(GOOD.replace('run: npm test', '# run: npm test'), /npm test/);
});

test('a masked npm test is refused', () => {
  refused(GOOD.replace('run: npm test', 'run: npm test || true'), /npm test|masked/);
  refused(GOOD.replace('      - run: npm test\n', '      - run: npm test\n        continue-on-error: true\n'), /continue-on-error/);
});

test('a step that suppresses the fixture warning is refused', () => {
  refused(GOOD.replace('jobs:\n', 'env:\n  NODE_NO_WARNINGS: 1\njobs:\n'), /warnings/);
  refused(GOOD.replace('run: npm test', 'run: NODE_OPTIONS=--no-warnings npm test'), /warnings|npm test/);
});

test('a wrong runner or node version is refused', () => {
  refused(GOOD.replace('ubuntu-latest', 'macos-latest'), /ubuntu-latest/);
  refused(GOOD.replace('node-version: 22', 'node-version: 20'), /node-version/);
  refused(GOOD.replace('          node-version: 22\n', '          cache: npm\n'), /node-version/);
});

test('an empty or unparseable workflow is refused', () => {
  assert.notDeepEqual(checkWorkflow(''), []);
  assert.notDeepEqual(checkWorkflow('jobs:\n\ttest:\n'), []);
  refused(GOOD.replace(/^jobs:[\s\S]*$/m, ''), /no jobs/);
});

test('CODEOWNERS with a rule line or missing is refused', () => {
  assert.notDeepEqual(checkCodeowners('* @someone\n'), []);
  assert.notDeepEqual(checkCodeowners('# owners\ndocs/ @someone\n'), []);
  assert.notDeepEqual(checkCodeowners(undefined), []);
});

test('a LANDING.md that is not ASCII is refused', () => {
  assert.ok(checkLanding(`${GOOD_LANDING}—\n`, 'test').some((p) => /ASCII/.test(p)));
});

test('a LANDING.md that does not name the job is refused', () => {
  assert.ok(checkLanding(GOOD_LANDING, 'unit').some((p) => /job unit/.test(p)));
  assert.ok(checkLanding(GOOD_LANDING, '').some((p) => /job/.test(p)));
});

test('a LANDING.md missing feat/*, merge queue, publisher or a setting name is refused', () => {
  for (const [cut, pattern] of [
    ['feat/*', /feat/],
    ['merge queue', /merge queue/],
    ['publisher', /publisher/],
    ['Require status checks to pass before merging', /status checks/],
    ['Require merge queue', /Require merge queue/],
    ['Restrict who can push to matching branches', /Restrict/],
  ]) {
    const text = GOOD_LANDING.split(cut).join('');
    assert.ok(checkLanding(text, 'test').some((p) => pattern.test(p)), `cutting ${cut}`);
  }
});
