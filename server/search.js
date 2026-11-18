import { getCanteens, landmarks } from './db.js';
import {
  nowInHK, toMinutes, openStatus, distanceToLandmark, nearestLandmark, latestClose, nextOpening,
} from './geo.js';
import { facetForCue } from './data/vocab.js';
import { compact, looseNameMatch } from './text.js';
import { eligibleMenu, hasEvidence, matchesDiets, outletMatches, venueListsDiets } from './policy.js';

const MAX_RESULTS = 3;

const clamp01 = (n) => Math.min(1, Math.max(0, n));
const title = (s) => String(s).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** Vocabulary keys use underscores; people do not. "dim_sum" → "dim sum". */
const cueWord = (cue) => String(cue).replace(/_/g, ' ').trim().toLowerCase();

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * An `unsupported` entry worded as a doubt about the parse rather than as a
 * constraint the dataset cannot answer. Used only to drop a name echoed back at
 * us (see resolveNameCues), never to excuse a real limitation.
 */
const PARSE_DOUBT = /(ambiguous|unclear|unknown|not a (?:dish|cuisine|constraint|preference|venue))/i;

/** Whole-word containment, so "tea" does not match "steak". */
const containsCue = (haystack, cue) => new RegExp(`\\b${escapeRe(cue)}\\b`).test(haystack);

/**
 * A dish name is weak evidence, so it can only ever raise a *hint*, never a
 * match: the name must carry a plant-based cue AND no meat or fish cue.
 * "Chicken Caesar Salad" is exactly why both halves are needed — matching on
 * "salad" alone would put chicken in front of someone asking for vegetarian
 * food, which is the failure mode this whole dataset is meant to avoid.
 */
const PLANT_CUE = /\b(veg|veggie|vegetarian|vegetables?|salad|tofu|tempeh|hummus|falafel|quinoa|avocado|fruit|smoothie|mushroom|garden)\b/i;
const MEAT_CUE = /\b(chicken|beef|pork|ham|bacon|turkey|tuna|salmon|fish|prawn|shrimp|duck|lamb|bbq|pepperoni|sausage|anchov\w*|crab|squid|meat|brisket|caesar|char\s?siu)\b/i;

/** Dishes whose name suggests a plant-based option, on name evidence alone. */
const plantBasedItems = (canteen) => (canteen.menu ?? []).filter((item) => {
  const label = `${item.name} ${item.stall ?? ''}`;
  return PLANT_CUE.test(label) && !MEAT_CUE.test(label);
});

/**
 * Score one canteen against an intent.
 * Returns null when a hard constraint excludes it.
 */
