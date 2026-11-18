import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
process.env.DB_PATH = ':memory:';
const { validateIntent, hasConstraints } = await import('../server/schema.js');
const { search } = await import('../server/search.js');
const { recommend } = await import('../server/recommend.js');
const { getCanteens, closeDb } = await import('../server/db.js');
const { matchesDiets } = await import('../server/policy.js');
const { nowInHK } = await import('../server/time.js');
const { loadDataset, loadVocab } = await import('../server/data/loadData.js');
const { refusalFor } = await import('../server/policy.js');
const { gradeCase } = await import('../scripts/evaluate-case.mjs');
const cases = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf8'));
const now = { day: 5, dayName: 'Fri', minutes: 750, hhmm: '12:30' };
const intent = (raw) => validateIntent(raw).intent;
const source = { label: 'Synthetic test source, not a real menu', url: 'https://example.org/test-menu', checkedAt: '2026-10-23' };
const item = (diet, price = 30) => ({
  name: `${diet} fixture`, price, stall: 'Synthetic Stall', verified: true,
  cuisines: ['noodles'],
  is_vegetarian: diet === 'vegetarian', is_certified_halal: diet === 'halal', ingredients_listed: null,
  dietary_tags: [diet], dietary_tags_source: [{ ...source, tag: diet, statement: 'Synthetic claim for unit testing only' }], sources: [source],
});
const venue = {
  ...getCanteens()[0], id: 'synthetic', name: 'Synthetic Stall', verified: true,
  cuisines: ['noodles', 'coffee'], diets: ['halal', 'vegetarian'], zone: 'Main Campus',
  rating: 4.5, lat: 22.28302, lng: 114.13736,
  menu: [item('halal'), item('vegetarian')], sources: [source],
  hours: Array.from({ length: 7 }, () => ['08:00', '20:00']),
};
const find = (raw, extra = {}) => search(intent(raw), { now, canteens: [venue], ...extra });

test('fixed evaluation split is exactly 15/10/5', () => {
  assert.equal(cases.length, 30);
  assert.deepEqual(['dietary', 'time_location', 'refusal'].map((g) => cases.filter((c) => c.group === g).length), [15, 10, 5]);
});
for (const c of cases.filter((c) => c.expect.reason)) {
  test(`local policy ${c.id}: ${c.query}`, async () => {
    const result = await recommend(c.query, { now, parser: async () => assert.fail('Safety must precede API calls') });
    assert.equal(result.reason, c.expect.reason);
    assert.deepEqual(result.results, []);
    assert.match(result.disclaimer, /not a safety guarantee/);
  });
}
test('venue-verified records qualify even when their dishes are representative', () => {
  const result = search(intent({ cuisines: ['noodles'] }), { now });
  assert.ok(result.results.length > 0);
  assert.ok(result.results.every((r) => r.venueVerified === true));
  // Most dishes stay representative; only outlets whose page states a dietary
  // certification carry item-level evidence, and the flags keep them apart.
  assert.ok(result.results.some((r) => r.menuVerified === false && r.verified === false));
  assert.ok(getCanteens().flatMap((c) => c.menu).some((m) => m.verified === false));
});
test('an unverified venue is still excluded unless demonstration mode is on', () => {
  const unverified = { ...venue, verified: false };
  assert.equal(search(intent({ cuisines: ['noodles'] }), { now, canteens: [unverified] }).results.length, 0);
  assert.ok(search(intent({ cuisines: ['noodles'] }), { now, canteens: [unverified], demo: true }).results.length > 0);
});
test('a certified outlet answers a dietary query with dish evidence', () => {
  const result = search(intent({ diets: ['vegetarian'] }), { now, limit: 20 });
  const bijas = result.results.find((r) => r.id === 'bijas-vegetarian');
  assert.equal(bijas.dietBasis, 'dish');
  assert.ok(bijas.menu.every((m) => m.is_vegetarian === true && m.dietary_tags.includes('vegetarian')));
  // A reviewed dish outranks an outlet-level listing, whatever the star rating.
  assert.equal(result.results[0].id, 'bijas-vegetarian');
});
test('only outlets whose page states a diet may answer a dietary query', () => {
  const result = search(intent({ diets: ['halal'] }), { now, limit: 20 });
  assert.deepEqual(result.results.map((r) => r.id).sort(), ['27-kebab-house', 'bijas-vegetarian']);
  assert.ok(result.results.every((r) => r.dietBasis === 'dish'));
  // Cafés that merely serve salads carry no vegetarian claim.
  assert.ok(!search(intent({ diets: ['vegetarian'] }), { now, limit: 20 }).results
    .some((r) => /Starbucks|Grove|Subway/i.test(r.name)));
});
test('outlets that may serve vegetarian food are hints, never results', () => {
  const result = search(intent({ diets: ['vegetarian'] }), { now, limit: 20 });
  const hints = result.hints?.results ?? [];
  assert.ok(hints.length > 0);
  assert.equal(result.hints.diet, 'vegetarian');

  const matchIds = new Set(result.results.map((r) => r.id));
  assert.ok(hints.every((h) => !matchIds.has(h.id)));
  // A hint carries no score, no percentage and no dietary basis: there is
  // nothing for a reader to mistake for a checked result.
  assert.ok(hints.every((h) => h.matchPct === undefined && h.dietBasis === undefined));
  assert.equal(result.meta.totalMatches, result.results.length);
});

