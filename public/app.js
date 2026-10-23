/* HKU Canteen Finder — frontend */

const $ = (id) => document.getElementById(id);

const el = {
  form: $('searchForm'),
  input: $('query'),
  submit: $('submitBtn'),
  examples: $('examples'),
  results: $('results'),
  cards: $('cards'),
  resultsTitle: $('resultsTitle'),
  resultsSub: $('resultsSub'),
  banner: $('banner'),
  bannerText: $('bannerText'),
  errorBox: $('errorBox'),
  errorText: $('errorText'),
  retry: $('retryBtn'),
  statusChip: $('statusChip'),
  statusText: $('statusText'),
  toggleIntent: $('toggleIntent'),
  layout: $('layout'),
  intentPanel: $('intentPanel'),
  modeBadge: $('modeBadge'),
  panelFacts: $('panelFacts'),
  panelNote: $('panelNote'),
  rawDetails: $('rawDetails'),
  rawJson: $('rawJson'),
  emptyState: $('emptyState'),
  emptyGrid: $('emptyGrid'),
  footClock: $('footClock'),
  sortBar: $('sortBar'),
  modalOverlay: $('detailModal'),
  modalBody: $('modalBody'),
  modalClose: $('modalClose'),
};

// Labels and colour classes default to these maps and are overwritten from
// /api/vocab on boot, so the UI vocabulary stays in step with data/vocab.json.
const CUISINE_LABEL = {
  chinese: 'Chinese', noodles: 'Noodles', rice: 'Rice', dimsum: 'Dim sum',
  vegetarian: 'Vegetarian', vegan: 'Vegan', japanese: 'Japanese', sushi: 'Sushi',
  indian: 'Indian', curry: 'Curry', western: 'Western', sandwich: 'Sandwich',
  salad: 'Salad', coffee: 'Coffee', bakery: 'Bakery', snack: 'Snack',
  asian: 'Asian', hotpot: 'Hot pot',
};

const FACET_LABEL = {};
const FACET_COLOR = {
  budget: 't-green', quick: 't-amber', takeaway: 't-purple', 'many-seats': 't-blue',
  quiet: 't-blue', 'study-spot': 't-blue', wifi: 't-blue', 'group-dining': 't-amber',
  'sit-down': 't-purple', breakfast: 't-amber', 'lunch-only': 't-amber', dinner: 't-purple',
  'open-late': 't-pink', 'weekday-only': 't-amber', halal: 't-amber', spicy: 't-red',
  'buffet-style': 't-green', customisable: 't-purple', 'veg-thali': 't-green',
  residential: 't-blue', 'off-campus': 't-blue', international: 't-purple',
};

const SORT_LABELS = {
  best_match: 'best match', cheapest: 'cheapest', closest: 'closest', top_rated: 'top rated',
};

/** Overlay the server's vocabulary onto the fallback maps above. */
function applyVocab(vocab) {
  if (!vocab || !Array.isArray(vocab.cuisines)) return;
  for (const c of vocab.cuisines) {
    CUISINE_LABEL[c.key] = c.label;
    if (c.color) TAG_COLOR[c.key] = c.color;
  }
  for (const f of vocab.facets ?? []) {
    FACET_LABEL[f.key] = f.label;
    if (f.color) FACET_COLOR[f.key] = f.color;
  }
}

const LANDMARK_LABEL = {
  main_library: 'Main Library',
  centennial_campus: 'Centennial Campus',
  hku_station: 'HKU MTR Station',
  main_building: 'Main Building',
  knowles_building: 'Knowles Building',
  run_run_shaw: 'Run Run Shaw Tower',
  university_street: 'University Street',
  pokfulam_road: 'Pokfulam Road',
  jockey_club_village: 'Jockey Club Village',
  haking_wong: 'Haking Wong Building',
};

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );

const titleCase = (s) => String(s).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/* ---------------------- placeholder visuals (mockup) ---------------------- */

const unsplash = (id) => `https://images.unsplash.com/${id}?auto=format&fit=crop&w=900&q=60`;

