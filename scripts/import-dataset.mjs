#!/usr/bin/env node
/**
 * Import a fact-checked dataset into data/.
 *
 * The three source files are plain JSON. This script exists so the import is
 * reproducible and so the opening hours are checked against the per-outlet
 * findings in coverage.json rather than trusted blindly: the findings state the
 * schedule in prose ("Mon-Fri 07:30-21:00, Sat 07:30-14:30, Sun/PH closed"), and
 * a hand-written `hours` array is easy to shift by one day.
 *
 *   node scripts/import-dataset.mjs                 # report only, writes nothing
 *   node scripts/import-dataset.mjs --write         # write data/{canteens,vocab,coverage}.json
 *   node scripts/import-dataset.mjs --write --from ~/Desktop
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DATA_DIR, loadDataset } from '../server/data/loadData.js';
import { validSource } from '../server/policy.js';

const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const fromIndex = argv.indexOf('--from');
const SOURCE_DIR = fromIndex >= 0 ? argv[fromIndex + 1] : join(homedir(), 'Desktop');

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const LONG = {
  sunday: 'sun', monday: 'mon', tuesday: 'tue', wednesday: 'wed',
  thursday: 'thu', friday: 'fri', saturday: 'sat',
};

const readSource = (name) => JSON.parse(readFileSync(join(SOURCE_DIR, name), 'utf8').replace(/^\uFEFF/, '').trim());

const dayIndex = (token) => {
  const key = String(token).toLowerCase();
  const short = LONG[key] || (DAYS.includes(key) ? key : null);
  return short == null ? null : DAYS.indexOf(short);
};

const isTime = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const padTime = (s) => {
  const [h, m] = s.split(':');
  return `${h.padStart(2, '0')}:${m}`;
};

/** "Mon-Fri" / "Sat & PH (excl. Sun)" / "Sun/PH" -> Set of day numbers, or null. */
function daysFor(spec) {
  const excluded = new Set();
  for (const m of spec.matchAll(/\(excl\.?\s*([^)]*)\)/gi)) {
    for (const word of m[1].split(/[^a-z]+/i)) {
      const d = dayIndex(word);
      if (d != null) excluded.add(d);
    }
  }

  const cleaned = spec
    .replace(/\(excl\.?[^)]*\)/gi, ' ')
    .replace(/\bP\.?H\.?\b/gi, ' ')
    .trim();

  const days = new Set();
  for (const part of cleaned.split(/\s*(?:&|\/|\band\b)\s*/i)) {
    const token = part.trim().replace(/[.,]/g, '');
    if (!token) continue;

    const range = token.match(/^([a-z]+)\s*[-–]\s*([a-z]+)$/i);
    if (range) {
      const start = dayIndex(range[1]);
      const end = dayIndex(range[2]);
      if (start == null || end == null) return null;
      let cursor = start;
      for (let step = 0; step < 7; step += 1) {
        days.add(cursor);
        if (cursor === end) break;
        cursor = (cursor + 1) % 7;
      }
      continue;
    }

    const single = dayIndex(token);
    if (single == null) return null;
    days.add(single);
  }

  for (const d of excluded) days.delete(d);
  // An empty set is legitimate: "PH closed" names no weekday at all.
  return days;
}

const CLAUSE_RE = /^(.+?)\s+(closed|([01]?\d|2[0-3]):[0-5]\d\s*[-–]\s*([01]?\d|2[0-3]):[0-5]\d)\.?$/i;

/**
 * Read the schedule out of a coverage finding.
 * Returns a 7-slot array, or null when the finding states no parseable hours.
 */
function hoursFromFinding(finding) {
  const at = finding.search(/\bHours?\s*:/i);
  if (at < 0) return null;

  const schedule = finding.slice(at).replace(/^Hours?\s*:/i, '').split(/\bContact\s*:|\bNote\s*:/i)[0];
  const hours = Array(7).fill(null);
  let applied = 0;

  for (const raw of schedule.split(/\s*,\s*|\s+and\s+/i)) {
    // Drop a trailing gloss like "07:30-21:30 (open 7 days including public
    // holidays)" — but keep "(excl. Sun)", which sits mid-clause.
    const clause = raw.trim()
      .replace(/[.\s]+$/, '')
      .replace(/\s*\([^)]*\)\s*$/, '')
      .replace(/[.\s]+$/, '');
    if (!clause) continue;

    const m = clause.match(CLAUSE_RE);
    if (!m) break; // trailing prose such as "Last orders 30 min before closing"

    const days = daysFor(m[1]);
    if (!days) return null;

    const value = /^closed$/i.test(m[2])
      ? null
      : m[2].split(/\s*[-–]\s*/).map((t) => padTime(t.trim()));
    for (const day of days) hours[day] = value;
    applied += 1;
  }

  return applied ? hours : null;
}

const show = (hours) => hours.map((h) => (h ? h.join('-') : 'closed')).join('  ');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ----------------------------------------------------------------- import -- */

const dataset = readSource('canteen.txt');
const vocab = readSource('vocab.txt');
const coverage = readSource('coverage.txt');

