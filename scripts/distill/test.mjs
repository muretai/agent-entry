import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyText, inferRules, loadCases, naiveText, proposedSkills, respond, tracesFromCases } from './lib.mjs';

function score(cases, textOf) {
  let ok = 0;
  for (const c of cases) {
    if (respond(textOf(c)).useful) ok += 1;
  }
  return cases.length ? ok / cases.length : 0;
}

test('responder asks for a day when the book prompt names none', () => {
  assert.equal(respond('I want to book a shoot').useful, false);
  assert.equal(respond('I want to book a shoot').tag, 'ask_day');
  assert.equal(respond('Book Saturday 14:00').useful, true);
});

test('distilled menu beats sending the prompt as-is on holdout', () => {
  const cases = loadCases();
  const rules = inferRules(tracesFromCases(cases, 'train'));
  const holdout = cases.filter((c) => c.split === 'holdout');
  const without = score(holdout, naiveText);
  const withSkill = score(holdout, (c) => applyText(c, rules));
  assert.ok(withSkill > without, `expected lift, got without=${without} with=${withSkill}`);
  assert.equal(withSkill, 1);
});

test('empty Distiller produces no lift (producer mutation)', () => {
  const holdout = loadCases().filter((c) => c.split === 'holdout');
  const without = score(holdout, naiveText);
  const withEmpty = score(holdout, (c) => applyText(c, { empty: true }));
  assert.equal(withEmpty, without);
});

test('proposed skills[] examples are answerable by the responder', () => {
  const rules = inferRules(tracesFromCases(loadCases(), 'train'));
  const skills = proposedSkills(rules);
  assert.ok(skills.length >= 1);
  for (const ex of skills[0].examples) {
    assert.equal(respond(ex).useful, true, `example not answerable: ${ex}`);
  }
});
