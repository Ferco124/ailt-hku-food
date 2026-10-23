/**
 * Data access layer — SQLite via node:sqlite (built in, no dependency).
 *
 * Everything the app knows about canteens and landmarks comes from here. The
 * database is a *projection* of data/canteens.json + data/vocab.json: it is
 * rebuilt automatically when either file's content changes, or when the schema
 * version below is bumped. Nothing on the request path reads JSON directly.
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { toMinutes, toHHMM } from './time.js';
import { loadAll, deriveTags } from './data/loadData.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..');

export const DB_PATH = process.env.DB_PATH
  ? process.env.DB_PATH
  : join(ROOT, 'data', 'canteens.db');

const SCHEMA_PATH = join(__dirname, 'schema.sql');

/**
 * Bump when schema.sql changes in a way `CREATE TABLE IF NOT EXISTS` cannot
 * apply to an existing file (new/renamed columns, new tables). db.js rebuilds
 * from scratch on the next open, preserving the search log.
 */
export const SCHEMA_VERSION = 5;

const TABLES = [
  'canteen_menu', 'canteen_sources', 'canteen_hours', 'canteen_tags',
  'canteen_diets', 'canteen_cuisines', 'canteens', 'landmarks',
];

const CJK_RE = /[\u3400-\u9FFF\uF900-\uFAFF]+/g;

let db = null;
let bundle = null;

/** Loaded once per process; a restart is the only way to pick up new JSON. */
function data() {
  if (!bundle) bundle = loadAll();
  return bundle;
}

/* ------------------------------------------------------------- lifecycle -- */

/** Open (once), make sure the schema exists, and keep it in sync with the JSON. */
export function getDb() {
  if (db) return db;

  if (DB_PATH !== ':memory:') {
    mkdirSync(dirname(DB_PATH), { recursive: true });
  }

  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA foreign_keys = ON');
  // Default rollback journal rather than WAL: writes here are tiny and rare, and
  // a single self-contained .db file is easier to copy, inspect and reset.
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));

  syncFromJson();

  return db;
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

function readMeta(key) {
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row?.value ?? null;
  } catch {
    // meta itself was just created (empty) — treat as "no value yet".
    return null;
  }
}

