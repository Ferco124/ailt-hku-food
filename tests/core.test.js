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
test('demo dataset never qualifies in verified mode', () => {
  assert.equal(search(intent({ cuisines: ['noodles'] }), { now }).results.length, 0);
  assert.equal(getCanteens().flatMap((c) => c.menu).filter((m) => m.verified).length, 0);
});
test('opt-in demo still cannot establish dietary suitability', () => {
  assert.ok(search(intent({ cuisines: ['noodles'] }), { now, demo: true }).results.length > 0);
  assert.equal(search(intent({ diets: ['vegetarian'] }), { now, demo: true }).results.length, 0);
});
test('filters dishes, never selecting meat for a vegetarian venue match', () => {
  const result = find({ diets: ['vegetarian'] });
  assert.equal(result.results.length, 1);
  assert.deepEqual(result.results[0].menu.map((m) => m.name), ['vegetarian fixture']);
});
test('all dietary constraints must hold on the same dish', () => {
  assert.equal(find({ diets: ['vegetarian', 'halal'] }).results.length, 0);
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
  assert.deepEqual(result.results, []);
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
  assert.equal(search(intent({ cuisines: ['vegetarian'] }), { now, demo: true }).results.length, 0);
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
test('cheapest ordering uses the matching dish rather than venue-wide averages', () => {
  const inexpensive = { ...venue, id: 'cheap-item', avgPrice: 100, menu: [item('vegetarian', 20)] };
  const expensive = { ...venue, id: 'expensive-item', avgPrice: 10, menu: [item('vegetarian', 50)] };
  const result = find({ diets: ['vegetarian'], sort: 'cheapest' }, { canteens: [expensive, inexpensive] });
  assert.deepEqual(result.results.map((r) => r.id), ['cheap-item', 'expensive-item']);
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