// Placeholder food photography keyed by cuisine.
// All IDs verified live against the Unsplash CDN; picsum is the onerror fallback.
const CUISINE_IMG = {
  noodles: ['photo-1547592166-23ac45744acd', 'photo-1529042410759-befb1204b468'],
  rice: ['photo-1504674900247-0877df9cc836', 'photo-1546069901-ba9599a7e63c'],
  chinese: ['photo-1529042410759-befb1204b468', 'photo-1547592166-23ac45744acd'],
  dimsum: ['photo-1529042410759-befb1204b468', 'photo-1547592166-23ac45744acd'],
  hotpot: ['photo-1529042410759-befb1204b468'],
  asian: ['photo-1547592166-23ac45744acd', 'photo-1529042410759-befb1204b468'],
  sushi: ['photo-1579584425555-c3ce17fd4351'],
  japanese: ['photo-1579584425555-c3ce17fd4351', 'photo-1547592166-23ac45744acd'],
  indian: ['photo-1504674900247-0877df9cc836'],
  curry: ['photo-1504674900247-0877df9cc836', 'photo-1529042410759-befb1204b468'],
  coffee: ['photo-1495474472287-4d71bcdd2085', 'photo-1447933601403-0c6688de566e'],
  bakery: ['photo-1509440159596-0249088772ff', 'photo-1563805042-7684c019e1cb'],
  snack: ['photo-1447933601403-0c6688de566e', 'photo-1563805042-7684c019e1cb'],
  salad: ['photo-1512621776951-a57141f2eefd', 'photo-1546069901-ba9599a7e63c'],
  vegetarian: ['photo-1490645935967-10de6ba17061', 'photo-1512621776951-a57141f2eefd'],
  vegan: ['photo-1498837167922-ddd27525d352', 'photo-1546069901-ba9599a7e63c'],
  sandwich: ['photo-1482049016688-2d3e1b311543', 'photo-1551782450-a2132b4ba21d'],
  western: ['photo-1568901346375-23c9450c58cd', 'photo-1551782450-a2132b4ba21d'],
};
const DEFAULT_IMGS = ['photo-1414235077428-338989a2e8c0', 'photo-1517248135467-4c7edcad34c4'];

const hashStr = (s) => {
  let h = 0;
  for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h);
};

// Deterministic per canteen so two same-cuisine picks don't look identical.
const photoFor = (r) => {
  const key =
    r.cuisines.find((c) => CUISINE_IMG[c] && !GENERIC.has(c)) ||
    r.cuisines.find((c) => CUISINE_IMG[c]);
  const pool = key ? CUISINE_IMG[key] : DEFAULT_IMGS;
  return unsplash(pool[hashStr(r.id) % pool.length]);
};

// Placeholder sample menus keyed by cuisine.
const MENU_BY_CUISINE = {
  noodles: ['Wonton Noodle Soup', 'Beef Chow Fun', 'Scallion Oil Noodles'],
  rice: ['Daily Special Set Rice', 'Char Siu Rice', 'Three-Treasure Rice'],
  chinese: ['Roast Pork Rice', 'Steamed Fish Set', 'Vegetable Stir-Fry'],
  dimsum: ['Har Gow (4 pcs)', 'Siu Mai (4 pcs)', 'Char Siu Bao (3 pcs)'],
  vegetarian: ['Veggie Set Meal', 'Mapo Tofu (meat-free)', "Buddha's Delight Rice"],
  vegan: ["Buddha's Delight Rice", 'Veggie Set Meal', 'Tofu & Mushroom Bowl'],
  japanese: ['Salmon Nigiri Set', 'Tuna Roll', 'Chicken Donburi'],
  sushi: ['Salmon Nigiri Set', 'California Roll', 'Chirashi Bowl'],
  indian: ['Chicken Tikka Masala', 'Veg Thali', 'Garlic Naan'],
  curry: ['Curry Rice Set', 'Chicken Katsu Curry', 'Dhal & Roti'],
  western: ['Smoked Salmon Cream Pasta', 'All-Day Western Breakfast', 'Flat White / Cafe Latte'],
  sandwich: ['Grilled Chicken Sub', 'Tuna Melt', 'Fresh Salad Wrap'],
  salad: ['Caesar Salad', 'Quinoa Power Bowl', 'Garden Salad'],
  coffee: ['Flat White', 'Café Latte', 'Butter Croissant'],
  bakery: ['Butter Croissant', 'Pain au Chocolat', 'Bake of the Day'],
  snack: ['Assorted Snacks', 'Instant Noodles', 'Fried Dumplings'],
  asian: ['Hainanese Chicken Rice', 'Nasi Lemak', 'Satay Skewers'],
  hotpot: ['Hotpot Set for Two', 'A-la-carte Toppings', 'Soup Base Choice'],
};
const DEFAULT_MENU = ["Today's Special", 'Set Meal A', 'Drink of the Day'];