function writeMeta(key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

/**
 * Bring the file in line with the JSON.
 *   - schema version differs → rebuild data tables, preserving search_log.
 *   - data hash differs      → re-import canteen rows, keep search_log.
 */
function syncFromJson() {
  const current = data();

  if (readMeta('schema_version') !== String(SCHEMA_VERSION)) {
    rebuildSchema();
    seedFromData(current);
    return;
  }

  const { n } = db.prepare('SELECT COUNT(*) AS n FROM canteens').get();
  if (n === 0 || readMeta('data_hash') !== current.dataHash) {
    seedFromData(current);
  }
}

/** Drop every table and re-apply schema.sql — the only path that changes shape. */
function rebuildSchema() {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    for (const table of TABLES) db.exec(`DROP TABLE IF EXISTS ${table}`);
    db.exec('DROP TABLE IF EXISTS meta');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
}

/* ---------------------------------------------------------------- import -- */

/** Wipe and repopulate from the JSON files. Used by `npm run db:reset`. */
export function seed() {
  seedFromData(data());
}

export function seedFromData(current) {
  const database = db ?? getDb();

  database.exec('BEGIN');
  try {
    // Order matters only because of foreign keys; CASCADE would cover it too.
    for (const table of [
      'canteen_menu', 'canteen_sources', 'canteen_hours', 'canteen_tags',
      'canteen_diets', 'canteen_cuisines', 'canteens', 'landmarks',
    ]) {
      database.exec(`DELETE FROM ${table}`);
    }

    const insLandmark = database.prepare(
      'INSERT INTO landmarks (key, label, lat, lng) VALUES (?, ?, ?, ?)'
    );
    for (const [key, l] of Object.entries(current.landmarks)) {
      insLandmark.run(key, l.label, l.lat, l.lng);
    }

    const insCanteen = database.prepare(`
      INSERT INTO canteens
        (id, name, name_zh, venue, zone, lat, lng, price_level, avg_price, rating, emoji, image, overview, verified)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insCuisine = database.prepare(
      'INSERT INTO canteen_cuisines (canteen_id, cuisine) VALUES (?, ?)'
    );
    const insDiet = database.prepare('INSERT INTO canteen_diets (canteen_id, diet) VALUES (?, ?)');
    const insTag = database.prepare('INSERT INTO canteen_tags (canteen_id, tag) VALUES (?, ?)');
    const insHours = database.prepare(
      'INSERT INTO canteen_hours (canteen_id, day_of_week, opens_min, closes_min) VALUES (?, ?, ?, ?)'
    );
    const insMenu = database.prepare(
      `INSERT INTO canteen_menu (canteen_id, position, name, price, stall, verified,
        is_certified_halal, is_vegetarian, ingredients_listed, dietary_tags, dietary_tags_source, sources, cuisines)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insSource = database.prepare(
      'INSERT INTO canteen_sources (canteen_id, position, label, url, checked_at) VALUES (?, ?, ?, ?, ?)'
    );

    for (const c of current.canteens) {
      const nameZh = (c.name.match(CJK_RE) ?? []).join(' ') || null;
      insCanteen.run(
        c.id, c.name, nameZh, c.venue, c.zone, c.lat, c.lng,
        c.priceLevel, c.avgPrice, c.rating, c.emoji ?? null, c.image ?? null, c.overview ?? null, Number(c.verified)
      );
      for (const cuisine of c.cuisines ?? []) insCuisine.run(c.id, cuisine);
      for (const diet of c.diets ?? []) insDiet.run(c.id, diet);

      // Authored tags plus the ones a canteen earns from its own hours.
      const tags = [...new Set([...(c.tags ?? []), ...deriveTags(c)])].sort();
      for (const tag of tags) insTag.run(c.id, tag);

      (c.hours ?? []).forEach((slot, day) => {
        if (!slot) return;
        insHours.run(c.id, day, toMinutes(slot[0]), toMinutes(slot[1]));
      });

      (c.menu ?? []).forEach((m, i) => insMenu.run(c.id, i, m.name, m.price, m.stall, Number(m.verified),
        m.is_certified_halal == null ? null : Number(m.is_certified_halal),
        m.is_vegetarian == null ? null : Number(m.is_vegetarian),
        JSON.stringify(m.ingredients_listed), JSON.stringify(m.dietary_tags),
        JSON.stringify(m.dietary_tags_source), JSON.stringify(m.sources), JSON.stringify(m.cuisines)));
      (c.sources ?? []).forEach((s, i) =>
        insSource.run(c.id, i, s.label, s.url ?? null, s.checkedAt ?? null)
      );
    }

    writeMeta('schema_version', SCHEMA_VERSION);
    writeMeta('data_hash', current.dataHash);
    writeMeta('canteens', current.canteens.length);
    writeMeta('imported_at', new Date().toISOString());

    database.exec('COMMIT');
  } catch (err) {
    database.exec('ROLLBACK');
    throw err;
  }
}

/* ------------------------------------------------------------------ read -- */

/**
 * All canteens, assembled into the shape the search engine expects:
 * cuisines/diets/tags as arrays, hours as 7 entries of ["HH:MM","HH:MM"] | null,
 * plus menu and sources as ordered arrays.
 *
 * A handful of queries total rather than one per canteen — the joins are done
 * here in JS so the result stays a plain object graph.
 */
export function getCanteens() {
  const database = getDb();

  const rows = database.prepare(`
    SELECT id, name, name_zh, venue, zone, lat, lng, price_level, avg_price, rating,
           emoji, image, overview, verified
    FROM canteens ORDER BY name
  `).all();

  const group = (sql, field) => {
    const map = new Map();
    for (const r of database.prepare(sql).all()) {
      if (!map.has(r.canteen_id)) map.set(r.canteen_id, []);
      map.get(r.canteen_id).push(r[field]);
    }
    return map;
  };

  const cuisines = group('SELECT canteen_id, cuisine FROM canteen_cuisines ORDER BY cuisine', 'cuisine');
  const diets = group('SELECT canteen_id, diet FROM canteen_diets ORDER BY diet', 'diet');
  const tags = group('SELECT canteen_id, tag FROM canteen_tags ORDER BY tag', 'tag');

  const hours = new Map();
  for (const r of database
    .prepare('SELECT canteen_id, day_of_week, opens_min, closes_min FROM canteen_hours')
    .all()) {
    if (!hours.has(r.canteen_id)) hours.set(r.canteen_id, Array(7).fill(null));
    hours.get(r.canteen_id)[r.day_of_week] = [toHHMM(r.opens_min), toHHMM(r.closes_min)];
  }

  const menu = new Map();
  for (const r of database
    .prepare('SELECT * FROM canteen_menu ORDER BY canteen_id, position')
    .all()) {
    if (!menu.has(r.canteen_id)) menu.set(r.canteen_id, []);
    menu.get(r.canteen_id).push({
      name: r.name, price: r.price, stall: r.stall, verified: Boolean(r.verified),
      cuisines: JSON.parse(r.cuisines),
      is_certified_halal: r.is_certified_halal == null ? null : Boolean(r.is_certified_halal),
      is_vegetarian: r.is_vegetarian == null ? null : Boolean(r.is_vegetarian),
      ingredients_listed: JSON.parse(r.ingredients_listed), dietary_tags: JSON.parse(r.dietary_tags),
      dietary_tags_source: JSON.parse(r.dietary_tags_source), sources: JSON.parse(r.sources),
    });
  }

  const sources = new Map();
  for (const r of database
    .prepare('SELECT canteen_id, label, url, checked_at FROM canteen_sources ORDER BY canteen_id, position')
    .all()) {
    if (!sources.has(r.canteen_id)) sources.set(r.canteen_id, []);
    sources.get(r.canteen_id).push({ label: r.label, url: r.url, checkedAt: r.checked_at });
  }

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    nameZh: r.name_zh,
    venue: r.venue,
    zone: r.zone,
    lat: r.lat,
    lng: r.lng,
    cuisines: cuisines.get(r.id) ?? [],
    diets: diets.get(r.id) ?? [],
    priceLevel: r.price_level,
    avgPrice: r.avg_price,
    rating: r.rating,
    hours: hours.get(r.id) ?? Array(7).fill(null),
    emoji: r.emoji,
    image: r.image,
    tags: tags.get(r.id) ?? [],
    overview: r.overview,
    verified: Boolean(r.verified),
    menu: menu.get(r.id) ?? [],
    sources: sources.get(r.id) ?? [],
  }));
}

