import { looseNameMatch } from './text.js';

export const DISCLAIMER = 'Informational only, not a safety guarantee. Confirm dietary status, ingredients and cross-contamination risks with canteen staff.';
export const NO_MATCH = 'No match found in the current dataset. This does not mean that suitable food is unavailable on campus.';
// Bumped when retrieval semantics change, so cached snapshots are not served
// under rules that no longer apply. 4: venue-level verification tier.
// 5: relevance by menu share and venue identity, results show matching dishes.
// 6: dietary answers carry a basis (dish evidence vs. outlet-level listing).
// 7: unconfirmed vegetarian outlets are returned as hints, outside `results`.
export const WALKTHROUGH_VERSION = 7;

export function refusalFor(query) {
  if (/\b(order(?!\s+(?:by|results|the results|of\b))|purchase|deliver|checkout|payment|reserve)\b|\b(?:buy|book)\b.*\b(?:for me|this|it)\b|下單|下单|訂餐|订餐/i.test(query)) {
    return { reason: 'ordering_refused', notice: 'This app only provides dining information. It cannot place, modify or pay for orders or reservations.' };
  }
  if (/\b(diagnos\w*|treat\w*|cure|medicin\w*|anaphyl\w*|symptom\w*|doctor|medical)\b|診斷|诊断|治療|治疗|醫療|医疗/i.test(query)) {
    return { reason: 'medical_refused', notice: 'I cannot provide medical advice or diagnose allergies. Consult a doctor, allergist or university health service.' };
  }
  if (/\b(allerg\w*|anaphyl\w*|nut[- ]?free|peanut[- ]?free|safe|safety|guarantee\w*|cross[- ]?contamination)\b|過敏|过敏|無堅果|无坚果|安全保證|安全保证/i.test(query)) {
    return { reason: 'allergen_refused', notice: `I cannot confirm allergen safety, including nut-free status. ${DISCLAIMER}` };
  }
  return null;
}

export function matchesDiets(item, diets) {
  return diets.every((diet) => {
    if (!item.dietary_tags_source?.some((s) => s.tag === diet)) return false;
    if (diet === 'halal') return item.is_certified_halal === true;
    if (diet === 'vegetarian') return item.is_vegetarian === true;
    return item.dietary_tags?.includes(diet) === true;
  });
}

export function validSource(source) {
  if (!source || typeof source.label !== 'string' || !source.label.trim() ||
      typeof source.url !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(source.checkedAt)) return false;
  let url;
  try { url = new URL(source.url); } catch { return false; }
  const date = Date.parse(source.checkedAt);
  return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password &&
    Number.isFinite(date) && new Date(date).toISOString().slice(0, 10) === source.checkedAt && date <= Date.now();
}

/**
 * Does this outlet answer a request for a named outlet?
 *
 * The dataset spells outlets its own way ("TamJai SamGor 譚仔三哥"), and the
 * people asking are typing from memory ("tamjai", "tam jai", "譚仔三哥"), so the
 * comparison is on the compact form of the name rather than the exact string.
 * Matching happens against the outlet name, its Chinese name and each dish's
 * stall, because a food court stall is a legitimate thing to ask for by name.
 */
export function outletMatches(request, canteen) {
  if (!request) return true;
  if (looseNameMatch(request, canteen.name) || looseNameMatch(request, canteen.nameZh)) return true;
  return (canteen.menu ?? []).some((m) => looseNameMatch(request, m.stall));
}

export function hasEvidence(item) {
  return item.verified === true &&
    typeof item.stall === 'string' && item.stall.trim().length > 0 &&
    Array.isArray(item.sources) && item.sources.length > 0 && item.sources.every(validSource) &&
    Array.isArray(item.dietary_tags_source) && item.dietary_tags_source.every((s) =>
      validSource(s) && typeof s.tag === 'string' && typeof s.statement === 'string' && s.statement.trim());
}

/**
 * Does the outlet itself vouch for a diet, at the level of the whole outlet?
 *
 * This is weaker than `matchesDiets`: it says "the outlet is certified / lists
 * this diet", not "this dish was reviewed". It still has to be a real claim —
 * the venue must be verified and carry a dated HTTPS source — so demonstration
 * data can never acquire dietary standing, with or without `demo`.
 */
export function venueListsDiets(canteen, diets) {
  if (canteen.verified !== true) return false;
  if (!Array.isArray(canteen.sources) || canteen.sources.length === 0 ||
      !canteen.sources.every(validSource)) return false;
  return diets.every((diet) => (canteen.diets ?? []).includes(diet));
}

export function eligibleMenu(canteen, intent, demo = false) {
  // Venue facts (name, address, hours, service mode) are verified separately
  // from dish facts (name, price, dietary suitability). A venue-verified record
  // may surface its representative dishes; a dietary constraint still demands
  // dish-level evidence, because that is a safety claim, not a description.
  //
  // An outlet-level listing is the exception, and it is deliberately weaker:
  // it answers "where can I eat" for a certified outlet without claiming that
  // any particular dish was reviewed. `search` records which of the two applied
  // so the card can say so instead of implying a reviewed dish.
  const venueQualifies = canteen.verified === true || demo;
  return canteen.menu.filter((item) => {
    if (!venueQualifies) return false;
    // A named outlet is a hard constraint, but the spelling is not: "tamjai",
    // "tam jai" and "譚仔三哥" all have to reach the one outlet that carries the
    // name, or every name query becomes an empty page (see text.js).
    if (intent.requested_stall && !looseNameMatch(intent.requested_stall, item.stall ?? '') &&
        !looseNameMatch(intent.requested_stall, canteen.name) &&
        !looseNameMatch(intent.requested_stall, canteen.nameZh)) return false;
    // Demonstration records never establish religious or dietary suitability.
    if (intent.diets.length && !(hasEvidence(item) && matchesDiets(item, intent.diets)) &&
        !venueListsDiets(canteen, intent.diets)) return false;
    const cuisines = intent.cuisines.filter((c) => !['vegetarian', 'vegan', 'halal', 'gluten_free'].includes(c));
    if (cuisines.length && !cuisines.some((c) => item.cuisines.includes(c))) return false;
    if (intent.max_price_hkd != null && (item.price == null || item.price > intent.max_price_hkd)) return false;
    return true;
  }).sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
}