test('a hint never comes from a dish name that names meat or fish', () => {
  const result = search(intent({ diets: ['vegetarian'] }), { now, limit: 20 });
  const names = (result.hints?.results ?? []).flatMap((h) => h.items.map((i) => i.name));
  assert.ok(names.length > 0);
  assert.ok(!names.some((n) => /\b(chicken|tuna|turkey|beef|ham|bacon|salmon)\b/i.test(n)));
  // "Chicken Caesar Salad" is the case that a naive salad match would surface.
  assert.ok(!(result.hints?.results ?? []).some((h) => /^Starbucks/i.test(h.name)));
});

test('hints are vegetarian-only and never blur another diet filter', () => {
  assert.equal(search(intent({ diets: ['halal'] }), { now }).hints, null);
  assert.equal(search(intent({ diets: ['vegan'] }), { now }).hints, null);
  assert.equal(search(intent({ cuisines: ['noodles'] }), { now }).hints, null);
  // A combined request leaves nothing for a name-level hint to answer.
  assert.equal(search(intent({ diets: ['vegetarian', 'halal'] }), { now }).hints, null);
});

test('hints obey the other hard constraints', () => {
  const result = search(intent({ diets: ['vegetarian'], cuisines: ['noodles'] }), { now, limit: 20 });
  for (const hint of result.hints?.results ?? []) {
    assert.ok(hint.items.every((i) => /mixian|noodle/i.test(i.name)));
  }
});

