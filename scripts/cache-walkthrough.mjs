import { writeFileSync } from 'node:fs';
import { loadAll } from '../server/data/loadData.js';
import { validateIntent } from '../server/schema.js';
import { search } from '../server/search.js';
import { DISCLAIMER, NO_MATCH, WALKTHROUGH_VERSION } from '../server/policy.js';
import { closeDb } from '../server/db.js';

const samples = [
  ['I need a cheap vegetarian lunch near the Main Library before 2pm.', { diets: ['vegetarian'], cuisines: ['vegetarian'], near: 'main_library', arrive_by: '14:00', meal: 'lunch', price_preference: 'cheap' }],
  ['I want noodles near Centennial Campus.', { cuisines: ['noodles'], near: 'centennial_campus', open_now: true }],
  ['Something quick and open now for coffee and a snack.', { cuisines: ['coffee', 'snack'], keywords: ['quick'], open_now: true, meal: 'snack' }],
  ['Halal dinner under 80 dollars with a friend.', { diets: ['halal'], max_price_hkd: 80, meal: 'dinner' }],
];
const now = { day: 5, dayName: 'Fri', minutes: 750, hhmm: '12:30' };
const answers = samples.flatMap(([query, raw]) => [false, true].map((demo) => {
  const { intent } = validateIntent(raw);
  const result = search(intent, { now, demo });
  return {
    ok: true, query, intent, ...result, disclaimer: DISCLAIMER,
    reason: result.results.length ? null : 'no_match',
    notice: result.results.length ? 'Unverified demonstration data, not dietary recommendations.' : NO_MATCH,
  };
}));
writeFileSync(new URL('../data/walkthrough.json', import.meta.url), JSON.stringify({
  createdAt: new Date().toISOString(), evaluatedAt: '2026-10-23T12:30:00+08:00',
  policyVersion: WALKTHROUGH_VERSION, dataHash: loadAll().dataHash, answers,
}, null, 2) + '\n');
closeDb();
console.log('Saved eight explicitly dated walkthrough snapshots (four queries, two modes). No model API was called.');