// Broad labels used only when nothing more specific matches.
const GENERIC = new Set(['chinese', 'asian']);

/** Three placeholder menu items with prices hovering around the average. */
function menuFor(r) {
  const names = [];
  // Prefer cuisines with a specific menu; skip generic 'chinese'/'asian' if possible.
  const ordered = [
    ...r.cuisines.filter((c) => MENU_BY_CUISINE[c] && !GENERIC.has(c)),
    ...r.cuisines.filter((c) => GENERIC.has(c)),
  ];
  for (const c of ordered) {
    for (const m of MENU_BY_CUISINE[c] || []) if (!names.includes(m)) names.push(m);
    if (names.length >= 3) break;
  }
  const list = (names.length ? names : DEFAULT_MENU).slice(0, 3);
  const base = Math.round(r.avgPrice);
  const offsets = [0, 6, -8];
  return list.map((name, i) => ({ name, price: Math.max(8, base + offsets[i]) }));
}

function to12h(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}:${String(m).padStart(2, '0')} ${ap}`;
}

const TAG_COLOR = {
  noodles: 't-red', rice: 't-red', chinese: 't-red', dimsum: 't-red', hotpot: 't-red',
  japanese: 't-pink', sushi: 't-pink',
  indian: 't-amber', curry: 't-amber', asian: 't-amber', snack: 't-amber',
  western: 't-purple', sandwich: 't-purple', coffee: 't-purple', bakery: 't-purple',
  salad: 't-blue',
  vegetarian: 't-green', vegan: 't-green',
};

let lastQuery = '';
let busy = false;

// Testing aid: open the app with ?at=12:30 to evaluate opening hours at a
// fixed time instead of the current Hong Kong time.
const timeOverride = (() => {
  const at = new URLSearchParams(location.search).get('at');
  return at && /^([01]\d|2[0-3]):[0-5]\d$/.test(at) ? at : null;
})();

/* ------------------------------ status ------------------------------ */

function setStatus(state, text) {
  el.statusChip.dataset.state = state;
  el.statusText.textContent = text;
}

/* ------------------------------ render ------------------------------ */

function renderEmptyState(list) {
  if (!list?.length) return;
  el.emptyGrid.innerHTML = list
    .map(
      (c) =>
        `<div class="empty-tile"><span class="em">${esc(c.emoji)}</span><span class="nm">${esc(c.name)}</span></div>`
    )
    .join('');
}

function skeleton() {
  el.results.hidden = false;
  el.emptyState.hidden = true;
  el.errorBox.hidden = true;
  el.banner.hidden = true;
  el.resultsTitle.textContent = 'Searching…';
  el.resultsSub.textContent = 'Reading your request, then filtering the canteen list.';
  el.cards.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
}

let lastResults = [];
let lastMeta = null;

/** "Checked 15 canteens · as of Mon 12:00 HKT · Sorted by cheapest (average price)" */
function paintResultsSub() {
  const meta = lastMeta || {};
  const n = lastResults.length;
  const bits = [];
  if (meta.evaluated > 0) bits.push(`Checked ${meta.evaluated} canteens`);
  bits.push(`as of ${meta.dayName ?? ''} ${meta.checkTime ?? ''} HKT`);
  if (timeOverride) bits.push('fixed test time');
  if (meta.totalMatches > n) bits.push(`${meta.totalMatches} matched in total`);
  if (n) {
    const label = SORT_LABELS[meta.sort] || SORT_LABELS.best_match;
    bits.push(meta.sortBasis ? `Sorted by ${label} (${meta.sortBasis})` : `Sorted by ${label}`);
  }
  el.resultsSub.textContent = bits.join(' · ');
}

function paintSortBar() {
  const show = lastResults.length > 1;
  el.sortBar.hidden = !show;
  if (!show) return;
  const active = lastMeta?.sort ?? 'best_match';
  for (const btn of el.sortBar.querySelectorAll('.sortbtn')) {
    const on = btn.dataset.sort === active;
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-pressed', String(on));
  }
}

/**
 * Re-order the results already on screen. The ordering a user asks for after
 * the fact should not cost another model call, so this simply re-sorts the same
 * result set with the same rules the server uses.
 */
function resortLocal(sort) {
  if (!lastResults.length) return;
  const cmp = {
    cheapest: (a, b) => a.avgPrice - b.avgPrice || b.matchPct - a.matchPct || a.walkMinutes - b.walkMinutes,
    closest: (a, b) => a.walkMinutes - b.walkMinutes || b.matchPct - a.matchPct,
    top_rated: (a, b) => b.rating - a.rating || b.matchPct - a.matchPct,
    best_match: (a, b) => b.matchPct - a.matchPct || a.walkMinutes - b.walkMinutes || b.rating - a.rating,
  }[sort];

  lastMeta = { ...lastMeta, sort };
  // sortBasis only describes an intent-derived basis; a manual override has none.
  if (sort === 'cheapest' || sort === 'top_rated') lastMeta.sortBasis = sort === 'cheapest' ? 'average price' : 'rating';
  lastResults = [...lastResults].sort(cmp);
  el.cards.innerHTML = lastResults.map(cardHTML).join('');
  paintResultsSub();
  paintSortBar();
}

function cardHTML(r, i) {
  const statusText = r.status.open && r.status.closesAt
    ? `Open • Closes ${to12h(r.status.closesAt)}`
    : r.status.reason;

  const cuisine = r.cuisines.find((c) => !GENERIC.has(c)) || r.cuisines[0];
  const cuisineLabel = CUISINE_LABEL[cuisine] || titleCase(cuisine || 'Canteen');
  // Real menu when the record has one; the mock generator stays as a fallback.
  const dish = r.menu?.length ? r.menu[0] : menuFor(r)[0];
  const image = r.image || photoFor(r);
  const c1 = TAG_COLOR[cuisine] || 't-blue';
  const tags = [
    { text: cuisineLabel, cls: c1 },
    ...(r.tags.slice(0, 1).map((t) => ({
      text: FACET_LABEL[t] || titleCase(t),
      cls: FACET_COLOR[t] || (c1 === 't-amber' ? 't-blue' : 't-amber'),
    }))),
  ];

  return `
    <article class="mcard">
      <div class="mcard-photo">
        <img src="${esc(image)}" alt="" loading="lazy"
             onerror="this.onerror=null;this.src='https://picsum.photos/seed/${esc(r.id)}/900/520'">
        <span class="mstatus ${r.status.open ? 'open' : 'closed'}">${esc(statusText)}</span>
        <span class="mloc">📍 ${esc(r.venue)}</span>
      </div>
      <div class="mcard-body">
        <h3>${esc(r.name)}</h3>
        <p class="msub">${esc(r.zone)} • ${esc(cuisineLabel)}</p>
        <div class="mtags">
          ${tags.map((t) => `<span class="mtag ${t.cls}">${esc(t.text)}</span>`).join('')}
        </div>
        <div class="mfoot">
          <span class="mdish">⭐ ${esc(dish.name)} ($${dish.price})</span>
          <button class="mdetails" type="button" data-idx="${i}"
                  aria-label="Show details for ${esc(r.name)}">Details <span aria-hidden="true">→</span></button>
        </div>
      </div>
    </article>`;
}

/* ------------------------------ details modal ------------------------------ */

let modalTrigger = null;

function openDetails(r, trigger = null) {
  modalTrigger = trigger;
  const menu = r.menu?.length ? r.menu : menuFor(r);
  const sources = r.sources ?? [];
  const hours = r.status.opensAt && r.status.closesAt
    ? `${to12h(r.status.opensAt)} – ${to12h(r.status.closesAt)}`
    : 'Hours unavailable today';

  const reasons = r.reasons.length
    ? `<div class="modal-reasons">${r.reasons
        .map((x) => `<span class="mini-tag neutral">${esc(x.icon)} ${esc(x.text)}</span>`)
        .join('')}</div>`
    : '';

  // Real provenance when the record carries it; an honest placeholder only when
  // it does not, rather than a hand-waved note on every card.
  const sourceHTML = sources.length
    ? `<h4 class="modal-h">Sources</h4>
       <ul class="modal-sources">
         ${sources
           .map(
             (s) =>
               `<li>${
                 s.url
                   ? `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.label)}</a>`
                   : esc(s.label)
               }${s.checkedAt ? ` <span class="checked">checked ${esc(s.checkedAt)}</span>` : ''}</li>`
           )
           .join('')}
       </ul>
       <p class="modal-note">Prototype dataset — hours and prices are approximations, so
       confirm with the outlet before relying on them.</p>`
    : `<div class="source-box">
         ⚠️ <span><strong>Source Verification:</strong> Placeholder data for this prototype —
         not yet verified against an official HKU catering directory.</span>
       </div>`;

  el.modalBody.innerHTML = `
    <h2 id="modalTitle">${esc(r.name)}</h2>
    ${r.nameZh ? `<p class="modal-zh">${esc(r.nameZh)}</p>` : ''}
    <div class="modal-meta">
      <div>📍 ${esc(r.venue)}, ${esc(r.zone)}</div>
      <div>⏰ ${esc(hours)}</div>
    </div>
    ${reasons}
    <h4 class="modal-h">Overview</h4>
    <p class="modal-p">${esc(r.overview || r.note || '')}</p>
    <h4 class="modal-h">Sample menu items</h4>
    <div class="modal-menu">
      ${menu
        .map(
          (m) =>
            `<div class="menu-row"><span>${esc(m.name)}</span><strong>HK$${m.price}</strong></div>`
        )
        .join('')}
    </div>
    ${sourceHTML}`;

  el.modalOverlay.hidden = false;
  document.body.classList.add('modal-open');
  el.modalClose.focus();
}

function closeDetails() {
  el.modalOverlay.hidden = true;
  el.modalBody.innerHTML = '';
  document.body.classList.remove('modal-open');
  if (modalTrigger && document.contains(modalTrigger)) modalTrigger.focus();
  modalTrigger = null;
}

function factRow(key, valueHTML, isEmpty = false) {
  return `<div class="fact"><span class="fact-key">${esc(key)}</span><span class="fact-val ${isEmpty ? 'empty' : ''}">${valueHTML}</span></div>`;
}

function renderPanel(data) {
  const it = data.intent;
  const facts = [];

  facts.push(
    it.cuisines.length
      ? factRow('Cuisine', `<span class="tagrow">${it.cuisines.map((c) => `<span class="mini-tag">${esc(CUISINE_LABEL[c] || c)}</span>`).join('')}</span>`)
      : factRow('Cuisine', 'any', true)
  );

  facts.push(
    it.diets.length
      ? factRow('Diet', `<span class="tagrow">${it.diets.map((d) => `<span class="mini-tag">${esc(titleCase(d))}</span>`).join('')}</span>`)
      : factRow('Diet', 'no restriction', true)
  );

  const budget = it.max_price_hkd != null
    ? `≤ HK$${it.max_price_hkd}`
    : it.price_preference !== 'any'
      ? titleCase(it.price_preference)
      : 'any';
  facts.push(factRow('Budget', esc(budget), budget === 'any'));

  facts.push(
    it.near
      ? factRow('Near', `<span class="tagrow"><span class="mini-tag neutral">${esc(LANDMARK_LABEL[it.near] || it.near)}</span></span>`)
      : factRow('Near', 'anywhere on campus', true)
  );

  facts.push(factRow('When', esc(it.arrive_by ? `by ${it.arrive_by}` : it.open_now ? 'open now' : 'later today'), false));
  facts.push(factRow('Meal', esc(it.meal ? titleCase(it.meal) : 'unspecified'), !it.meal));

  if (it.max_walk_minutes) facts.push(factRow('Max walk', `${it.max_walk_minutes} min`, false));
  if (it.keywords.length) {
    facts.push(
      factRow('Cues', `<span class="tagrow">${it.keywords.map((k) => `<span class="mini-tag neutral">${esc(k)}</span>`).join('')}</span>`)
    );
  }

  el.panelFacts.innerHTML = facts.join('');

  el.modeBadge.textContent = 'LLM';
  el.modeBadge.dataset.mode = 'llm';

  const raw = data.llm?.raw || JSON.stringify(data.intent, null, 2);
  try {
    el.rawJson.textContent = JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    el.rawJson.textContent = raw;
  }
  el.rawDetails.open = false;

  // Label the disclosure honestly: only call it model output when it is.
  const summary = el.rawDetails.querySelector('summary');
  if (summary) {
    summary.textContent = data.llm?.raw ? 'Raw model output' : 'Validated intent';
  }

  const src = 'Produced by the language model, then validated against a fixed vocabulary.';

  const conf = typeof data.intent.confidence === 'number' ? `${Math.round(data.intent.confidence * 100)}%` : '—';
  el.panelNote.innerHTML = `${esc(src)}<br />Confidence ${esc(conf)} · model ${esc(data.llm?.model || 'n/a')} · ${esc(data.llm?.latencyMs ?? 0)} ms. The model never sees the canteen list.`;
}

function renderBanner(data) {
  const msgs = [];

  // The empty-state card already explains a no-preferences result.
  if (data.notice && data.reason !== 'no_preferences') msgs.push(data.notice);
  if (data.meta?.relaxed?.length) {
    const labels = { walk: 'walking distance', price: 'budget', open: 'opening hours', diet: 'dietary needs' };
    msgs.push(`No canteen matched every constraint, so I relaxed: ${data.meta.relaxed.map((r) => labels[r] || r).join(', ')}.`);
  }
  if (data.meta?.lowConfidence) {
    msgs.push(`Nothing matched closely — the best option only scores ${data.meta.bestMatch}%. Showing the closest alternatives.`);
  }

  if (!msgs.length) {
    el.banner.hidden = true;
    return;
  }

  el.banner.hidden = false;
  el.banner.dataset.kind = 'info';
  el.bannerText.textContent = msgs.join(' ');
}

function render(data) {
  const results = data.results || [];

  el.emptyState.hidden = true;
  el.errorBox.hidden = true;
  el.results.hidden = false;
  el.layout.classList.remove('no-panel');
  el.toggleIntent.hidden = false;

  const n = results.length;
  const noPrefs = data.reason === 'no_preferences';

  el.resultsTitle.textContent = n
    ? `${n} place${n > 1 ? 's' : ''} for you`
    : noPrefs
      ? 'Nothing to search for'
      : 'Nothing matched';

  lastMeta = data.meta || {};
  lastResults = results;
  paintResultsSub();
  paintSortBar();

  if (!n) {
    el.cards.innerHTML = `<article class="mcard blank">
      <div class="mcard-body">
        <div class="blank-emoji" aria-hidden="true">${noPrefs ? '💭' : '🤔'}</div>
        <h3>${noPrefs ? "I didn't catch any preferences" : 'No canteen fits that'}</h3>
        <p class="msub" style="margin-top:8px">
          ${
            noPrefs
              ? 'Try naming a cuisine, a budget, a meal, or somewhere on campus.'
              : 'Try loosening the budget, the walking distance, or the time of day.'
          }
        </p>
      </div></article>`;
  } else {
    el.cards.innerHTML = results.map(cardHTML).join('');
  }

  renderPanel(data);
  renderBanner(data);
  setStatus('live', 'Model live');
}

/**
 * No fallback any more: when the model cannot be reached the app says so and
 * shows nothing else. Deliberately does not substitute other results.
 */
function renderOffline(payload) {
  el.emptyState.hidden = true;
  el.errorBox.hidden = true;
  el.banner.hidden = true;
  el.results.hidden = false;
  el.layout.classList.add('no-panel');

  el.resultsTitle.textContent = 'Offline';
  el.resultsSub.textContent = 'No results — search needs the language model.';
  el.toggleIntent.hidden = true; // there is no intent panel to toggle
  el.sortBar.hidden = true; // nothing to sort
  lastMeta = null;

  const err = payload.detail || {};
  const rows = [
    ['Error', err.code ? `${err.code} — ${err.message}` : 'unreachable'],
    ['Model', payload.llm?.model || 'unknown'],
    ['Waited', `${payload.llm?.latencyMs ?? 0} ms`],
  ]
    .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`)
    .join('');

  el.cards.innerHTML = `
    <div class="offline-card">
      <div class="offline-icon" aria-hidden="true">⚠</div>
      <div class="offline-body">
        <h3>The model is offline</h3>
        <p>Your request wasn't processed. Nothing is being guessed in its place — the app
           returns no recommendations while the model is unreachable.</p>
        <dl class="offline-detail">${rows}</dl>
        <button class="ghost-btn" id="offlineRetry">Try again</button>
      </div>
    </div>`;

  const retry = document.getElementById('offlineRetry');
  if (retry) retry.addEventListener('click', () => runSearch(lastQuery));

  setStatus('offline', 'Offline');
}

