import { readFileSync } from 'node:fs';
import { parseIntent } from './llm.js';
import { hasConstraints, validateIntent } from './schema.js';
import { search } from './search.js';
import { nowInHK } from './time.js';
import { loadAll } from './data/loadData.js';
import { DISCLAIMER, NO_MATCH, refusalFor, WALKTHROUGH_VERSION } from './policy.js';
import { getCanteens } from './db.js';

export const coverage = JSON.parse(readFileSync(new URL('../data/coverage.json', import.meta.url), 'utf8'));
const normalise = (s) => s.trim().toLowerCase().replace(/[.!?。！？]+$/, '');

function cachedAnswer(query, demo) {
  let snapshots;
  try {
    snapshots = JSON.parse(readFileSync(new URL('../data/walkthrough.json', import.meta.url), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  if (snapshots.dataHash !== loadAll().dataHash) return null;
  if (snapshots.policyVersion !== WALKTHROUGH_VERSION) return null;
  const answer = snapshots.answers.find((a) => normalise(a.query) === normalise(query) && a.meta.demo === demo);
  if (!answer) return null;
  return {
    ...answer, query, mode: 'cached', cachedAt: snapshots.createdAt,
    meta: { ...answer.meta, snapshotAt: snapshots.evaluatedAt },
    notice: `Cached walkthrough evaluated at ${snapshots.evaluatedAt}, saved ${snapshots.createdAt}; not current opening status. ${answer.notice || ''}`,
  };
}

export async function recommend(query, {
  now = nowInHK(), demo = false, parser = parseIntent, allowCache = true,
} = {}) {
  const base = {
    ok: true, query, results: [], mode: 'local', intent: null, disclaimer: DISCLAIMER, coverage,
    meta: { evaluated: 0, totalMatches: 0, relaxed: [], sort: 'best_match', checkTime: now.hhmm, dayName: now.dayName, demo },
  };
  const refusal = refusalFor(query);
  if (refusal) return { ...base, ...refusal };
  const named = query.match(/\bstall (?:named|called)\s+["']?(.+?)["']?[.!?]?$/i);
  if (named && !getCanteens().some((c) => c.menu.some((m) => m.stall.toLowerCase() === named[1].toLowerCase()))) {
    return { ...base, reason: 'no_match', notice: NO_MATCH };
  }

  const llm = await parser(query);
  if (!llm.ok) {
    const cached = allowCache ? cachedAnswer(query, demo) : null;
    if (cached) return { ...base, ...cached, llm };
    return { ...base, ok: false, offline: true, llm };
  }
  const validated = validateIntent(llm.intent);
  if (!validated.ok) {
    return { ...base, ok: false, offline: true, llm: {
      ...llm, ok: false, error: { code: 'invalid_schema', message: validated.errors.join('; ') },
    } };
  }
  const { intent } = validated;
  if (intent.refusal) {
    const examples = { allergen_refused: 'allergen safety', medical_refused: 'medical advice', ordering_refused: 'order food' };
    return { ...base, ...refusalFor(examples[intent.refusal]), intent, llm };
  }
  // Enforce explicitly written restrictions even if the parser omitted them.
  const requiredDiets = [
    [/\bhalal\b|清真/i, 'halal'], [/\bvegetarian\b|素食/i, 'vegetarian'], [/\bvegan\b|純素|纯素/i, 'vegan'],
    [/\bgluten[- ]free\b|無麩質|无麸质/i, 'gluten_free'],
  ];
  const guarded = validateIntent({
    ...intent, diets: [...new Set([...intent.diets, ...requiredDiets.filter(([re]) => re.test(query)).map(([, d]) => d)])],
  }).intent;
  if (/\b(tomorrow|yesterday|holidays?|next (?:week|month)|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\b\d{4}-\d{2}-\d{2}\b|明天|明日|昨天|假期|下星期|星期|週末|周末/i.test(query)) {
    guarded.unsupported.push('Only regular hours for today are supported; future dates and holidays require staff confirmation.');
  }
  if (!hasConstraints(guarded)) {
    return { ...base, reason: 'no_preferences', notice: 'Please specify a diet, cuisine, time or location.', intent: guarded, llm };
  }
  const result = search(guarded, { now, demo });
  return {
    ...base, ...result, mode: 'live', intent: guarded, llm,
    reason: result.results.length ? null : 'no_match',
    notice: result.results.length
      ? (demo ? 'Demonstration mode: inspect each item verification status; unverified dishes are not dietary recommendations.' : null)
      : `${NO_MATCH}${guarded.unsupported.length ? ` Unsupported requirements: ${guarded.unsupported.join('; ')}` : ''}`,
  };
}