function evaluate(canteen, intent, ctx) {
  const { checkMinutes } = ctx;
  // `menu` is already filtered down to the dishes that answer the query, so it
  // cannot measure how much of the venue is the food asked for. `baseline` is
  // the same venue under the same constraints without the cuisine filter.
  const menu = eligibleMenu(canteen, intent, ctx.demo);
  if (!menu.length) return null;
  const baseline = intent.cuisines.length
    ? eligibleMenu(canteen, { ...intent, cuisines: [] }, ctx.demo)
    : menu;

  // Which dietary basis let this venue through: a reviewed dish, or the
  // outlet's own listing? The distinction is user-visible, so it is computed
  // once here rather than re-derived in the API and the UI.
  const dietBasis = intent.diets.length === 0
    ? null
    : (menu.some((m) => hasEvidence(m) && matchesDiets(m, intent.diets)) ? 'dish' : 'venue');

  // --- hard filters -------------------------------------------------------
  // `includeClosed` is not a user preference: it is the caller asking for the
  // matches that the hours filter would have hidden, so they can be labelled
  // with their real status instead of returning an empty page.
  const status = openStatus(canteen, ctx.now, intent.arrive_by ? checkMinutes : null);
  if (!ctx.includeClosed && (intent.open_now || intent.arrive_by) && !status.open) return null;
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
  // Relevance is the *share* of the menu that is the food asked for, not the
  // mere presence of one such dish. A coffee shop with a single croissant used
  // to score exactly the same as a sandwich counter whose whole menu is
  // sandwiches, leaving the star rating to decide which one came first.
  //
  // A dish's first cuisine is its identity and later ones are secondary: a
  // "Ham & Cheese Croissant" is bakery first, sandwich by association. Primary
  // matches count in full, secondary ones at half, so a café cannot tie with a
  // sandwich counter just because two of its items carry the tag.
  const matchWeight = (m) => intent.cuisines.reduce((w, c) => {
    const at = m.cuisines.indexOf(c);
    if (at === 0) return 1;
    return at > 0 ? Math.max(w, 0.5) : w;
  }, 0);

  const matched = menu.filter((m) => matchWeight(m) > 0);
  const matchedCuisines = intent.cuisines.filter(
    (c) => matched.some((m) => m.cuisines.includes(c)) || intent.diets.includes(c)
  );
  if (intent.cuisines.length) {
    applicable += 46;
    const weight = matched.reduce((sum, m) => sum + matchWeight(m), 0);
    const share = baseline.length ? clamp01(weight / baseline.length) : 0;
    score += 40 * (0.45 + 0.55 * share) + (matchedCuisines.length > 1 ? 6 : 0);
    if (matchedCuisines.length) {
      reasons.push({ icon: '✓', text: `Serves ${matchedCuisines.slice(0, 2).map(title).join(' · ')}` });
    }
  }

  // Identity. "Kiosk by The Sandwich Club" and "Subway" are what a person means
  // by a sandwich shop, whatever else is on the menu. A venue that carries the
  // word in its own name outranks one that merely stocks the item.
  const identityText = [canteen.name, canteen.venue, ...baseline.map((m) => m.stall ?? '')]
    .join(' ').toLowerCase();
  // The outlet's own name, for cues that only differ by spacing: "ju ying tai"
  // against "JuYing Tai 聚英臺". Only the name counts here, not the whole text —
  // folding spaces elsewhere would let "noodle" pass as "noodles" and award
  // identity points to a venue that merely sells them.
  const nameText = [canteen.name, canteen.nameZh].filter(Boolean).join(' ');
  const identityCues = [...new Set([...intent.cuisines, ...intent.keywords])]
    .map(cueWord).filter((c) => c.length >= 3);
  const identityHit = identityCues.find((c) => containsCue(identityText, c) ||
    (c.length >= 6 && looseNameMatch(c, nameText)));
  if (identityCues.length) {
    // Only a pure name query ("subway") treats this as a requirement. When a
    // cuisine was asked for, the cuisine block above already carries that
    // weight, and adding it here would dilute every venue that is not
    // literally named after the food — which is most of them, Subway included.
    if (!intent.cuisines.length) applicable += 18;
    if (identityHit) {
      score += 18;
      reasons.push({ icon: '🎯', text: `Name matches "${title(identityHit)}"` });
    }
  }

  // Named outlet. `requested_stall` is already a hard filter (policy.js), so
  // every venue that survives it is the place the user asked for by name. The
  // points are not extra evidence: without them a pure name query would score
  // from rating and distance alone and could fall under the relevance floor,
  // which would answer "did you mean this outlet" with an empty page.
  if (intent.requested_stall) {
    applicable += 18;
    score += 18;
    reasons.push({ icon: '🎯', text: 'Matches the outlet you named' });
  }

  // Dietary fit. Dish evidence is the full claim; an outlet-level listing is
  // worth less and says so, because ranking it equal would let an unreviewed
  // café outrank a certified outlet on star rating alone.
  if (intent.diets.length) {
    applicable += 28;
    const label = intent.diets.map(title).join(' · ');
    if (dietBasis === 'dish') {
      score += 28;
      reasons.push({ icon: '🌿', text: `${label} · dish evidence` });
    } else {
      score += 18;
      const certified = intent.diets.every((d) => d === 'halal');
      reasons.push({
        icon: '🏷️',
        text: certified
          ? `${label} certified · outlet-level, dishes not reviewed`
          : `${label} options · outlet-level, dishes not reviewed`,
      });
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
      // Dish and stall names count too: "sourdough" is a real thing to search.
      ...menu.map((m) => `${m.name} ${m.stall ?? ''}`),
    ].join(' ').toLowerCase();

    const hits = new Set();
    const compactHaystack = compact(haystack);
    for (const k of intent.keywords) {
      const facet = facetForCue(k);
      if (facet && canteen.tags.includes(facet)) {
        hits.add(facet.replace(/-/g, ' '));
      } else if (haystack.includes(k)) {
        hits.add(k);
      } else if (compact(k).length >= 6 && compactHaystack.includes(compact(k))) {
        // Typed names lose their spacing: "ju ying tai" against "JuYing Tai".
        // Only long cues may match this way, or "tea" would count as "steak".
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

  // What the card and the menu show: the dishes that answer the query. `menu[0]`
  // is the headline dish, so a sandwich search must not headline a croissant,
  // and the quoted price must be the price of the sandwich, not of anything on
  // the menu. The unfiltered `menu` still drives the labels below.
  //
  // A dietary answer only counts as an answer when the dish itself carries the
  // evidence. An outlet-level match therefore returns no dish — quoting one
  // would answer "which dish" with something nobody reviewed — and the details
  // view falls back to the outlet's representative offerings instead.
  const shownMenu = (matched.length
    ? [...matched].sort((a, b) => matchWeight(b) - matchWeight(a))
    : menu
  ).filter((m) => intent.diets.length === 0 || (hasEvidence(m) && matchesDiets(m, intent.diets)));

  const representativeMenu = dietBasis === 'venue' ? menu : null;

  return {
    canteen: {
      ...canteen, menu: shownMenu, representativeMenu,
      avgPrice: shownMenu.some((m) => m.price != null)
        ? Math.min(...shownMenu.map((m) => m.price ?? Infinity))
        : (dietBasis === 'venue' ? (canteen.avgPrice ?? null) : null),
      cuisines: [...new Set(menu.flatMap((m) => m.cuisines))],
      diets: [...new Set(menu.filter(hasEvidence).flatMap((m) => [
        ...m.dietary_tags, ...(m.is_certified_halal ? ['halal'] : []), ...(m.is_vegetarian ? ['vegetarian'] : []),
      ]))],
      tags: canteen.tags.filter((tag) => !['halal', 'veg-thali'].includes(tag)),
      // `verified` means every claim on the card is source-backed. The two
      // component flags let the UI say which half is still representative.
      // An empty menu is not evidence of anything: `[].every()` is true, which
      // would otherwise mark an outlet-level match as fully verified.
      verified: canteen.verified === true && shownMenu.length > 0 && shownMenu.every(hasEvidence),
      venueVerified: canteen.verified === true,
      menuVerified: shownMenu.length > 0 && shownMenu.every(hasEvidence),
    },
    score,
    matchPct,
    dietBasis,
    reasons: uniqueReasons.slice(0, 4),
    distance,
    walkFrom,
    status: {
      open: status.open,
      reason: status.reason,
      closesAt: status.closesAt,
      opensAt: status.opensAt,
      // Only on a closed outlet: the next scheduled opening, so the card can
      // say "opens tomorrow 07:30" instead of implying it opens later today.
      ...(status.open ? {} : {
        reopensAt: status.reopensAt,
        reopensInDays: status.reopensInDays,
        reopensDay: status.reopensDay,
      }),
    },
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
 * A word the vocabulary does not know is not automatically a blocker: it may
 * simply be the name of a place. "subway" is not an unsupported requirement, it
 * is a venue. Promote unrecognised phrases to keywords when the dataset already
 * carries them, and keep the rest as blockers so "korean bbq" still refuses
 * rather than guessing.
 */
function resolveNameCues(intent, canteens) {
  const raw = intent.unsupported ?? [];
  if (!raw.length) return intent;

  // The parser sometimes echoes a bare name back as a remark about its own
  // parse — `ambiguous query "tamjai"` — and any unsupported entry blocks
  // retrieval outright, so that remark would hide the outlet the user named.
  // It is a doubt about the request, not an unmet constraint, so it is dropped
  // when it both restates the requested name and is worded as a doubt. A real
  // constraint that happens to mention the name ("tamjai tomorrow") survives.
  const echo = compact(intent.requested_stall);
  const cues = echo.length >= 3
    ? raw.filter((cue) => !(PARSE_DOUBT.test(cue) && compact(cue).includes(echo)))
    : raw;
  if (!cues.length) return { ...intent, unsupported: [] };

  // Compared in compact form and per outlet, so "ju ying tai" still finds
  // "JuYing Tai 聚英臺" while two unrelated records cannot join across the
  // boundary of the concatenated corpus to invent a name.
  const texts = canteens.map((c) => compact([
    c.name, c.venue, ...(c.menu ?? []).map((m) => `${m.name} ${m.stall ?? ''}`),
  ].join(' ')));

  const promoted = cues.filter((cue) => {
    const word = compact(cueWord(cue));
    return word.length >= 3 && texts.some((text) => text.includes(word));
  });
  if (!promoted.length) return { ...intent, unsupported: cues };

  return {
    ...intent,
    keywords: [...new Set([...intent.keywords, ...promoted.map(cueWord)])].slice(0, 5),
    unsupported: cues.filter((cue) => !promoted.includes(cue)),
  };
}

/**
 * Outlets that *may* serve vegetarian food, kept strictly outside the result
 * list.
 *
 * The dataset only records a diet when an official page states it, so most
 * outlets answer nothing at all. Rather than pretend, this collects the ones
 * whose own menu wording suggests plant-based dishes and hands them back as a
 * separate, clearly-labelled list: no score, no match percentage, no dietary
 * basis, never counted in `totalMatches`. The user gets somewhere to ask; the
 * app never claims the food is suitable.
 */
function dietHints(intent, { now, checkMinutes, demo, canteens, exclude, includeClosed }) {
  // Only the vegetarian case has any name-level signal. "Vegetarian" in a dish
  // name says nothing about halal, gluten or vegan, so those stay unanswered.
  if (intent.unsupported?.length) return [];
  if (intent.diets.length !== 1 || intent.diets[0] !== 'vegetarian') return [];

  const relaxed = { ...intent, diets: [] };
  const hints = [];
  for (const canteen of canteens) {
    if (exclude.has(canteen.id)) continue;
    // Keep the hint consistent with the other constraints: a dish filtered out
    // by cuisine, price or stall must not resurface as a reason to visit.
    const allowed = new Set(eligibleMenu(canteen, relaxed, demo).map((m) => m.id));
    const items = plantBasedItems(canteen).filter((m) => allowed.has(m.id));
    if (!items.length) continue;
    const scored = evaluate(canteen, relaxed, { now, checkMinutes, demo, includeClosed });
    if (!scored) continue;

    hints.push({
      id: canteen.id,
      name: canteen.name,
      nameZh: canteen.nameZh,
      venue: canteen.venue,
      zone: canteen.zone,
      emoji: canteen.emoji,
      rating: canteen.rating,
      walkMinutes: scored.distance,
      walkFrom: scored.walkFrom,
      status: scored.status,
      items: items.slice(0, 3).map((m) => ({ name: m.name, price: m.price, stall: m.stall })),
    });
  }

  hints.sort((a, b) => b.rating - a.rating || (a.walkMinutes ?? 99) - (b.walkMinutes ?? 99));
  return hints.slice(0, 6);
}

/**
 * Filter + rank the demo database.
 *
 * Hard constraints are never relaxed. Only eligible menu items are returned.
 */
export function search(intent, {
  now = nowInHK(), limit = MAX_RESULTS, demo = false, canteens = getCanteens(), includeClosed = false,
} = {}) {
  const effective = resolveNameCues(intent, canteens);
  const checkMinutes = effective.arrive_by ? toMinutes(effective.arrive_by) : now.minutes;
  const relaxed = [];
  // How many outlets answer the name at all, before any other filter. It tells
  // the caller apart "no outlet is called that" from "the outlet exists but
  // fails your diet/budget/hours" — two answers that need different words.
  const venueMatched = effective.requested_stall
    ? canteens.filter((c) => outletMatches(effective.requested_stall, c)).length
    : null;
  const ranked = (effective.unsupported?.length ? [] : canteens)
    .map((c) => evaluate(c, effective, { now, checkMinutes, demo, includeClosed }))
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || a.distance - b.distance || b.canteen.rating - a.canteen.rating);

  // A weak match shown confidently is worse than no match: "korean bbq" should
  // not return a coffee shop at 29% next to a food court at 74%. Keep only
  // results reasonably close to the best one; return no match otherwise.
  const best = ranked[0]?.matchPct ?? 0;
  const cutoff = Math.max(25, best * 0.6);
  const strong = ranked.filter((r) => r.matchPct >= cutoff);
  const lowConfidence = best > 0 && best < 25;
  const sort = effective.sort ?? 'best_match';
  // Best-match position over the *whole* qualifying set. The response below may
  // carry only a page of it, but the browser needs the full order to reproduce
  // this ranking after the user picks a different sort and comes back.
  const bestOrder = orderBy(strong, 'best_match');
  const rank = new Map(bestOrder.map((r, i) => [r.canteen.id, i + 1]));
  const chosen = (sort === 'best_match' ? bestOrder : orderBy(strong, sort)).slice(0, limit);

  // Exclude everything that already qualified as a match, not just the visible
  // page, so the same outlet never appears twice on screen.
  const hintList = dietHints(effective, {
    now, checkMinutes, demo, canteens, includeClosed,
    exclude: new Set(ranked.map((r) => r.canteen.id)),
  });

  // Every match has closed for the day. That is a fact worth reporting at the
  // top of the list, and the next scheduled opening is the useful number — the
  // caller turns this into a notice instead of an unexplained empty page.
  const allClosed = strong.length > 0 && strong.every((r) => !r.status.open);

  return {
    // The caller's intent, plus any cue rescued from `unsupported`, so the API
    // reports what was actually searched for.
    intent: effective,
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
      // Only set when the match is outlet-level: these are the outlet's
      // offerings, shown for context, never as answers to the dietary query.
      representativeMenu: r.canteen.representativeMenu,
      sources: r.canteen.sources,
      verified: r.canteen.verified,
      venueVerified: r.canteen.venueVerified,
      menuVerified: r.canteen.menuVerified,
      status: r.status,
      walkMinutes: r.distance,
      walkFrom: r.walkFrom,
      matchPct: r.matchPct,
      rank: rank.get(r.canteen.id),
      dietBasis: r.dietBasis,
      reasons: r.reasons,
    })),
    meta: {
      totalMatches: strong.length,
      lowConfidence,
      bestMatch: best,
      relaxed,
      sort,
      sortBasis: sortBasis(sort, effective),
      checkTime: effective.arrive_by || now.hhmm,
      dayName: now.dayName,
      evaluated: canteens.length,
      venueMatched,
      demo,
      allClosed,
      // Computed over the matches, not the directory: "the next scheduled
      // opening is tomorrow 07:30" has to describe an outlet on this list, or
      // it is a confident statement about somewhere the user never asked for.
      ...(allClosed
        ? {
          latestClose: latestClose(strong.map((r) => r.canteen), now.day),
          nextOpen: nextOpening(strong.map((r) => r.canteen), now.day),
        }
        : {}),
    },
    // Deliberately a sibling of `results`, never a member of it, and never
    // counted in `totalMatches`: these are places to ask, not dietary answers.
    hints: hintList.length
      ? {
        diet: 'vegetarian',
        title: 'May have vegetarian options',
        note: 'These outlets do not state that they are vegetarian. Their menu wording suggests plant-based dishes, so treat them as places to ask about — not as confirmed options.',
        results: hintList,
      }
      : null,
  };
}