/* ------------------------------ actions ------------------------------ */

async function runSearch(query) {
  if (busy) return;
  const q = String(query || '').trim();
  if (!q) {
    el.input.focus();
    return;
  }

  busy = true;
  lastQuery = q;
  el.input.value = q;
  el.form.classList.add('is-loading');
  el.submit.disabled = true;
  el.submit.querySelector('.btn-label').textContent = 'Thinking';
  skeleton();
  setStatus('idle', 'Searching…');

  const t0 = performance.now();

  try {
    const res = await fetch('/api/recommend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(timeOverride ? { query: q, at: timeOverride } : { query: q }),
    });

    const data = await res.json().catch(() => null);

    // Keep the loading state on screen long enough to read, not just to flash.
    const elapsed = performance.now() - t0;
    if (elapsed < 520) await new Promise((r) => setTimeout(r, 520 - elapsed));

    if (res.status === 503 && data?.error?.code === 'model_offline') {
      renderOffline(data);
      return;
    }

    if (!res.ok || !data?.ok) {
      throw new Error(data?.error?.message || data?.error || `Request failed (${res.status})`);
    }

    render(data);
  } catch (err) {
    el.results.hidden = true;
    el.errorBox.hidden = false;
    el.errorText.textContent = err.message || 'Unexpected error.';
    setStatus('error', 'Something broke');
  } finally {
    busy = false;
    el.form.classList.remove('is-loading');
    el.submit.disabled = false;
    el.submit.querySelector('.btn-label').textContent = 'Find food';
  }
}

