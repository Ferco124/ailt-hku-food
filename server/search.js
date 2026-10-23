import { getCanteens, landmarks } from './db.js';
import { nowInHK, toMinutes, openStatus, distanceToLandmark, nearestLandmark } from './geo.js';
import { facetForCue } from './data/vocab.js';
import { eligibleMenu, hasEvidence } from './policy.js';

const MAX_RESULTS = 3;

const clamp01 = (n) => Math.min(1, Math.max(0, n));
const title = (s) => String(s).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * Score one canteen against an intent.
 * Returns null when a hard constraint excludes it.
 */
function evaluate(canteen, intent, ctx) {
  const { checkMinutes } = ctx;
  const menu = eligibleMenu(canteen, intent, ctx.demo);
  if (!menu.length) return null;

  // --- hard filters -------------------------------------------------------
  const status = openStatus(canteen, ctx.now, intent.arrive_by ? checkMinutes : null);
  if ((intent.open_now || intent.arrive_by) && !status.open) return null;
  if (intent.meal && !intent.arrive_by) {
    const window = { breakfast: [420, 660], lunch: [660, 900], dinner: [1020, 1320], snack: [0, 1440] }[intent.meal];
    if (!status.today || toMinutes(status.today[0]) >= window[1] || toMinutes(status.today[1]) <= window[0]) return null;
  }
  if (intent.zone && canteen.zone.toLowerCase() !== intent.zone.toLowerCase()) return null;
  if (intent.max_walk_minutes != null && !intent.near) return null;

  // --- distance -----------------------------------------------------------
  let distance = null;
  let walkFrom = null;
  if (intent.near) {
    distance = distanceToLandmark(canteen, intent.near);
    walkFrom = { key: intent.near, label: landmarks[intent.near].label, requested: true };
  } else {
    // No location given: rank by centrality, but do not claim a walk time from
    // a landmark the user never mentioned.
    const nearest = nearestLandmark(canteen);
    distance = nearest.minutes;
    walkFrom = { key: nearest.key, label: nearest.label, requested: false };
  }

  if (intent.max_walk_minutes != null) {
    if (distance > intent.max_walk_minutes) return null;
  }

  // --- scoring ------------------------------------------------------------
  let score = 0;
  let applicable = 0;
  const reasons = [];

  // Cuisine and dietary labels describe returned dishes, not other stalls.
  const matchedCuisines = intent.cuisines.filter(
    (c) => menu.some((m) => m.cuisines.includes(c)) || intent.diets.includes(c)
  );
  if (intent.cuisines.length) {
    applicable += 46;
    if (matchedCuisines.length) {
      score += 34 + (Math.min(matchedCuisines.length, 2) - 1) * 12;
      reasons.push({ icon: '✓', text: `Serves ${matchedCuisines.slice(0, 2).map(title).join(' · ')}` });
    } else {
      score -= 14;
    }
  }

  // Dietary fit.
  if (intent.diets.length) {
    applicable += 28;
    const hitDiets = intent.diets;
    if (hitDiets.length) {
      score += 28;
      reasons.push({ icon: '🌿', text: `${hitDiets.map(title).join(' · ')} options` });
    }
  }

  // Price.
  if (intent.max_price_hkd != null) {
    applicable += 18;
    score += 18;
    reasons.push({ icon: '💸', text: `Fits your HK$${intent.max_price_hkd} budget` });
  } else if (intent.price_preference === 'cheap') {
    applicable += 22;
    if (canteen.priceLevel === 1) {
      score += 22;
      reasons.push({ icon: '💸', text: 'Cheapest tier on campus' });
    } else if (canteen.priceLevel === 2) score += 6;
    else score -= 14;
  } else if (intent.price_preference === 'mid') {
    applicable += 14;
    score += canteen.priceLevel === 2 ? 14 : canteen.priceLevel === 1 ? 5 : -4;
  }

  // Proximity.
  if (intent.near) {
    applicable += 30;
    score += 30 * clamp01(1 - distance / 25);
  } else {
    applicable += 8;
    score += 8 * clamp01(1 - distance / 25);
  }

  // Meal window.
  if (intent.meal) {
    applicable += 12;
    const opensAt = status.opensAt ? toMinutes(status.opensAt) : null;
    const closesAt = status.closesAt ? toMinutes(status.closesAt) : null;
    if (intent.meal === 'breakfast' && opensAt != null && opensAt <= 9 * 60) {
      score += 12;
      reasons.push({ icon: '🌅', text: `Opens at ${status.opensAt}` });
    } else if (intent.meal === 'lunch' && status.today) {
      const [o, c] = status.today;
      if (toMinutes(o) <= 12 * 60 + 30 && toMinutes(c) >= 13 * 60 + 30) score += 10;
    } else if (intent.meal === 'dinner' && closesAt != null && closesAt >= 19 * 60 + 30) {
      score += 12;
      reasons.push({ icon: '🌙', text: `Serves dinner until ${status.closesAt}` });
    } else if (intent.meal === 'snack') {
      if (canteen.cuisines.some((c) => ['coffee', 'snack', 'bakery'].includes(c))) score += 12;
    }
  }

  // Free-text cues. A cue is first normalised through the facet synonyms, so
  // "late night" can hit the derived `open-late` tag; anything that is not a
  // known facet falls back to a plain substring match.
  if (intent.keywords.length) {
    const haystack = [
      canteen.name, canteen.venue, canteen.overview, canteen.zone,
      ...canteen.tags, ...canteen.cuisines,
    ].join(' ').toLowerCase();

    const hits = new Set();
    for (const k of intent.keywords) {
      const facet = facetForCue(k);
      if (facet && canteen.tags.includes(facet)) {
        hits.add(facet.replace(/-/g, ' '));
      } else if (haystack.includes(k)) {
        hits.add(k);
      }
    }
    const hitList = [...hits].slice(0, 3);
    applicable += Math.min(intent.keywords.length, 3) * 7;
    score += hitList.length * 7;
    if (hitList.length) reasons.push({ icon: '🏷️', text: hitList.join(', ') });
  }

  // Quality nudge.
  if (canteen.rating != null) {
    applicable += 10;
    score += (canteen.rating - 3.5) * 10;
  }

  // Availability nudge.
  applicable += 4;
  if (status.open) score += 4;

  // Do not send someone to a place that closes while they are walking there.
  if (status.open && status.minutesLeft != null && status.minutesLeft < 40) {
    score -= 10;
    reasons.push({ icon: '⏳', text: `Closes soon (${status.closesAt})` });
  }

  const matchPct = Math.round(100 * clamp01(score / Math.max(applicable, 1)));

  // "vegetarian" can arrive from both the cuisine and the diet rule — keep one.
  const seen = new Set();
  const uniqueReasons = reasons.filter((r) => {
    const key = r.text.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    canteen: {
      ...canteen, menu,
      avgPrice: menu.some((m) => m.price != null) ? Math.min(...menu.map((m) => m.price ?? Infinity)) : null,
      cuisines: [...new Set(menu.flatMap((m) => m.cuisines))],
      diets: [...new Set(menu.filter(hasEvidence).flatMap((m) => [
        ...m.dietary_tags, ...(m.is_certified_halal ? ['halal'] : []), ...(m.is_vegetarian ? ['vegetarian'] : []),
      ]))],
      tags: canteen.tags.filter((tag) => !['halal', 'veg-thali'].includes(tag)),
      verified: canteen.verified && menu.every(hasEvidence),
    },
    score,
    matchPct,
    reasons: uniqueReasons.slice(0, 4),
    distance,
    walkFrom,
    status: { open: status.open, reason: status.reason, closesAt: status.closesAt, opensAt: status.opensAt },
  };
}

/**
 * Order the qualifying results. The relevance floor above decides *which*
 * results qualify; this decides the order they are shown in. Every sort keeps
 * matchPct as a tie-break so the order never contradicts the ranking outright.
 */
function orderBy(list, sort) {
  const copy = [...list];
  switch (sort) {
    case 'cheapest':
      return copy.sort(
        (a, b) => (a.canteen.avgPrice ?? Infinity) - (b.canteen.avgPrice ?? Infinity) || b.matchPct - a.matchPct || a.distance - b.distance
      );
    case 'closest':
      return copy.sort((a, b) => a.distance - b.distance || b.matchPct - a.matchPct);
    case 'top_rated':
      return copy.sort((a, b) => b.canteen.rating - a.canteen.rating || b.matchPct - a.matchPct);
    case 'best_match':
    default:
      return copy.sort(
        (a, b) => b.score - a.score || a.distance - b.distance || b.canteen.rating - a.canteen.rating
      );
  }
}

/** Human-readable description of what the list is ordered by. */
function sortBasis(sort, intent) {
  switch (sort) {
    case 'cheapest': return 'lowest matching dish price';
    case 'closest': return intent.near ? `walk from ${landmarks[intent.near].label}` : 'walk from the nearest landmark';
    case 'top_rated': return 'rating';
    default: return null;
  }
}

/**
 * Filter + rank the demo database.
 *
 * Hard constraints are never relaxed. Only eligible menu items are returned.
 */
export function search(intent, { now = nowInHK(), limit = MAX_RESULTS, demo = false, canteens = getCanteens() } = {}) {
  const checkMinutes = intent.arrive_by ? toMinutes(intent.arrive_by) : now.minutes;
  const relaxed = [];
  const ranked = (intent.unsupported?.length ? [] : canteens)
    .map((c) => evaluate(c, intent, { now, checkMinutes, demo }))
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || a.distance - b.distance || b.canteen.rating - a.canteen.rating);

  // A weak match shown confidently is worse than no match: "korean bbq" should
  // not return a coffee shop at 29% next to a food court at 74%. Keep only
  // results reasonably close to the best one; return no match otherwise.
  const best = ranked[0]?.matchPct ?? 0;
  const cutoff = Math.max(25, best * 0.6);
  const strong = ranked.filter((r) => r.matchPct >= cutoff);
  const lowConfidence = best > 0 && best < 25;
  const sort = intent.sort ?? 'best_match';
  const chosen = orderBy(strong, sort).slice(0, limit);

  return {
    results: chosen.map((r) => ({
      id: r.canteen.id,
      name: r.canteen.name,
      nameZh: r.canteen.nameZh,
      venue: r.canteen.venue,
      zone: r.canteen.zone,
      emoji: r.canteen.emoji,
      image: r.canteen.image,
      cuisines: r.canteen.cuisines,
      diets: r.canteen.diets,
      priceLevel: r.canteen.priceLevel,
      avgPrice: r.canteen.avgPrice,
      rating: r.canteen.rating,
      tags: r.canteen.tags,
      overview: r.canteen.overview,
      menu: r.canteen.menu,
      sources: r.canteen.sources,
      verified: r.canteen.verified,
      status: r.status,
      walkMinutes: r.distance,
      walkFrom: r.walkFrom,
      matchPct: r.matchPct,
      reasons: r.reasons,
    })),
    meta: {
      totalMatches: strong.length,
      lowConfidence,
      bestMatch: best,
      relaxed,
      sort,
      sortBasis: sortBasis(sort, intent),
      checkTime: intent.arrive_by || now.hhmm,
      dayName: now.dayName,
      evaluated: canteens.length,
      demo,
    },
  };
}