/** Landmarks keyed by key, e.g. landmarks.main_library.label */
export function getLandmarks() {
  const out = {};
  for (const r of getDb().prepare('SELECT key, label, lat, lng FROM landmarks').all()) {
    out[r.key] = { label: r.label, lat: r.lat, lng: r.lng };
  }
  return out;
}

/** Loaded once at import — landmarks are static within a run. */
export const landmarks = getLandmarks();

/* ----------------------------------------------------------------- write -- */

export function logSearch({ query, mode, intent, resultIds, latencyMs }) {
  try {
    getDb()
      .prepare(
        `INSERT INTO search_log (query, mode, intent_json, result_ids, latency_ms)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        String(query).slice(0, 300),
        mode,
        intent ? JSON.stringify(intent) : null,
        resultIds ? JSON.stringify(resultIds) : null,
        Math.round(latencyMs ?? 0)
      );
  } catch (err) {
    console.error('[search-log] Cannot persist search:', err);
  }
}

/* ----------------------------------------------------------------- stats -- */

export function getStats() {
  const database = getDb();
  const one = (sql, ...p) => database.prepare(sql).get(...p);

  const counts = {
    canteens: one('SELECT COUNT(*) AS n FROM canteens').n,
    landmarks: one('SELECT COUNT(*) AS n FROM landmarks').n,
    cuisines: one('SELECT COUNT(DISTINCT cuisine) AS n FROM canteen_cuisines').n,
    facets: one('SELECT COUNT(DISTINCT tag) AS n FROM canteen_tags').n,
    menuItems: one('SELECT COUNT(*) AS n FROM canteen_menu').n,
    sources: one('SELECT COUNT(*) AS n FROM canteen_sources').n,
    openingSlots: one('SELECT COUNT(*) AS n FROM canteen_hours').n,
    searches: one('SELECT COUNT(*) AS n FROM search_log').n,
  };

  const byMode = database
    .prepare('SELECT mode, COUNT(*) AS n FROM search_log GROUP BY mode ORDER BY n DESC')
    .all()
    .map((r) => ({ mode: r.mode, count: r.n }));

  const avg = one('SELECT AVG(latency_ms) AS a FROM search_log WHERE latency_ms > 0');
  const recent = database
    .prepare('SELECT query, mode, latency_ms, created_at FROM search_log ORDER BY id DESC LIMIT 5')
    .all();

  const topCuisines = database
    .prepare(`
      SELECT cuisine, COUNT(*) AS n FROM canteen_cuisines
      GROUP BY cuisine ORDER BY n DESC, cuisine LIMIT 6
    `)
    .all()
    .map((r) => ({ cuisine: r.cuisine, count: r.n }));

  return {
    db: {
      path: DB_PATH,
      driver: 'node:sqlite',
      schemaVersion: Number(readMeta('schema_version')),
      dataHash: readMeta('data_hash'),
      importedAt: readMeta('imported_at'),
    },
    counts,
    byMode,
    avgLatencyMs: avg?.a ? Math.round(avg.a) : null,
    topCuisines,
    recentSearches: recent,
  };
}

/** Row counts per table — used by the migration script to verify the copy. */
export function tableCounts() {
  const database = getDb();
  const tables = [
    'landmarks', 'canteens', 'canteen_cuisines',
    'canteen_diets', 'canteen_tags', 'canteen_hours',
    'canteen_menu', 'canteen_sources', 'search_log',
  ];
  return Object.fromEntries(
    tables.map((t) => [t, database.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n])
  );
}

export const dbFileExists = () => existsSync(DB_PATH);