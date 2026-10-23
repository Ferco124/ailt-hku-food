import { CUISINES, DIETS } from './data/vocab.js';
import { landmarks } from './db.js';

/**
 * The contract the LLM must satisfy. Everything the model is allowed to say is
 * enumerated here. Unsupported requirements block retrieval; malformed fields
 * fail validation rather than silently becoming less restrictive.
 */
export const INTENT_KEYS = [
  'cuisines', 'diets', 'max_price_hkd', 'price_preference', 'open_now',
  'arrive_by', 'near', 'max_walk_minutes', 'meal', 'keywords', 'sort', 'confidence',
  'requested_stall', 'zone', 'unsupported', 'refusal',
];

const MEALS = ['breakfast', 'lunch', 'dinner', 'snack'];
const PRICE_PREFS = ['cheap', 'mid', 'any'];

/** How the result list is ordered once the relevance floor has been applied. */
export const SORTS = ['best_match', 'cheapest', 'closest', 'top_rated'];

export const SORT_LABELS = {
  best_match: 'best match',
  cheapest: 'cheapest',
  closest: 'closest',
  top_rated: 'top rated',
};

const LANDMARK_ALIASES = {
  library: 'main_library',
  main_library: 'main_library',
  'main library': 'main_library',
  centennial: 'centennial_campus',
  centennial_campus: 'centennial_campus',
  'centennial campus': 'centennial_campus',
  mtr: 'hku_station',
  hku_station: 'hku_station',
  station: 'hku_station',
  main_building: 'main_building',
  knowles: 'knowles_building',
  knowles_building: 'knowles_building',
  run_run_shaw: 'run_run_shaw',
  rrs: 'run_run_shaw',
  university_street: 'university_street',
  pokfulam: 'pokfulam_road',
  pokfulam_road: 'pokfulam_road',
  jockey_club: 'jockey_club_village',
  jockey_club_village: 'jockey_club_village',
  haking_wong: 'haking_wong',
};

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const asArray = (v) => {
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') return v.split(/[,;|]/).map((s) => s.trim()).filter(Boolean);
  return [];
};

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function normaliseLandmark(v) {
  if (typeof v !== 'string') return null;
  const key = v.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (landmarks[key]) return key;
  const alias = LANDMARK_ALIASES[key] || LANDMARK_ALIASES[v.trim().toLowerCase()];
  return alias && landmarks[alias] ? alias : null;
}

/**
 * Validate + sanitise an arbitrary object into an Intent.
 * Returns { ok, intent, errors, warnings }. Never throws.
 */
