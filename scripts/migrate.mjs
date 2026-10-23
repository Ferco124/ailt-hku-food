#!/usr/bin/env node
/**
 * Projects data/canteens.json + data/vocab.json into SQLite and verifies it.
 *
 *   npm run migrate            # create/verify; brings the file in line with the JSON
 *   npm run db:reset           # drop everything and re-import from JSON
 *
 * Verification is the point: a migration that "runs without errors" but
 * silently loses rows is worse than one that fails loudly.
 */

import { getDb, getCanteens, seed, tableCounts, closeDb, DB_PATH, SCHEMA_VERSION } from '../server/db.js';
import { isDeepStrictEqual } from 'node:util';
import { loadAll, deriveTags, VOCAB_PATH, CANTEENS_PATH } from '../server/data/loadData.js';
import { CUISINES, DIETS, FACET_META } from '../server/data/vocab.js';

const RESET = process.argv.includes('--reset');
const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', B = '\x1b[1m', X = '\x1b[0m';

const bundle = loadAll();

console.log(`\n${B}HKU Canteen Finder — migrate${X}`);
console.log(`  ${D}target${X}  ${DB_PATH}`);
console.log(`  ${D}source${X}  ${CANTEENS_PATH} + ${VOCAB_PATH}`);

const db = getDb();

if (RESET) {
  seed();
  console.log(`  ${G}✓${X} rebuilt from data/canteens.json (--reset)`);
} else {
  console.log(`  ${Y}!${X} database ready — pass --reset to drop and re-import`);
}

// ---------------------------------------------------------------- verify ---
const counts = tableCounts();

const checks = [];
const check = (name, pass, detail = '') => checks.push({ name, pass, detail });

check('canteen rows match JSON', counts.canteens === bundle.canteens.length,
  `${counts.canteens} / ${bundle.canteens.length}`);

check('landmark rows match JSON', counts.landmarks === Object.keys(bundle.landmarks).length,
  `${counts.landmarks} / ${Object.keys(bundle.landmarks).length}`);

check('menu items match JSON', counts.canteen_menu === bundle.canteens.reduce((n, c) => n + c.menu.length, 0),
  `${counts.canteen_menu} rows`);

check('sources match JSON', counts.canteen_sources === bundle.canteens.reduce((n, c) => n + c.sources.length, 0),
  `${counts.canteen_sources} rows`);

check('schema version recorded', db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value === String(SCHEMA_VERSION),
  `expect ${SCHEMA_VERSION}`);

const noCuisine = db.prepare(`
  SELECT c.id FROM canteens c
  LEFT JOIN canteen_cuisines cc ON cc.canteen_id = c.id
  WHERE cc.cuisine IS NULL
`).all();
check('every canteen has ≥1 cuisine', noCuisine.length === 0,
  noCuisine.map((r) => r.id).join(', '));

const noHours = db.prepare(`
  SELECT c.id FROM canteens c
  LEFT JOIN canteen_hours h ON h.canteen_id = c.id
  WHERE h.day_of_week IS NULL
`).all();
check('every canteen has ≥1 opening slot', noHours.length === 0,
  noHours.map((r) => r.id).join(', '));

const noMenu = db.prepare(`
  SELECT c.id FROM canteens c
  LEFT JOIN canteen_menu m ON m.canteen_id = c.id
  WHERE m.name IS NULL
`).all();
check('every canteen has ≥1 menu item', noMenu.length === 0,
  noMenu.map((r) => r.id).join(', '));

const noSource = db.prepare(`
  SELECT c.id FROM canteens c
  LEFT JOIN canteen_sources s ON s.canteen_id = c.id
  WHERE s.label IS NULL
`).all();
check('every canteen has ≥1 source', noSource.length === 0,
  noSource.map((r) => r.id).join(', '));

const badImage = db.prepare("SELECT id FROM canteens WHERE image = ''").all();
check('images are usable or explicitly unknown', badImage.length === 0,
  badImage.map((r) => r.id).join(', '));

const badCuisine = db.prepare('SELECT DISTINCT cuisine FROM canteen_cuisines').all()
  .map((r) => r.cuisine).filter((c) => !CUISINES.includes(c));
check('cuisine values are in the vocabulary', badCuisine.length === 0, badCuisine.join(', '));

const badDiet = db.prepare('SELECT DISTINCT diet FROM canteen_diets').all()
  .map((r) => r.diet).filter((d) => !DIETS.includes(d));
check('diet values are in the vocabulary', badDiet.length === 0, badDiet.join(', '));

const badTag = db.prepare('SELECT DISTINCT tag FROM canteen_tags').all()
  .map((r) => r.tag).filter((t) => !FACET_META[t]);
check('tag values are known facets', badTag.length === 0, badTag.join(', '));

// Derived tags are computed from hours at import; prove the rule really ran.
const tagsByCanteen = new Map();
for (const r of db.prepare('SELECT canteen_id, tag FROM canteen_tags').all()) {
  if (!tagsByCanteen.has(r.canteen_id)) tagsByCanteen.set(r.canteen_id, new Set());
  tagsByCanteen.get(r.canteen_id).add(r.tag);
}
const missingDerived = [];
for (const c of bundle.canteens) {
  const have = tagsByCanteen.get(c.id) ?? new Set();
  for (const tag of deriveTags(c)) if (!have.has(tag)) missingDerived.push(`${c.id}:${tag}`);
}
check('derived tags present where expected', missingDerived.length === 0, missingDerived.join(', '));

const fk = db.prepare('PRAGMA foreign_key_check').all();
check('foreign keys intact', fk.length === 0, fk.length ? `${fk.length} violations` : '');

const integrity = db.prepare('PRAGMA integrity_check').get();
const integrityValue = Object.values(integrity ?? {})[0];
check('sqlite integrity_check', integrityValue === 'ok', String(integrityValue));

const restored = getCanteens();
check('all hours round-trip correctly', restored.every((c) =>
  isDeepStrictEqual(c.hours, bundle.canteens.find((r) => r.id === c.id).hours)));
check('all menu evidence round-trips correctly', restored.every((c) =>
  isDeepStrictEqual(c.menu, bundle.canteens.find((r) => r.id === c.id).menu)));

// ----------------------------------------------------------------- print ---
console.log(`\n${B}Tables${X}`);
for (const [table, n] of Object.entries(counts)) {
  console.log(`  ${table.padEnd(18)} ${String(n).padStart(4)}`);
}

console.log(`\n${B}Checks${X}`);
for (const c of checks) {
  const mark = c.pass ? `${G}✓${X}` : `${R}✗${X}`;
  console.log(`  ${mark} ${c.name}${c.detail ? `  ${D}(${c.detail})${X}` : ''}`);
}

const failed = checks.filter((c) => !c.pass);
closeDb();

if (failed.length) {
  console.log(`\n${R}${B}Migration failed${X} — ${failed.length} check(s) did not pass.\n`);
  process.exit(1);
}

console.log(
  `\n${G}${B}Migration OK${X} — ${counts.canteens} canteens, ${counts.landmarks} landmarks, ` +
  `${counts.canteen_menu} menu items, ${counts.canteen_sources} sources, ` +
  `${counts.canteen_hours} opening slots.\n`
);