test('an outlet-level listing answers where, not which dish', () => {
  const listed = {
    ...venue, id: 'listed-outlet', diets: ['vegetarian'],
    menu: [item('halal')].map((m) => ({
      ...m, verified: false, is_vegetarian: null, is_certified_halal: null,
      dietary_tags: [], dietary_tags_source: [], sources: [],
    })),
  };
  const result = search(intent({ diets: ['vegetarian'] }), { now, canteens: [listed] });
  assert.equal(result.results.length, 1);
  const [hit] = result.results;
  assert.equal(hit.dietBasis, 'venue');
  // No dish is offered as the answer, and nothing on the card claims review.
  assert.deepEqual(hit.menu, []);
  assert.equal(hit.representativeMenu.length, 1);
  assert.equal(hit.verified, false);
  assert.equal(hit.menuVerified, false);
  assert.ok(hit.reasons.some((r) => /outlet-level/.test(r.text)));
});
test('a reviewed dish outranks an outlet that only lists the diet', () => {
  // Identical in every respect except who makes the claim, so the ranking
  // difference can only come from the evidence tier.
  const dish = item('vegetarian');
  const reviewed = { ...venue, id: 'reviewed', name: 'Reviewed', diets: [], menu: [dish] };
  const listed = {
    ...venue, id: 'listed', name: 'Listed Only', diets: ['vegetarian'],
    menu: [{
      ...dish, verified: false, is_vegetarian: null, is_certified_halal: null,
      dietary_tags: [], dietary_tags_source: [], sources: [],
    }],
  };
  const result = search(intent({ diets: ['vegetarian'] }), { now, canteens: [listed, reviewed] });
  assert.deepEqual(result.results.map((r) => r.id), ['reviewed', 'listed']);
  assert.ok(result.results[1].matchPct < result.results[0].matchPct);
});
test('vegan is not inferred from a vegetarian certification', () => {
  // BIJAS is "Chinese Style Vegetarian"; the page never says vegan, so a vegan
  // query must stay empty rather than borrowing the vegetarian claim.
  assert.deepEqual(search(intent({ diets: ['vegan'] }), { now }).results, []);
});
test('opt-in demo still cannot establish dietary suitability', () => {
  const representative = {
    ...venue, id: 'unverified-demo', verified: false, sources: [],
    menu: [item('vegetarian')].map((m) => ({
      ...m, verified: false, is_vegetarian: null, is_certified_halal: null,
      dietary_tags: [], dietary_tags_source: [], sources: [],
    })),
  };
  assert.ok(search(intent({ cuisines: ['noodles'] }), { now, canteens: [representative], demo: true }).results.length > 0);
  assert.equal(search(intent({ diets: ['vegetarian'] }), { now, canteens: [representative], demo: true }).results.length, 0);
});
test('a dish-level match filters dishes, never selecting meat for a vegetarian query', () => {
  const dishLevel = { ...venue, id: 'dish-level', diets: [], menu: [item('halal'), item('vegetarian')] };
  const result = search(intent({ diets: ['vegetarian'] }), { now, canteens: [dishLevel] });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].dietBasis, 'dish');
  assert.deepEqual(result.results[0].menu.map((m) => m.name), ['vegetarian fixture']);
});
test('all dietary constraints must hold on the same dish', () => {
  const strict = { ...venue, id: 'strict', diets: [], menu: [item('vegetarian'), item('halal')] };
  assert.equal(search(intent({ diets: ['vegetarian', 'halal'] }), { now, canteens: [strict] }).results.length, 0);
  assert.equal(matchesDiets(item('vegetarian'), ['vegetarian', 'halal']), false);
});
test('hard constraints are never relaxed', () => {
  for (const raw of [{ max_price_hkd: 10 }, { requested_stall: 'Not in dataset' },
    { arrive_by: '22:00' }, { zone: 'Unknown Campus' }, { cuisines: ['sushi'] }]) {
    const result = find(raw);
    assert.deepEqual(result.results, []);
    assert.deepEqual(result.meta.relaxed, []);
  }
});
test('future time is enforced without open_now and closing is exclusive', () => {
  assert.equal(find({ arrive_by: '20:00', open_now: false }).results.length, 0);
  assert.equal(find({ arrive_by: '19:59', open_now: false }).results.length, 1);
});
const late = { day: 3, dayName: 'Wed', minutes: 1350, hhmm: '22:30' };
const evening = { ...venue, hours: Array.from({ length: 7 }, () => ['08:00', '20:00']) };
test('after closing, a match reports its next scheduled opening instead of a bare closure', () => {
  const raw = { cuisines: ['noodles'], open_now: true };
  // The default search still answers the literal question: nothing is open.
  assert.equal(find(raw, { now: late, canteens: [evening] }).results.length, 0);

  const fallback = find(raw, { now: late, canteens: [evening], includeClosed: true });
  assert.equal(fallback.results.length, 1);
  const card = fallback.results[0];
  assert.equal(card.status.open, false);
  assert.equal(card.status.opensAt, '08:00');
  assert.equal(card.status.reopensAt, '08:00');
  assert.equal(card.status.reopensInDays, 1);
  assert.equal(card.status.reopensDay, 'Thu');
  assert.equal(fallback.meta.allClosed, true);
  assert.equal(fallback.meta.latestClose, '20:00');
});
test('open-now after closing returns labelled matches, not a dead end', async () => {
  const parser = async () => ({ ok: true, intent: { cuisines: ['noodles'], open_now: true } });
  const result = await recommend('noodles', { now: late, parser });
  assert.ok(result.results.length > 0);
  assert.equal(result.meta.scheduleOnly, 'closed_now');
  assert.ok(result.results.every((r) => r.status.open === false));
  assert.ok(result.results.every((r) => typeof r.status.reopensAt === 'string'));
  assert.match(result.notice, /Nothing is open at 22:30/);
  assert.equal(result.reason, null);
});
test('a plain after-hours request answers and states that the matches have closed', async () => {
  const parser = async () => ({ ok: true, intent: { cuisines: ['noodles'] } });
  const result = await recommend('noodles', { now: late, parser });
  assert.ok(result.results.length > 0);
  assert.ok(result.results.every((r) => r.status.open === false));
  assert.equal(result.meta.scheduleOnly, undefined);
  assert.match(result.notice, /None of these matches is open at 22:30/);
});
test('unknown dietary and location constraints are retained as unsupported', () => {
  for (const raw of [{ diets: ['nut_free'] }, { near: 'Imaginary Castle' }, { max_price_hkd: -1 }]) {
    const parsed = intent(raw);
    assert.ok(parsed.unsupported.length > 0);
    assert.equal(search(parsed, { now, canteens: [venue] }).results.length, 0);
  }
});
test('open-now and price-only prompts count as constraints', () => {
  assert.ok(hasConstraints(intent({ open_now: true })));
  assert.ok(hasConstraints(intent({ price_preference: 'cheap' })));
  assert.equal(hasConstraints(intent({})), false);
});
test('HK clock uses local day independently of machine timezone', () => {
  const result = nowInHK(new Date('2026-10-23T17:00:00Z'));
  assert.equal(result.day, 6);
  assert.equal(result.hhmm, '01:00');
});
test('omitted explicit dietary requirement is restored after parsing', async () => {
  const result = await recommend('vegetarian lunch', {
    now, demo: true, parser: async () => ({ ok: true, intent: intent({ meal: 'lunch' }) }),
  });
  assert.deepEqual(result.intent.diets, ['vegetarian']);
  // The restored filter is actually applied: every card states the basis of its
  // dietary claim, and no evidence-free dish is offered as an answer.
  assert.ok(result.results.length > 0);
  assert.ok(result.results.every((r) => r.dietBasis === 'dish' || r.dietBasis === 'venue'));
  assert.ok(result.results.every((r) => r.menu.every((m) => m.dietary_tags.length === 0 || m.verified)));
  assert.ok(result.results.every((r) => r.dietBasis === 'dish'));
});
test('cached walkthroughs are explicitly labelled and unknown requests stay offline', async () => {
  const parser = async () => ({ ok: false, error: { code: 'no_key' } });
  const cached = await recommend('I want noodles near Centennial Campus.', { now, demo: true, parser });
  assert.equal(cached.mode, 'cached');
  assert.match(cached.notice, /not current opening status/);
  assert.ok(cached.results.length > 0);
  const other = await recommend('An uncached request', { now, parser });
  assert.equal(other.offline, true);
  const bypass = await recommend('I want noodles near Centennial Campus.', { now, parser, allowCache: false });
  assert.equal(bypass.offline, true);
});
test('sorting requests are not confused with placing orders', () => {
  assert.equal(refusalFor('Order results by cheapest'), null);
  assert.equal(refusalFor('Order by price'), null);
  assert.equal(refusalFor('Buy this for me').reason, 'ordering_refused');
});
test('future-day requirements cannot be silently omitted by the model', async () => {
  const result = await recommend('Noodles tomorrow', {
    now, demo: true, parser: async () => ({ ok: true, intent: intent({ cuisines: ['noodles'] }) }),
  });
  assert.equal(result.reason, 'no_match');
  assert.ok(result.intent.unsupported.length);
});
test('loader rejects invented positive claims and malformed evidence', () => {
  const dataset = JSON.parse(readFileSync(new URL('../data/canteens.json', import.meta.url), 'utf8'));
  const vocab = loadVocab();
  const positive = structuredClone(dataset);
  positive.canteens[0].menu[0].is_certified_halal = true;
  assert.throws(() => loadDataset(vocab, positive), /positive dietary claim/);
  const dated = structuredClone(dataset);
  dated.canteens[0].verified = true;
  dated.canteens[0].sources = [{ ...source, checkedAt: '2026-02-31' }];
  assert.throws(() => loadDataset(vocab, dated), /dated HTTPS sources/);
  const missing = structuredClone(dataset);
  delete missing.canteens[0].menu[0].ingredients_listed;
  assert.throws(() => loadDataset(vocab, missing), /ingredients_listed/);
});
test('item evidence survives the database round trip without converting unknown to false', () => {
  const raw = JSON.parse(readFileSync(new URL('../data/canteens.json', import.meta.url), 'utf8'));
  for (const record of getCanteens()) {
    assert.deepEqual(record.menu, raw.canteens.find((c) => c.id === record.id).menu);
  }
});
test('every outlet sits inside the rectangle of the campus it claims', () => {
  // Two fields have to agree, and nothing else checks them: `zone` decides the
  // campus filter, lat/lng decides walk times. Subway and the Sandwich Club
  // kiosk at Run Run Shaw Podium were once filed as Centennial because the
  // podium's "Run Run Shaw" name was read as the Centennial tower; HKU's own
  // outlet list marks both as Main Campus. No single field looked wrong on its
  // own, so this is the test that catches it.
  const boxes = {
    'Main Campus': { south: 22.2815, north: 22.2850, west: 114.1360, east: 114.1390 },
    'Centennial Campus': { south: 22.2810, north: 22.2842, west: 114.1335, east: 114.1356 },
    'Sassoon Road': { south: 22.2695, north: 22.2730, west: 114.1295, east: 114.1320 },
  };
  for (const canteen of getCanteens()) {
    const box = boxes[canteen.zone];
    assert.ok(box, `${canteen.id}: unknown zone "${canteen.zone}"`);
    assert.ok(
      canteen.lat >= box.south && canteen.lat <= box.north &&
      canteen.lng >= box.west && canteen.lng <= box.east,
      `${canteen.id} is filed under ${canteen.zone} but its coordinates (${canteen.lat}, ${canteen.lng}) are outside that campus`
    );
  }
});

