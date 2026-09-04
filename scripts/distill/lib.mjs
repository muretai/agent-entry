/**
 * Local AE distill helpers. The Distiller never imports the door runtime.
 * Gold labels come from the fixture responder (the same policy the example
 * studio already implements: a book request without a day is not yet useful).
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DAY = /\b(mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday|20\d{2}-\d{2}-\d{2})\b/i;
const PRICE = /\b(price|cost|how much|jpy|half-day|60-minute)\b/i;

export function loadCases() {
  return JSON.parse(readFileSync(join(HERE, 'fixtures.json'), 'utf8')).cases;
}

/** Environment: what this desk actually answers. */
export function respond(text) {
  const t = String(text || '');
  if (PRICE.test(t)) {
    return { tag: 'price', useful: true, text: 'A 60-minute shoot is 12000 JPY, two people included.' };
  }
  if (DAY.test(t)) {
    return { tag: 'open', useful: true, text: 'Saturday 14:00 is open. 12000 JPY for a 60-minute shoot.' };
  }
  return { tag: 'ask_day', useful: false, text: 'Which day? Name a weekday or YYYY-MM-DD.' };
}

export function naiveText(case_) {
  return case_.naive_text;
}

export function inferRules(traces) {
  const rules = {
    empty: traces.length === 0,
    book_require_day: false,
    examples: [],
    evidence: [],
  };
  for (const tr of traces) {
    rules.evidence.push({ id: tr.id, intent: tr.intent, useful: tr.environment_useful, tag: tr.tag });
    if (tr.intent === 'book' && !tr.environment_useful && tr.tag === 'ask_day') {
      rules.book_require_day = true;
    }
    if (tr.environment_useful && tr.intent === 'book' && DAY.test(tr.text)) {
      rules.examples.push(tr.text);
    }
    if (tr.environment_useful && tr.intent === 'price') {
      rules.examples.push(tr.text);
    }
  }
  rules.examples = [...new Set(rules.examples)];
  return rules;
}

export function applyText(case_, rules) {
  if (rules.empty) return naiveText(case_);
  let text = naiveText(case_);
  if (rules.book_require_day && case_.intent === 'book' && !DAY.test(text)) {
    const ex = rules.examples.find((e) => DAY.test(e));
    text = ex || `${text} Saturday`;
  }
  return text;
}

export function tracesFromCases(cases, split = 'train') {
  return cases.filter((c) => c.split === split).map((c) => {
    const text = naiveText(c);
    const env = respond(text);
    return {
      id: c.id,
      intent: c.intent,
      text,
      tag: env.tag,
      environment_useful: env.useful,
    };
  });
}

export function proposedSkills(rules) {
  if (rules.empty) return [];
  const examples = rules.examples.length
    ? rules.examples
    : (rules.book_require_day ? ['Book Saturday 14:00'] : []);
  return [{
    id: 'ask',
    name: 'signed-answers-about-the-studio',
    description: rules.book_require_day
      ? 'Ask what a shoot costs, and book by naming a day. The answer comes back signed.'
      : 'Ask what a shoot costs and how to book. The answer comes back signed.',
    tags: ['studio', 'booking', 'signed', 'inline-reply'],
    examples,
  }];
}

export function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}
