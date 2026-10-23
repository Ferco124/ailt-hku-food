export const DISCLAIMER = 'Informational only, not a safety guarantee. Confirm dietary status, ingredients and cross-contamination risks with canteen staff.';
export const NO_MATCH = 'No match found in the current dataset. This does not mean that suitable food is unavailable on campus.';
export const WALKTHROUGH_VERSION = 3;

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

export function hasEvidence(item) {
  return item.verified === true &&
    typeof item.stall === 'string' && item.stall.trim().length > 0 &&
    Array.isArray(item.sources) && item.sources.length > 0 && item.sources.every(validSource) &&
    Array.isArray(item.dietary_tags_source) && item.dietary_tags_source.every((s) =>
      validSource(s) && typeof s.tag === 'string' && typeof s.statement === 'string' && s.statement.trim());
}

export function eligibleMenu(canteen, intent, demo = false) {
  return canteen.menu.filter((item) => {
    if ((!demo || intent.diets.length) && (!canteen.verified || !hasEvidence(item))) return false;
    if (intent.requested_stall && item.stall.toLowerCase() !== intent.requested_stall.toLowerCase() &&
        canteen.name.toLowerCase() !== intent.requested_stall.toLowerCase()) return false;
    // Demonstration records never establish religious or dietary suitability.
    if (intent.diets.length && (!hasEvidence(item) || !matchesDiets(item, intent.diets))) return false;
    const cuisines = intent.cuisines.filter((c) => !['vegetarian', 'vegan', 'halal', 'gluten_free'].includes(c));
    if (cuisines.length && !cuisines.some((c) => item.cuisines.includes(c))) return false;
    if (intent.max_price_hkd != null && (item.price == null || item.price > intent.max_price_hkd)) return false;
    return true;
  }).sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
}
