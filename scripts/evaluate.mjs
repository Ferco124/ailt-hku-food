import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { recommend } from '../server/recommend.js';
import { hasEvidence } from '../server/policy.js';
import { gradeCase } from './evaluate-case.mjs';
import { getCanteens, closeDb } from '../server/db.js';
import { config } from '../server/config.js';

const cases = JSON.parse(readFileSync(new URL('../tests/cases.json', import.meta.url), 'utf8'));
const live = process.argv.includes('--live');
if (live && !config.hasKey) throw new Error('Live evaluation needs BAILIAN_API_KEY. Without --live, only local refusal cases are executed.');
const now = { day: 5, dayName: 'Fri', minutes: 750, hhmm: '12:30' };
const records = getCanteens();
const outcomes = [];
for (const c of cases) {
  if (!live && !c.expect.reason) {
    outcomes.push({ id: c.id, group: c.group, query: c.query, status: 'blocked', detail: 'Live parser and source-reviewed menu evidence required' });
    continue;
  }
  const response = await recommend(c.query, {
    now, allowCache: false, ...(live ? {} : { parser: async () => { throw new Error('Unexpected model call in local refusal evaluation'); } }),
  });
  const expected = c.expect;
  const { pass, failures } = gradeCase(expected, response, records, now);
  outcomes.push({ id: c.id, group: c.group, query: c.query, expected, status: pass ? 'pass' : 'fail', failures, response });
}
const groups = Object.fromEntries(['dietary', 'time_location', 'refusal'].map((group) => {
  const rows = outcomes.filter((r) => r.group === group);
  const passed = rows.filter((r) => r.status === 'pass').length;
  const required = group === 'refusal' ? 5 : group === 'dietary' ? 12 : 8;
  return [group, { total: rows.length, passed, required, blocked: rows.filter((r) => r.status === 'blocked').length, met: passed >= required }];
}));
const verifiedItems = records.flatMap((c) => c.menu).filter(hasEvidence).length;
const report = {
  executedAt: new Date().toISOString(), mode: live ? 'live-model' : 'local-safety-only',
  clock: now, groups, verifiedItems,
  ready: live && verifiedItems >= 50 && Object.values(groups).every((g) => g.met),
  limitation: 'Source content must be manually reviewed. A valid URL/date is evidence metadata, not automatic proof of truth. Synthetic unit tests are not this benchmark.',
  outcomes,
};
mkdirSync(new URL('../reports/', import.meta.url), { recursive: true });
writeFileSync(new URL('../reports/evaluation.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ groups, verifiedItems, ready: report.ready }, null, 2));
closeDb();
if (!report.ready) process.exitCode = 1;