if (!Array.isArray(dataset.canteens)) throw new Error('canteen.txt has no canteens array');
if (!Array.isArray(vocab.cuisines) || !Array.isArray(vocab.diets) || !Array.isArray(vocab.facets)) {
  throw new Error('vocab.txt must define cuisines, diets and facets');
}
if (!Array.isArray(coverage.reviewedOutlets)) throw new Error('coverage.txt has no reviewedOutlets array');

// The prose summary quotes venue and dish counts. Restate them from the data so
// they cannot drift the way a hand-typed count does.
const venueCount = dataset.canteens.length;
const dishCount = dataset.canteens.reduce((n, c) => n + c.menu.length, 0);
if (typeof coverage.summary === 'string') {
  const restated = coverage.summary
    .replace(/contains \d+ venues/, `contains ${venueCount} venues`)
    .replace(/\d+ menu items/, `${dishCount} menu items`);
  if (restated !== coverage.summary) {
    console.log(`coverage summary counts restated as ${venueCount} venues / ${dishCount} menu items`);
    coverage.summary = restated;
  }
}

const cuisineKeys = new Set(vocab.cuisines.map((c) => c.key));
const dietKeys = new Set(vocab.diets.map((d) => d.key));
const facetKeys = new Set(vocab.facets.map((f) => f.key));

let corrected = 0;
let unparsed = 0;
const problems = [];

for (const canteen of dataset.canteens) {
  const outlet = coverage.reviewedOutlets.find((o) => o.name === canteen.name);
  if (!outlet) problems.push(`${canteen.id}: no matching entry in coverage.reviewedOutlets`);

  const officialHours = outlet ? hoursFromFinding(outlet.finding) : null;
  if (!officialHours) {
    unparsed += 1;
    console.log(`?  ${canteen.id.padEnd(30)} findings state no parseable hours; kept as delivered`);
  } else if (!same(officialHours, canteen.hours)) {
    corrected += 1;
    console.log(`~  ${canteen.id}`);
    console.log(`   data was  ${show(canteen.hours)}`);
    console.log(`   findings  ${show(officialHours)}`);
    canteen.hours = officialHours;
  }

  if (!Array.isArray(canteen.hours) || canteen.hours.length !== 7) {
    problems.push(`${canteen.id}: hours must have 7 entries`);
  }
  for (const hour of canteen.hours) {
    if (hour === null) continue;
    if (!Array.isArray(hour) || hour.length !== 2 || !isTime(hour[0]) || !isTime(hour[1]) || hour[0] >= hour[1]) {
      problems.push(`${canteen.id}: malformed hours entry ${JSON.stringify(hour)}`);
    }
  }

  for (const key of canteen.cuisines) if (!cuisineKeys.has(key)) problems.push(`${canteen.id}: unknown cuisine "${key}"`);
  for (const key of canteen.tags) if (!facetKeys.has(key)) problems.push(`${canteen.id}: unknown tag "${key}"`);
  if (canteen.verified && !(canteen.sources || []).length) problems.push(`${canteen.id}: verified without sources`);
  for (const source of canteen.sources || []) if (!validSource(source)) problems.push(`${canteen.id}: invalid venue source ${JSON.stringify(source.url)}`);

  if (!Array.isArray(canteen.menu) || canteen.menu.length === 0) problems.push(`${canteen.id}: empty menu`);

  for (const dish of canteen.menu) {
    for (const key of dish.cuisines) if (!cuisineKeys.has(key)) problems.push(`${canteen.id} / ${dish.name}: unknown cuisine "${key}"`);
    for (const key of dish.dietary_tags) if (!dietKeys.has(key)) problems.push(`${canteen.id} / ${dish.name}: unknown diet "${key}"`);
    if (dish.price !== null && (typeof dish.price !== 'number' || dish.price <= 0)) problems.push(`${canteen.id} / ${dish.name}: bad price ${dish.price}`);
  }
}

const ids = dataset.canteens.map((c) => c.id);
const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
if (duplicates.length) problems.push(`duplicate ids: ${[...new Set(duplicates)].join(', ')}`);

// The app's own loader is the authority on shape. Run it before writing anything.
try {
  const loaded = loadDataset(vocab, dataset);
  console.log(`\nloader accepted ${loaded.canteens.length} venues and ${loaded.canteens.reduce((n, c) => n + c.menu.length, 0)} dishes`);
} catch (err) {
  problems.push(`loader rejected the dataset: ${err.message}`);
}

const dishes = dataset.canteens.flatMap((c) => c.menu);
console.log(`hours corrected from findings: ${corrected}`);
console.log(`hours not stated in findings:   ${unparsed}`);
console.log(`venues: ${dataset.canteens.length}   dishes: ${dishes.length}   venue-verified: ${dataset.canteens.filter((c) => c.verified).length}   dish-verified: ${dishes.filter((d) => d.verified).length}`);

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exitCode = 1;
}

if (!WRITE) {
  console.log('\nReport only. Re-run with --write to update data/.');
} else if (problems.length) {
  console.error('\nRefusing to write while problems remain.');
  process.exitCode = 1;
} else {
  const files = { 'canteens.json': dataset, 'vocab.json': vocab, 'coverage.json': coverage };
  for (const [name, value] of Object.entries(files)) {
    writeFileSync(join(DATA_DIR, name), `${JSON.stringify(value, null, 2)}\n`);
    console.log(`wrote data/${name}`);
  }
}