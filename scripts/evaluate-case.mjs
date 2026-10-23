import { isDeepStrictEqual } from 'node:util';
import { hasEvidence, matchesDiets } from '../server/policy.js';
import { openStatus, distanceToLandmark } from '../server/geo.js';
import { toMinutes } from '../server/time.js';

export function gradeCase(expected, response, records, now) {
  const failures = [];
  const check = (condition, message) => { if (!condition) failures.push(message); };
  check(response.ok === true && response.mode !== 'cached' && response.meta?.demo !== true,
    'Must be a successful non-demo, non-cached response');
  check(typeof response.disclaimer === 'string' && response.disclaimer.includes('not a safety guarantee'),
    'Missing safety disclaimer');
  const results = response.results;
  check(Array.isArray(results), 'Missing results array');
  if (!Array.isArray(results)) return { pass: false, failures };
  if (expected.reason) {
    check(response.reason === expected.reason && results.length === 0, 'Wrong refusal/no-match outcome');
    check(typeof response.notice === 'string' && response.notice.length > 0, 'Missing refusal explanation');
    return { pass: failures.length === 0, failures };
  }
  check(results.length > 0, 'Positive query returned no verified items');
  for (const [key, value] of Object.entries(expected)) {
    check(Array.isArray(value)
      ? value.every((v) => response.intent?.[key]?.includes(v))
      : response.intent?.[key] === value, `Intent omitted expected ${key}`);
  }
  for (const result of results) {
    const record = records.find((r) => r.id === result.id);
    check(Boolean(record?.verified), `Unknown or unverified canteen: ${result.id}`);
    if (!record) continue;
    check(result.name === record.name && result.venue === record.venue, 'Canteen identity differs from dataset');
    check(isDeepStrictEqual(result.sources, record.sources), 'Venue source evidence differs from dataset');
    check(Array.isArray(result.menu) && result.menu.length > 0, 'Missing matching dishes');
    for (const item of result.menu || []) {
      check(record.menu.some((candidate) => isDeepStrictEqual(candidate, item)),
        `Dish/stall/evidence not present in cited canteen: ${item.name}`);
      check(hasEvidence(item) && matchesDiets(item, expected.diets || []), 'Missing item verification or dietary fit');
      if (expected.cuisines?.length) check(expected.cuisines.some((c) => item.cuisines.includes(c)), 'Wrong dish cuisine');
      if (expected.max_price_hkd != null) check(item.price != null && item.price <= expected.max_price_hkd, 'Dish price is unknown or exceeds budget');
      if (expected.requested_stall) check(item.stall === expected.requested_stall || record.name === expected.requested_stall, 'Wrong requested stall');
    }
    if (expected.zone) check(result.zone === expected.zone, 'Wrong campus area');
    if (expected.arrive_by || expected.open_now) {
      const status = openStatus(record, now, expected.arrive_by ? toMinutes(expected.arrive_by) : null);
      check(status.open, 'Venue is closed at required time');
      check(result.status?.open === status.open && result.status?.opensAt === status.opensAt &&
        result.status?.closesAt === status.closesAt, 'Returned hours differ from dataset');
    }
    if (expected.meal && !expected.arrive_by) {
      const slot = record.hours[now.day];
      const window = { breakfast: [420, 660], lunch: [660, 900], dinner: [1020, 1320], snack: [0, 1440] }[expected.meal];
      check(Boolean(slot && window && toMinutes(slot[0]) < window[1] && toMinutes(slot[1]) > window[0]),
        'Venue does not open during the expected meal window');
    }
    if (expected.near) {
      const minutes = distanceToLandmark(record, expected.near);
      check(result.walkFrom?.key === expected.near && result.walkMinutes === minutes, 'Wrong starting landmark or distance');
      if (expected.max_walk_minutes != null) check(minutes <= expected.max_walk_minutes, 'Walking limit exceeded');
    }
  }
  return { pass: failures.length === 0, failures };
}