export function validateIntent(raw) {
  const errors = [];
  const warnings = [];

  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['Intent must be a JSON object'], warnings, intent: null };
  }
  for (const key of ['cuisines', 'diets', 'diet', 'keywords', 'unsupported']) {
    if (raw[key] != null && (!Array.isArray(raw[key]) || raw[key].some((v) => typeof v !== 'string'))) {
      errors.push(`${key} must be an array of strings`);
    }
  }
  for (const key of ['requested_stall', 'zone', 'arrive_by', 'near', 'meal', 'price_preference', 'sort', 'refusal']) {
    if (raw[key] != null && typeof raw[key] !== 'string') errors.push(`${key} must be text or null`);
  }
  for (const key of ['max_price_hkd', 'max_walk_minutes', 'confidence']) {
    if (raw[key] != null && (typeof raw[key] !== 'number' || !Number.isFinite(raw[key]))) {
      errors.push(`${key} must be a finite number or null`);
    }
  }
  if (raw.open_now != null && typeof raw.open_now !== 'boolean') errors.push('open_now must be a boolean');
  if (raw.refusal != null && !['allergen_refused', 'medical_refused', 'ordering_refused'].includes(raw.refusal)) {
    errors.push('Unknown refusal type');
  }
  if (errors.length) return { ok: false, intent: null, errors, warnings };

  const intent = {
    cuisines: [],
    diets: [],
    max_price_hkd: null,
    price_preference: 'any',
    open_now: false,
    arrive_by: null,
    near: null,
    max_walk_minutes: null,
    meal: null,
    keywords: [],
    sort: 'best_match',
    confidence: 0.5,
    requested_stall: null,
    zone: null,
    unsupported: [],
    refusal: null,
  };
  if (Array.isArray(raw.unsupported)) {
    intent.unsupported = raw.unsupported.map((s) => s.trim()).filter(Boolean);
  }
  if (['allergen_refused', 'medical_refused', 'ordering_refused'].includes(raw.refusal)) {
    intent.refusal = raw.refusal;
  }
  if (typeof raw.requested_stall === 'string' && raw.requested_stall.trim()) {
    intent.requested_stall = raw.requested_stall.trim();
  }
  if (typeof raw.zone === 'string' && raw.zone.trim()) {
    intent.zone = raw.zone.trim();
  }

  // --- cuisines -----------------------------------------------------------
  for (const c of asArray(raw.cuisines)) {
    const key = String(c).trim().toLowerCase();
    if (CUISINES.includes(key)) {
      if (!intent.cuisines.includes(key)) intent.cuisines.push(key);
    } else if (key) {
      warnings.push(`Dropped unknown cuisine "${key}"`);
      intent.unsupported.push(`cuisine: ${key}`);
    }
  }

  // --- diets --------------------------------------------------------------
  for (const d of asArray(raw.diets ?? raw.diet)) {
    const key = String(d).trim().toLowerCase().replace(/[\s-]+/g, '_');
    const canon = key === 'veg' || key === 'veggie' ? 'vegetarian' : key === 'vegan_friendly' ? 'vegan' : key;
    if (DIETS.includes(canon)) {
      if (!intent.diets.includes(canon)) intent.diets.push(canon);
    } else if (key) {
      warnings.push(`Dropped unknown diet "${key}"`);
      intent.unsupported.push(`diet: ${key}`);
    }
  }
  intent.diets = [...new Set([...intent.diets, ...intent.cuisines.filter((c) => DIETS.includes(c))])];

  // --- price --------------------------------------------------------------
  if (raw.max_price_hkd != null && raw.max_price_hkd !== '') {
    const n = Number(raw.max_price_hkd);
    // Reject rather than clamp: a hallucinated "9999" must not silently become
    // a real budget filter, and clamping it would invent a constraint.
    if (Number.isFinite(n) && n > 0 && n <= 300) intent.max_price_hkd = n;
    else intent.unsupported.push('Unsupported price limit');
  }

  if (typeof raw.price_preference === 'string' && PRICE_PREFS.includes(raw.price_preference.toLowerCase())) {
    intent.price_preference = raw.price_preference.toLowerCase();
  } else if (raw.price_preference != null) {
    intent.unsupported.push('Unknown price preference');
  }
  // A hard price cap implies "cheap" even if the model omitted the label.
  if (intent.max_price_hkd != null && intent.price_preference === 'any' && intent.max_price_hkd <= 60) {
    intent.price_preference = 'cheap';
  }

  // --- open now -----------------------------------------------------------
  if (typeof raw.open_now === 'boolean') intent.open_now = raw.open_now;
  else if (raw.open_now != null) warnings.push('Ignored non-boolean open_now');

  // --- arrive by ----------------------------------------------------------
  if (raw.arrive_by != null && raw.arrive_by !== '') {
    const t = String(raw.arrive_by).trim();
    if (TIME_RE.test(t)) intent.arrive_by = t;
    else intent.unsupported.push(`Invalid time: ${t}`);
  }

  // --- near ---------------------------------------------------------------
  if (raw.near != null && raw.near !== '') {
    const key = normaliseLandmark(raw.near);
    if (key) intent.near = key;
    else intent.unsupported.push(`Unknown location: ${raw.near}`);
  }

  // --- walk budget --------------------------------------------------------
  if (raw.max_walk_minutes != null && raw.max_walk_minutes !== '') {
    const n = Number(raw.max_walk_minutes);
    if (Number.isFinite(n) && n > 0 && n <= 120) intent.max_walk_minutes = n;
    else intent.unsupported.push('Unsupported walking limit');
  }
  if (intent.max_walk_minutes != null && !intent.near) {
    intent.unsupported.push('A walking limit requires a starting landmark. Please specify where you are.');
  }

  // --- meal ---------------------------------------------------------------
  if (typeof raw.meal === 'string' && MEALS.includes(raw.meal.toLowerCase())) {
    intent.meal = raw.meal.toLowerCase();
  } else if (raw.meal != null) {
    intent.unsupported.push(`Unknown meal: ${raw.meal}`);
  }

  // --- keywords -----------------------------------------------------------
  intent.keywords = asArray(raw.keywords)
    .map((k) => String(k).trim().toLowerCase().slice(0, 24))
    .filter((k) => k.length > 0 && k.length <= 24)
    .slice(0, 5);

  // --- sort ---------------------------------------------------------------
  if (typeof raw.sort === 'string' && SORTS.includes(raw.sort.trim().toLowerCase())) {
    intent.sort = raw.sort.trim().toLowerCase();
  } else if (raw.sort != null && raw.sort !== '') {
    warnings.push(`Ignored unknown sort "${raw.sort}"`);
  }

  // --- confidence ---------------------------------------------------------
  const conf = Number(raw.confidence);
  intent.confidence = Number.isFinite(conf) ? clamp(conf, 0, 1) : 0.5;

  return { ok: true, intent, errors, warnings };
}

/** Does the intent express at least one usable constraint? */
export function hasConstraints(intent) {
  if (!intent) return false;
  return (
    intent.cuisines.length > 0 ||
    intent.diets.length > 0 ||
    intent.max_price_hkd != null ||
    intent.near != null ||
    intent.max_walk_minutes != null ||
    intent.meal != null ||
    intent.keywords.length > 0 ||
    intent.arrive_by != null
    || intent.open_now || intent.price_preference !== 'any'
    || intent.sort !== 'best_match' || intent.requested_stall != null
    || intent.zone != null || intent.unsupported.length > 0
  );
}