test('Run Run Shaw Podium outlets are Main Campus', () => {
  const podium = getCanteens().filter((c) => c.venue === 'Run Run Shaw Podium');
  assert.equal(podium.length, 2);
  assert.ok(podium.every((c) => c.zone === 'Main Campus'));
});

test('all four dietary constraints survive validation', () => {
  assert.deepEqual(intent({ diets: ['halal', 'vegetarian', 'vegan', 'gluten_free'] }).diets,
    ['halal', 'vegetarian', 'vegan', 'gluten_free']);
});
test('malformed constraints fail validation instead of becoming unrestricted searches', () => {
  for (const raw of [
    { diets: { halal: true } }, { diets: [123] }, { open_now: 'true' },
    { requested_stall: 123 }, { zone: {} }, { unsupported: 'tomorrow' },
    { refusal: 'unknown_refusal' }, { max_price_hkd: true },
  ]) assert.equal(validateIntent(raw).ok, false, JSON.stringify(raw));
});
test('a decimal budget is never rounded upward', () => {
  assert.equal(intent({ max_price_hkd: 29.9 }).max_price_hkd, 29.9);
  assert.equal(find({ max_price_hkd: 29.9 }).results.length, 0);
});
test('dietary cuisines cannot bypass dietary evidence', () => {
  assert.ok(intent({ cuisines: ['vegetarian'] }).diets.includes('vegetarian'));
  const result = search(intent({ cuisines: ['vegetarian'] }), { now, demo: true, limit: 20 });
  assert.ok(result.results.length > 0);
  // The cuisine became a diet filter, so every card must state which basis it
  // rests on, and no unverified dish may carry a dietary tag.
  assert.ok(result.results.every((r) => r.dietBasis === 'dish' || r.dietBasis === 'venue'));
  assert.ok(result.results.every((r) => r.menu.every((m) => m.dietary_tags.length === 0 || m.verified)));
});
test('a walking budget without an origin is not evaluated from an invented landmark', () => {
  assert.equal(find({ max_walk_minutes: 5 }).results.length, 0);
});
test('sorting language is not an ordering request', () => {
  assert.equal(refusalFor('Put the results in order of price'), null);
  assert.equal(refusalFor('Where can I buy vegetarian food?'), null);
});
test('cuisine filtering returns matching dishes, not the first dish in a food court', () => {
  const mixed = { ...venue, menu: [{ ...item('halal'), name: 'Rice fixture', cuisines: ['rice'] }, item('vegetarian')] };
  const result = find({ cuisines: ['noodles'] }, { canteens: [mixed] });
  assert.equal(result.results.length, 1);
  assert.deepEqual(result.results[0].menu.map((m) => m.name), ['vegetarian fixture']);
});
test('a café with one sandwich does not outrank a sandwich counter', () => {
  const dish = (name, cuisines, price) => ({ ...item('halal', price), name, cuisines });
  const counter = {
    ...venue, id: 'counter', name: 'Sandwich Counter', rating: 3.8,
    menu: [dish('Club Sandwich', ['sandwich', 'western'], 40), dish('Tuna Sub', ['sandwich', 'western'], 45)],
  };
  const cafe = {
    ...venue, id: 'cafe', name: 'Cafe', rating: 4.6,
    menu: [dish('Latte', ['coffee'], 20), dish('Croissant', ['bakery', 'sandwich'], 30)],
  };
  const result = search(intent({ cuisines: ['sandwich'] }), { now, canteens: [cafe, counter] });
  assert.deepEqual(result.results.map((r) => r.id), ['counter', 'cafe']);
  // The card quotes the dish that was asked for, not the cheapest thing on offer.
  assert.deepEqual(result.results[0].menu.map((m) => m.name), ['Club Sandwich', 'Tuna Sub']);
  assert.equal(result.results[0].avgPrice, 40);
  assert.deepEqual(result.results[1].menu.map((m) => m.name), ['Croissant']);
});
test('"sandwich" surfaces the sandwich counters, not the coffee shops that stock one', () => {
  const result = search(intent({ cuisines: ['sandwich'], keywords: ['sandwich'] }), { now });
  assert.equal(result.results.length, 3);
  assert.match(result.results[0].name, /Sandwich/i);
  assert.match(result.results[1].name, /Sandwich/i);
  assert.ok(result.results.some((r) => /Subway/i.test(r.name)));
  assert.ok(!result.results.some((r) => /Starbucks/i.test(r.name)));
  assert.ok(result.results.every((r) => r.menu.every((m) => m.cuisines.includes('sandwich'))));
});
test('a venue name is a search term, not an unsupported requirement', () => {
  const result = search(intent({ unsupported: ['synthetic stall'] }), { now, canteens: [venue] });
  assert.equal(result.results.length, 1);
  assert.deepEqual(result.intent.unsupported, []);
  assert.deepEqual(result.intent.keywords, ['synthetic stall']);
});
// Names are typed from memory, and the dataset spells them its own way. These
// are the spellings a person actually produces for the same two outlets.
const named = (raw) => search(intent(raw), { now }).results.map((r) => r.id);
test('a named outlet is found however its name is spelled', () => {
  for (const raw of [
    { requested_stall: 'tamjai' }, { requested_stall: 'TamJai SamGor' },
    { requested_stall: 'tam jai sam gor' }, { requested_stall: '譚仔三哥' },
  ]) assert.deepEqual(named(raw), ['tamjai-samgor'], JSON.stringify(raw));

  assert.deepEqual(named({ requested_stall: 'ju ying tai' }), ['juying-tai']);
  // Two outlets genuinely carry the name; both are answers, not a guess.
  assert.deepEqual(named({ requested_stall: 'subway' }).sort(), ['subway-rrs', 'subway-sassoon']);
  // Partial names are a real way to search, and the name is why it ranks.
  const partial = search(intent({ requested_stall: 'tamjai' }), { now });
  assert.equal(partial.meta.venueMatched, 1);
  assert.ok(partial.results[0].reasons.some((r) => /outlet you named/.test(r.text)));
  assert.ok(partial.results[0].matchPct >= 50);
});
test('a name echoed back as an "ambiguous" remark does not block the lookup', async () => {
  // Observed from the parser on a bare "tamjai": it fills requested_stall and
  // also calls its own parse ambiguous. An unsupported entry stops retrieval,
  // so the remark would hide the outlet the user just named.
  const parser = async () => ({
    ok: true,
    intent: { requested_stall: 'tamjai', unsupported: ['ambiguous query "tamjai"'] },
  });
  const result = await recommend('tamjai', { now, parser });
  assert.deepEqual(result.results.map((r) => r.id), ['tamjai-samgor']);
  assert.deepEqual(result.intent.unsupported, []);

  // A real limitation that happens to mention the name is still honoured.
  const kept = search(intent({ requested_stall: 'tamjai', unsupported: ['tamjai tomorrow'] }), { now });
  assert.deepEqual(kept.intent.unsupported, ['tamjai tomorrow']);
  assert.equal(kept.results.length, 0);
});
test('a name typed into "unsupported" keeps its spacing problem invisible', () => {
  const result = search(intent({ unsupported: ['ju ying tai'] }), { now });
  assert.deepEqual(result.intent.unsupported, []);
  assert.deepEqual(result.intent.keywords, ['ju ying tai']);
  assert.equal(result.results[0]?.id, 'juying-tai');
});
test('the after-hours summary describes the matches, not the whole directory', () => {
  const night = { day: 3, dayName: 'Wed', minutes: 1350, hhmm: '22:30' };
  const result = search(intent({ requested_stall: 'tamjai' }), { now: night });
  assert.deepEqual(result.results.map((r) => r.id), ['tamjai-samgor']);
  assert.equal(result.meta.nextOpen.opensAt, '07:45');
  assert.equal(result.meta.nextOpen.dayName, 'Thu');
});
test('an outlet that does not exist is named as missing, not as missing food', async () => {
  const parser = async () => ({ ok: true, intent: { requested_stall: 'nandos' } });
  const result = await recommend('nandos', { now, parser });
  assert.equal(result.reason, 'no_match');
  assert.deepEqual(result.results, []);
  assert.equal(result.meta.venueMatched, 0);
  assert.match(result.notice, /I don't have an outlet called "nandos"/);
  // The food-availability wording belongs to cuisine and diet queries, not names.
  assert.ok(!/No match found in the current dataset/.test(result.notice));
});
test('a named outlet that fails a diet keeps the dietary answer', async () => {
  const parser = async () => ({ ok: true, intent: { requested_stall: 'tamjai', diets: ['vegetarian'] } });
  const result = await recommend('vegetarian at tamjai', { now, parser, allowCache: false });
  assert.deepEqual(result.results, []);
  // The outlet was found; what failed was the unreviewed menu, and the notice
  // must say that rather than claim the outlet does not exist.
  assert.equal(result.meta.venueMatched, 1);
  assert.ok(!/don't have an outlet called/.test(result.notice));
});
test('"a stall named X" for an unknown X reports the name, before any model call', async () => {
  const result = await recommend('Is there a stall named Imaginary Moon Cafe?', {
    now, parser: async () => assert.fail('Safety must precede API calls'),
  });
  assert.equal(result.reason, 'no_match');
  assert.match(result.notice, /I don't have an outlet called "Imaginary Moon Cafe"/);
});
test('cheapest ordering uses the matching dish rather than venue-wide averages', () => {
  const inexpensive = { ...venue, id: 'cheap-item', avgPrice: 100, menu: [item('vegetarian', 20)] };
  const expensive = { ...venue, id: 'expensive-item', avgPrice: 10, menu: [item('vegetarian', 50)] };
  const result = find({ diets: ['vegetarian'], sort: 'cheapest' }, { canteens: [expensive, inexpensive] });
  assert.deepEqual(result.results.map((r) => r.id), ['cheap-item', 'expensive-item']);
});
test('the whole qualifying set is returned once asked, and the page is its prefix', () => {
  const raw = { cuisines: ['noodles'], near: 'centennial_campus', open_now: true };
  const page = search(intent(raw), { now });
  const all = search(intent(raw), { now, limit: 24 });
  assert.equal(page.results.length, 3);
  assert.ok(all.meta.totalMatches > page.results.length);
  // A limit above the dataset size means nothing is truncated.
  assert.equal(all.results.length, all.meta.totalMatches);
  // `rank` is the best-match position over the whole set, not over the page.
  assert.deepEqual(all.results.map((r) => r.rank), [1, 2, 3, 4, 5]);
  // The default page is the first three of that ranking, so expanding never
  // reshuffles what the user is already looking at.
  assert.deepEqual(page.results.map((r) => r.id), all.results.slice(0, 3).map((r) => r.id));
});
test('sorting the whole set can lift an outlet the first page never showed', () => {
  const raw = { cuisines: ['noodles'], near: 'centennial_campus', open_now: true };
  const byBest = search(intent(raw), { now, limit: 24 }).results;
  const byCheap = search(intent({ ...raw, sort: 'cheapest' }), { now, limit: 24 }).results;
  // A sort reorders the same matches; it never changes who qualified.
  assert.deepEqual(byCheap.map((r) => r.id).sort(), byBest.map((r) => r.id).sort());
  const prices = byCheap.map((r) => r.avgPrice ?? Infinity);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
  // JuYing Tai is 4th by relevance but cheaper than two of the first three.
  assert.ok(byCheap.slice(0, 3).some((r) => r.rank > 3));
  assert.ok(byCheap.slice(0, 3).map((r) => r.id).includes('juying-tai'));
  // Whatever the displayed order, `rank` still carries the original ranking.
  assert.deepEqual(byCheap.map((r) => r.rank).sort((a, b) => a - b), byBest.map((r) => r.rank));
});
test('a verified venue does not make its unverified returned menu trustworthy', () => {
  const mixed = { ...venue, menu: [{ ...item('vegetarian'), verified: false, dietary_tags: [], dietary_tags_source: [], is_vegetarian: null }] };
  const result = find({ cuisines: ['noodles'] }, { canteens: [mixed], demo: true });
  assert.equal(result.results[0].verified, false);
  assert.deepEqual(result.results[0].diets, []);
});
test('independent evaluation accepts a genuine fixture and rejects invented dishes, stalls, hours and sources', () => {
  const expected = { diets: ['vegetarian'], cuisines: ['noodles'], arrive_by: '12:30', near: 'main_library' };
  const response = {
    ok: true, mode: 'live', intent: intent(expected),
    disclaimer: 'Informational only, not a safety guarantee.',
    ...find(expected),
  };
  assert.equal(gradeCase(expected, response, [venue], now).pass, true);
  for (const change of [
    (r) => { r.results[0].menu[0].name = 'Invented dish'; },
    (r) => { r.results[0].menu[0].stall = 'Other stall'; },
    (r) => { r.results[0].menu[0].sources[0].url = 'https://example.org/invented'; },
    (r) => { r.results[0].status.closesAt = '23:59'; },
    (r) => { r.results[0].walkFrom.key = 'hku_station'; },
    (r) => { r.disclaimer = ''; },
  ]) {
    const changed = structuredClone(response);
    change(changed);
    assert.equal(gradeCase(expected, changed, [venue], now).pass, false);
  }
});
test('unknown prices stay unknown and cannot satisfy a hard budget', () => {
  const unknown = { ...venue, rating: null, priceLevel: null, avgPrice: null, image: null,
    menu: [{ ...item('vegetarian'), price: null }] };
  const result = find({ diets: ['vegetarian'] }, { canteens: [unknown] });
  assert.equal(result.results[0].menu[0].price, null);
  assert.equal(result.results[0].avgPrice, null);
  assert.equal(find({ diets: ['vegetarian'], max_price_hkd: 100 }, { canteens: [unknown] }).results.length, 0);
  const raw = JSON.parse(readFileSync(new URL('../data/canteens.json', import.meta.url), 'utf8'));
  assert.doesNotThrow(() => loadDataset(loadVocab(), { landmarks: raw.landmarks, canteens: [unknown] }));
});
test('meal-only queries exclude outlets outside the declared meal window or closed that day', () => {
  const early = { ...venue, hours: Array.from({ length: 7 }, () => ['08:00', '15:00']) };
  const closed = { ...venue, hours: Array(7).fill(null) };
  assert.equal(find({ meal: 'dinner' }, { canteens: [early] }).results.length, 0);
  assert.equal(find({ meal: 'lunch' }, { canteens: [early] }).results.length, 1);
  assert.equal(find({ meal: 'lunch' }, { canteens: [closed] }).results.length, 0);
});
test.after(() => closeDb());
