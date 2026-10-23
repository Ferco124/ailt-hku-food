/**
 * JSON data loader — the single place that reads the record files on disk.
 *
 * Two files under /data are the source of truth:
 *   data/vocab.json      closed vocabularies (cuisines, diets, facets)
 *   data/canteens.json   landmarks + canteens, with menus and sources
 *
 * Everything downstream (db.js, vocab.js, migrate.mjs) goes through here, so a
 * bad edit to either file fails loudly at load time rather than silently
 * producing a half-populated database.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { toMinutes } from '../time.js';
import { validSource } from '../policy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = join(__dirname, '..', '..', 'data');

export const VOCAB_PATH = join(DATA_DIR, 'vocab.json');
export const CANTEENS_PATH = join(DATA_DIR, 'canteens.json');

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

class DataError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DataError';
  }
}

function readJson(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new DataError(`Cannot read ${path}: ${err.message}`);
  }
  try {
    return { value: JSON.parse(text), text };
  } catch (err) {
    throw new DataError(`Invalid JSON in ${path}: ${err.message}`);
  }
}

const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

/* ------------------------------------------------------------------ vocab -- */

/** Load and validate data/vocab.json. Throws DataError on any problem. */
export function loadVocab() {
  const { value } = readJson(VOCAB_PATH);
  if (!isObject(value)) throw new DataError('vocab.json must be a JSON object');

  const section = (name) => {
    const list = value[name];
    if (!Array.isArray(list) || list.length === 0) {
      throw new DataError(`vocab.json: "${name}" must be a non-empty array`);
    }
    return list;
  };

  const keyed = (name, { synonyms = false } = {}) => {
    const seen = new Set();
    return section(name).map((entry, i) => {
      if (!isObject(entry)) throw new DataError(`vocab.json: ${name}[${i}] must be an object`);
      const { key, label, color } = entry;
      if (!isNonEmptyString(key)) throw new DataError(`vocab.json: ${name}[${i}] is missing "key"`);
      if (seen.has(key)) throw new DataError(`vocab.json: duplicate ${name} key "${key}"`);
      seen.add(key);
      if (!isNonEmptyString(label)) throw new DataError(`vocab.json: ${name} "${key}" is missing "label"`);
      const out = { key, label, color: isNonEmptyString(color) ? color : 't-blue' };
      if (synonyms) {
        const syn = entry.synonyms ?? [];
        if (!Array.isArray(syn) || syn.some((s) => !isNonEmptyString(s))) {
          throw new DataError(`vocab.json: facet "${key}" has a bad "synonyms" list`);
        }
        out.synonyms = syn.map((s) => s.trim().toLowerCase());
      }
      return out;
    });
  };

  return {
    cuisines: keyed('cuisines'),
    diets: keyed('diets'),
    facets: keyed('facets', { synonyms: true }),
  };
}

/* -------------------------------------------------------------- canteens -- */

/** Seven entries, Sunday first, each null or ["HH:MM", "HH:MM"]. */
function checkHours(id, hours) {
  if (!Array.isArray(hours) || hours.length !== 7) {
    throw new DataError(`canteens.json: "${id}" must have exactly 7 hours slots (Sun–Sat)`);
  }
  return hours.map((slot, day) => {
    if (slot == null) return null;
    if (!Array.isArray(slot) || slot.length !== 2) {
      throw new DataError(`canteens.json: "${id}" day ${day} hours must be [open, close] or null`);
    }
    const [open, close] = slot;
    if (!TIME_RE.test(open) || !TIME_RE.test(close)) {
      throw new DataError(`canteens.json: "${id}" day ${day} hours are not HH:MM`);
    }
    if (toMinutes(open) >= toMinutes(close)) {
      throw new DataError(`canteens.json: "${id}" day ${day} opens at or after it closes`);
    }
    return [open, close];
  });
}

/**
 * Tags a canteen earns from its own hours, rather than from its authored tags.
 * Kept here so the rule travels with the data, and so the two stay in sync.
 */
export function deriveTags(canteen) {
  const tags = [];
  const [sun, , , , , , sat] = canteen.hours;
  if (sun == null && sat == null) tags.push('weekday-only');
  const latest = canteen.hours.reduce((max, slot) => {
    if (!slot) return max;
    return Math.max(max, toMinutes(slot[1]));
  }, 0);
  if (latest >= 21 * 60) tags.push('open-late');
  return tags;
}