el.form.addEventListener('submit', (e) => {
  e.preventDefault();
  runSearch(el.input.value);
});

el.examples.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  runSearch(chip.dataset.q);
});

el.retry.addEventListener('click', () => runSearch(lastQuery));

el.sortBar.addEventListener('click', (e) => {
  const btn = e.target.closest('.sortbtn');
  if (btn) resortLocal(btn.dataset.sort);
});

el.toggleIntent.addEventListener('click', () => {
  const collapsed = el.layout.classList.toggle('no-panel');
  el.toggleIntent.setAttribute('aria-expanded', String(!collapsed));
});

/* details modal wiring */

el.cards.addEventListener('click', (e) => {
  const btn = e.target.closest('.mdetails');
  if (!btn) return;
  const r = lastResults[Number(btn.dataset.idx)];
  if (r) openDetails(r, btn);
});

el.modalClose.addEventListener('click', closeDetails);

el.modalOverlay.addEventListener('click', (e) => {
  if (e.target === el.modalOverlay) closeDetails();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !el.modalOverlay.hidden) closeDetails();
});

/* ------------------------------ bootstrap ------------------------------ */

function tickClock() {
  const now = new Date();
  const hk = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Hong_Kong',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(now);
  el.footClock.textContent = `${hk} HKT`;
}

tickClock();
setInterval(tickClock, 30_000);

(async function boot() {
  try {
    const [health, list, vocab] = await Promise.all([
      fetch('/api/health').then((r) => r.json()),
      fetch('/api/canteens').then((r) => r.json()),
      fetch('/api/vocab').then((r) => r.json()),
    ]);
    applyVocab(vocab);
    renderEmptyState(list.canteens);
    if (!health.hasKey) setStatus('offline', 'No API key');
  } catch {
    /* the empty state is decorative; ignore */
  }

  // Deep links: /?q=cheap+noodles&at=12:30 runs the query on load;
  // &details=0 opens that result's popup; &sort=cheapest overrides the order.
  const params = new URLSearchParams(location.search);
  const q = params.get('q');
  if (q) {
    await runSearch(q);
    const sort = params.get('sort');
    if (sort && SORT_LABELS[sort]) resortLocal(sort);
    const d = Number(params.get('details'));
    if (params.get('details') !== null && Number.isInteger(d) && lastResults[d]) openDetails(lastResults[d]);
  }
})();
