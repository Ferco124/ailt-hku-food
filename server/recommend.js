import { readFileSync } from 'node:fs';
import { parseIntent } from './llm.js';
import { hasConstraints, validateIntent } from './schema.js';
import { search } from './search.js';
import { nowInHK } from './time.js';
import { loadAll } from './data/loadData.js';
import { DISCLAIMER, NO_MATCH, outletMatches, refusalFor, WALKTHROUGH_VERSION } from './policy.js';
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

/**
 * A missing outlet is not the same answer as "nothing matches your
 * preferences". Reusing the generic NO_MATCH copy for a name would read as "no
 * food like that exists on campus", when all that happened is that the
 * directory does not carry that outlet — so this says which name is unknown
 * and what the app can do instead.
 */
function unknownVenueNotice(name, total) {
  const size = total ? ` (${total} outlets are listed)` : '';
  return `I don't have an outlet called "${name}" in the directory${size}. Try part of the name, or describe the food you want instead.`;
}

export async function recommend(query, {
  now = nowInHK(), demo = false, parser = parseIntent, allowCache = true, limit,
} = {}) {
  const base = {
    ok: true, query, results: [], mode: 'local', intent: null, disclaimer: DISCLAIMER, coverage,
    meta: { evaluated: 0, totalMatches: 0, relaxed: [], sort: 'best_match', checkTime: now.hhmm, dayName: now.dayName, demo },
  };
  const refusal = refusalFor(query);
  if (refusal) return { ...base, ...refusal };
  const named = query.match(/\bstall (?:named|called)\s+["']?(.+?)["']?[.!?]?$/i);
  const directory = getCanteens();
  if (named && !directory.some((c) => outletMatches(named[1], c))) {
    return { ...base, reason: 'no_match', notice: unknownVenueNotice(named[1].trim(), directory.length) };
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
  // The page size is a presentation choice: the browser asks for the whole
  // qualifying set so it can sort and reveal more without another model call.
  const limitOpt = Number.isInteger(limit) ? { limit } : {};
  let result = search(guarded, { now, demo, ...limitOpt });
  // "Open now" asked at 22:00 has an honest but useless answer: nothing. When
  // the hours filter alone emptied the set, return the same matches with their
  // real status instead of a dead end. Every other hard filter still applies —
  // "no reviewed vegetarian dish" must keep saying exactly that — so this only
  // ever resurrects results that failed on opening hours and nothing else.
  if (!result.results.length && guarded.open_now && !guarded.arrive_by) {
    const anyTime = search(guarded, { now, demo, includeClosed: true, ...limitOpt });
    if (anyTime.results.length) {
      result = { ...anyTime, meta: { ...anyTime.meta, scheduleOnly: 'closed_now' } };
    }
  }
  // `search` may move a name-like word ("subway") out of `unsupported` and into
  // the keywords. Report the intent that was actually searched, not the raw one.
  const effectiveIntent = result.intent ?? guarded;
  const venueBasis = result.results.filter((r) => r.dietBasis === 'venue').length;
  const hintCount = result.hints?.results?.length ?? 0;
  const notices = [];
  if (demo) notices.push('Demonstration mode: inspect each item verification status; unverified dishes are not dietary recommendations.');
  if (venueBasis) {
    notices.push(`${venueBasis} result(s) match at outlet level only: the outlet lists ${effectiveIntent.diets.join(', ')} options, but individual dishes are not reviewed.`);
  }
  const closed = closedScheduleNote(result, now);
  if (closed) notices.push(closed);
  // A name that matched no outlet at all is a different failure from a name
  // that matched one which then failed a diet or budget constraint; only the
  // first one is the directory's gap rather than the user's filter.
  const venueMissed = effectiveIntent.requested_stall && result.meta.venueMatched === 0;
  return {
    ...base, ...result, mode: 'live', intent: effectiveIntent, llm,
    reason: result.results.length ? null : 'no_match',
    notice: result.results.length
      ? (notices.join(' ') || null)
      : `${venueMissed
        ? unknownVenueNotice(effectiveIntent.requested_stall, result.meta.evaluated)
        : NO_MATCH}${effectiveIntent.unsupported.length ? ` Unsupported requirements: ${effectiveIntent.unsupported.join('; ')}` : ''}${dietNote(effectiveIntent)}${
        hintCount ? ` ${hintCount} outlet(s) below may serve vegetarian dishes; none of them states it.` : ''
      }`,
  };
}

/**
 * Why a non-empty list contains nothing that is open right now. The distinction
 * matters: with `scheduleOnly` the user asked for somewhere open and got the
 * matches anyway, so the note must not read like a live availability promise.
 * Returns '' when at least one match is open, or when nothing matched at all.
 */
function closedScheduleNote(result, now) {
  const meta = result.meta ?? {};
  if (!result.results.length || !meta.allClosed) return '';
  const next = meta.nextOpen
    ? `the next scheduled opening is ${meta.nextOpen.daysAhead === 1 ? 'tomorrow' : meta.nextOpen.dayName} ${meta.nextOpen.opensAt}`
    : 'no opening is recorded for the coming week';
  const since = meta.latestClose ? `the last close today was ${meta.latestClose}` : 'these have closed for the day';
  if (meta.scheduleOnly === 'closed_now') {
    return `Nothing is open at ${now.hhmm} in Hong Kong — ${since}. These are the matches for your request, listed with their real hours rather than as places open now; ${next}. Hours are the regular schedule, not a live check.`;
  }
  return `None of these matches is open at ${now.hhmm} in Hong Kong — ${since}; ${next}. Hours are the regular schedule, not a live check.`;
}

/**
 * A diet filter can be applied two ways: a reviewed dish, or an outlet that is
 * certified/listed for it. When neither exists the answer is genuinely empty,
 * and the note must say which claim is missing rather than implying the food
 * does not exist on campus.
 */
function dietNote(intent) {
  if (!intent.diets.length) return '';
  const label = intent.diets.map((d) => d.replace(/_/g, ' ')).join(', ');
  return ` No outlet in the dataset is certified or listed for ${label}, so this filter cannot be applied to representative menu items.`;
}