/** Load and validate data/canteens.json against the vocabulary. */
export function loadDataset(vocab = loadVocab(), value = readJson(CANTEENS_PATH).value) {
  if (!isObject(value)) throw new DataError('canteens.json must be a JSON object');

  const cuisineKeys = new Set(vocab.cuisines.map((c) => c.key));
  const dietKeys = new Set(vocab.diets.map((d) => d.key));
  const facetKeys = new Set(vocab.facets.map((f) => f.key));

  const landmarks = value.landmarks;
  if (!isObject(landmarks) || Object.keys(landmarks).length === 0) {
    throw new DataError('canteens.json: "landmarks" must be a non-empty object');
  }
  for (const [key, l] of Object.entries(landmarks)) {
    if (!isObject(l) || !isNonEmptyString(l.label) || !Number.isFinite(l.lat) || !Number.isFinite(l.lng)) {
      throw new DataError(`canteens.json: landmark "${key}" must have label, lat and lng`);
    }
  }

  if (!Array.isArray(value.canteens) || value.canteens.length === 0) {
    throw new DataError('canteens.json: "canteens" must be a non-empty array');
  }

  const seen = new Set();
  const canteens = value.canteens.map((c, i) => {
    const where = isNonEmptyString(c?.id) ? `"${c.id}"` : `canteens[${i}]`;
    if (!isObject(c)) throw new DataError(`canteens.json: ${where} must be an object`);
    if (!isNonEmptyString(c.id)) throw new DataError(`canteens.json: ${where} is missing "id"`);
    if (seen.has(c.id)) throw new DataError(`canteens.json: duplicate canteen id "${c.id}"`);
    seen.add(c.id);

    for (const field of ['name', 'venue', 'zone', 'overview']) {
      if (!isNonEmptyString(c[field])) {
        throw new DataError(`canteens.json: ${where} is missing "${field}"`);
      }
    }
    if (!Number.isFinite(c.lat) || !Number.isFinite(c.lng)) {
      throw new DataError(`canteens.json: ${where} needs numeric lat/lng`);
    }
    if (c.image != null && !isNonEmptyString(c.image)) throw new DataError(`${where}: image must be text or null`);
    if (c.priceLevel !== null && (!Number.isInteger(c.priceLevel) || c.priceLevel < 1 || c.priceLevel > 3)) {
      throw new DataError(`canteens.json: ${where} priceLevel must be 1, 2 or 3`);
    }
    if (c.avgPrice !== null && (!Number.isFinite(c.avgPrice) || c.avgPrice <= 0)) {
      throw new DataError(`canteens.json: ${where} avgPrice must be > 0`);
    }
    if (c.rating !== null && (!Number.isFinite(c.rating) || c.rating < 0 || c.rating > 5)) {
      throw new DataError(`canteens.json: ${where} rating must be between 0 and 5`);
    }

    const hours = checkHours(c.id, c.hours);

    for (const field of ['cuisines', 'diets', 'tags', 'menu']) {
      if (!Array.isArray(c[field])) throw new DataError(`${where}: ${field} must be an array`);
    }
    const cuisines = c.cuisines ?? [];
    if (cuisines.length === 0) throw new DataError(`canteens.json: ${where} has no cuisines`);
    for (const k of cuisines) {
      if (!cuisineKeys.has(k)) throw new DataError(`canteens.json: ${where} cuisine "${k}" is not in vocab`);
    }
    const diets = c.diets ?? [];
    for (const k of diets) {
      if (!dietKeys.has(k)) throw new DataError(`canteens.json: ${where} diet "${k}" is not in vocab`);
    }
    const tags = c.tags ?? [];
    for (const k of tags) {
      if (!facetKeys.has(k)) throw new DataError(`canteens.json: ${where} tag "${k}" is not a known facet`);
    }

    const menu = c.menu ?? [];
    if (typeof c.verified !== 'boolean') throw new DataError(`${where}: verified must be a boolean`);
    if (c.verified && (!Array.isArray(c.sources) || !c.sources.length || !c.sources.every(validSource))) {
      throw new DataError(`${where}: verified venue needs dated HTTPS sources for its hours and identity`);
    }
    if (menu.length === 0) throw new DataError(`canteens.json: ${where} has an empty menu`);
    menu.forEach((m, j) => {
      if (!isObject(m) || !isNonEmptyString(m.name) || (m.price !== null && (!Number.isFinite(m.price) || m.price <= 0))) {
        throw new DataError(`canteens.json: ${where} menu[${j}] needs a name and a positive price or null (unknown)`);
      }
      if (!isNonEmptyString(m.stall) || typeof m.verified !== 'boolean') {
        throw new DataError(`${where}: menu[${j}] needs stall and verified`);
      }
      if (!Array.isArray(m.cuisines) || !m.cuisines.length || m.cuisines.some((k) => !cuisineKeys.has(k))) {
        throw new DataError(`${where}: menu[${j}] needs known item-level cuisines`);
      }
      for (const key of ['is_certified_halal', 'is_vegetarian']) {
        if (m[key] !== null && typeof m[key] !== 'boolean') throw new DataError(`${where}: ${key} must be boolean or null`);
      }
      if (m.ingredients_listed !== null &&
          (!Array.isArray(m.ingredients_listed) || !m.ingredients_listed.every(isNonEmptyString))) {
        throw new DataError(`${where}: ingredients_listed must be a string array or null (unknown)`);
      }
      if (!Array.isArray(m.dietary_tags) || m.dietary_tags.some((d) => !dietKeys.has(d)) ||
          !Array.isArray(m.dietary_tags_source) || !Array.isArray(m.sources)) {
        throw new DataError(`${where}: menu dietary tags and sources must be arrays`);
      }
      if (m.verified && (!c.verified || !m.sources.length || !m.sources.every(validSource))) {
        throw new DataError(`${where}: verified menu needs a verified venue and dated item sources`);
      }
      if (m.dietary_tags_source.some((s) => !validSource(s) || !dietKeys.has(s.tag) || !isNonEmptyString(s.statement))) {
        throw new DataError(`${where}: dietary evidence needs tag, statement, source and check date`);
      }
      const claims = [...m.dietary_tags, ...(m.is_certified_halal ? ['halal'] : []), ...(m.is_vegetarian ? ['vegetarian'] : [])];
      for (const [tag, flag] of [['halal', 'is_certified_halal'], ['vegetarian', 'is_vegetarian']]) {
        if (m.dietary_tags.includes(tag) && m[flag] !== true) {
          throw new DataError(`${where}: ${tag} tag contradicts ${flag}`);
        }
      }
      if (m.dietary_tags_source.some((s) => !claims.includes(s.tag))) {
        throw new DataError(`${where}: dietary evidence must describe a declared positive claim`);
      }
      if (claims.length && (!m.verified || claims.some((tag) => !m.dietary_tags_source.some((s) => s.tag === tag)))) {
        throw new DataError(`${where}: every positive dietary claim requires reviewed, explicit source evidence`);
      }
    });

    const sources = c.sources ?? [];
    if (!Array.isArray(sources)) throw new DataError(`canteens.json: ${where} sources must be an array`);
    sources.forEach((s, j) => {
      if (!isObject(s) || !isNonEmptyString(s.label)) {
        throw new DataError(`canteens.json: ${where} sources[${j}] needs a label`);
      }
      if (s.url != null && !/^https?:\/\//.test(s.url)) {
        throw new DataError(`canteens.json: ${where} sources[${j}] url must be http(s)`);
      }
    });

    return {
      ...c,
      hours,
      cuisines,
      diets,
      tags,
      menu,
      sources,
    };
  });

  return { landmarks, canteens };
}

/* ---------------------------------------------------------------- bundle -- */

/**
 * Everything needed to (re)build the database, plus a content hash so db.js can
 * skip a re-import when nothing changed.
 */
export function loadAll() {
  const vocab = loadVocab();
  const dataset = loadDataset(vocab);
  const dataHash = createHash('sha256')
    .update(JSON.stringify({ vocab, landmarks: dataset.landmarks, canteens: dataset.canteens }))
    .digest('hex')
    .slice(0, 16);
  return { vocab, ...dataset, dataHash };
}

export { DataError };