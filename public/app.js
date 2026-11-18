/* HKU Canteen Finder — frontend */

const $ = (id) => document.getElementById(id);

const el = {
  form: $('searchForm'),
  input: $('query'),
  submit: $('submitBtn'),
  examples: $('examples'),
  results: $('results'),
  cards: $('cards'),
  hints: $('hints'),
  hintsTitle: $('hintsTitle'),
  hintsNote: $('hintsNote'),
  hintsList: $('hintsList'),
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
  themeToggle: $('themeToggle'),
  sortBar: $('sortBar'),
  more: $('moreRow'),
  moreBtn: $('moreBtn'),
  moreNote: $('moreNote'),
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

// Broad labels used only when nothing more specific matches.
const GENERIC = new Set(['chinese', 'asian']);

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

/* ------------------------------- theme ------------------------------- */

const THEME_KEY = 'hku-theme';
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

// The initial value is resolved by the inline script in index.html, so this only
// reflects it into the control and follows later system changes until the user
// states a preference of their own.
function applyTheme(theme, persist = false) {
  document.documentElement.dataset.theme = theme;
  el.themeToggle.setAttribute('aria-checked', String(theme === 'dark'));
  const next = theme === 'dark' ? 'light' : 'dark';
  el.themeToggle.title = `Switch to ${next} theme`;
  if (!persist) return;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* private mode: the choice simply does not survive the tab */
  }
}

const currentTheme = () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');

applyTheme(currentTheme());
el.themeToggle.addEventListener('click', () => {
  applyTheme(currentTheme() === 'dark' ? 'light' : 'dark', true);
});

systemDark.addEventListener('change', (event) => {
  let chosen = null;
  try {
    chosen = localStorage.getItem(THEME_KEY);
  } catch {
    /* storage unavailable */
  }
  if (!chosen) applyTheme(event.matches ? 'dark' : 'light');
});

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

/**
 * Hints are outlets whose *menu wording* suggests vegetarian dishes. They are
 * never results: no percentage, no card, no dietary basis. Keeping them in a
 * separate dashed box is the whole point — a hint must not be read as "this
 * outlet was checked".
 */
function renderHints(hints) {
  const list = hints?.results ?? [];
  if (!list.length) {
    el.hints.hidden = true;
    el.hintsList.innerHTML = '';
    return;
  }
  el.hintsTitle.textContent = hints.title;
  el.hintsNote.textContent = hints.note;
  el.hintsList.innerHTML = list
    .map(
      (h) => `<li class="hint">
        <div class="hint-top">
          <span class="hint-name">${esc(h.name)}</span>
          <span class="hint-meta">${esc(h.venue)}${h.walkMinutes != null ? ` · ${esc(h.walkMinutes)} min walk` : ''}</span>
        </div>
        <p class="hint-why">Menu wording suggests: ${h.items.map((i) => `“${esc(i.name)}”`).join(', ')}</p>
      </li>`
    )
    .join('');
  el.hints.hidden = false;
}

function skeleton() {
  el.results.hidden = false;
  el.emptyState.hidden = true;
  el.errorBox.hidden = true;
  el.banner.hidden = true;
  renderHints(null);
  el.resultsTitle.textContent = 'Searching…';
  el.resultsSub.textContent = 'Reading your request, then filtering the canteen list.';
  el.more.hidden = true;
  el.cards.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
}

let lastResults = [];
let lastMeta = null;

// The server returns every outlet that cleared the relevance floor; the page
// only ever *shows* three until asked, so a different sort can surface outlets
// outside that first page without another model call.
const RESULTS_PAGE = 3;
const RESULT_LIMIT = 24;
let visibleCount = RESULTS_PAGE;

const shownCount = () => Math.min(visibleCount, lastResults.length);
// Saved walkthrough snapshots stay at three results, so they cannot expand.
const canExpand = () => !lastMeta?.snapshotAt;

/** "Checked 15 canteens · … · Showing 3 of 5 matches · Sorted by cheapest (…)" */
function paintResultsSub() {
  const meta = lastMeta || {};
  const total = lastResults.length;
  const shown = shownCount();
  const bits = [];
  if (meta.evaluated > 0) bits.push(`Checked ${meta.evaluated} canteens`);
  bits.push(meta.snapshotAt
    ? `Historical snapshot: ${meta.snapshotAt}`
    : `Schedule evaluated at ${meta.dayName ?? ''} ${meta.checkTime ?? ''} HKT`);
  if (timeOverride) bits.push('fixed test time');
  if (total > shown) bits.push(`Showing ${shown} of ${total} matches`);
  else if (meta.totalMatches > total) bits.push(`${meta.totalMatches} matched in total`);
  if (shown) {
    const label = SORT_LABELS[meta.sort] || SORT_LABELS.best_match;
    bits.push(meta.sortBasis ? `Sorted by ${label} (${meta.sortBasis})` : `Sorted by ${label}`);
  }
  el.resultsSub.textContent = bits.join(' · ');
}

function paintTitle() {
  const n = shownCount();
  if (!n) return;
  el.resultsTitle.textContent = `${n} place${n > 1 ? 's' : ''} for you`;
}

function paintMore() {
  const total = lastResults.length;
  if (!canExpand() || total <= RESULTS_PAGE) {
    el.more.hidden = true;
    return;
  }
  el.more.hidden = false;
  const expanded = visibleCount >= total;
  el.moreBtn.setAttribute('aria-expanded', String(expanded));
  if (expanded) {
    el.moreBtn.textContent = 'Show fewer';
    el.moreNote.textContent = `All ${total} matches shown.`;
    return;
  }
  const step = Math.min(RESULTS_PAGE, total - visibleCount);
  const left = total - visibleCount;
  el.moreBtn.textContent = `Show ${step} more place${step > 1 ? 's' : ''}`;
  el.moreNote.textContent = `${left} more match${left > 1 ? 'es' : ''} passed the same checks, further down this list.`;
}

/** Repaint the visible window; `lastResults` itself is never truncated. */
function paintCards() {
  el.cards.innerHTML = lastResults.slice(0, shownCount()).map(cardHTML).join('');
  paintMore();
  paintTitle();
  paintResultsSub();
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
 * Re-order the whole result set, not just the page on screen. The ordering a
 * user asks for after the fact should not cost another model call, so this
 * re-sorts the same results with the same rules the server uses. `rank` is the
 * server's best-match position, which keeps switching back exact.
 */
function resortLocal(sort) {
  if (!lastResults.length) return;
  const byRank = (a, b) => (a.rank ?? 999) - (b.rank ?? 999);
  const cmp = {
    cheapest: (a, b) => (a.avgPrice ?? Infinity) - (b.avgPrice ?? Infinity) || b.matchPct - a.matchPct || a.walkMinutes - b.walkMinutes,
    closest: (a, b) => a.walkMinutes - b.walkMinutes || b.matchPct - a.matchPct,
    top_rated: (a, b) => (b.rating ?? 0) - (a.rating ?? 0) || b.matchPct - a.matchPct,
    best_match: byRank,
  }[sort];
  if (!cmp) return;

  const knownBasis = { cheapest: 'lowest matching dish price', top_rated: 'rating' }[sort];
  const walkBasis = typeof lastMeta?.sortBasis === 'string' && lastMeta.sortBasis.startsWith('walk from')
    ? lastMeta.sortBasis
    : null;
  // sortBasis only describes an intent-derived basis; a manual override has none.
  lastMeta = {
    ...lastMeta,
    sort,
    sortBasis: sort === 'best_match' ? null : (knownBasis ?? (sort === 'closest' ? walkBasis : null)),
  };
  lastResults = [...lastResults].sort(cmp);
  paintCards();
  paintSortBar();
}

function cardHTML(r, i) {
  const statusText = (lastMeta?.snapshotAt ? 'Snapshot: ' : 'Schedule: ') + (r.status.open && r.status.closesAt
    ? `Open • Closes ${to12h(r.status.closesAt)}`
    : r.status.reason);

  const cuisine = r.cuisines.find((c) => !GENERIC.has(c)) || r.cuisines[0];
  const cuisineLabel = CUISINE_LABEL[cuisine] || titleCase(cuisine || 'Canteen');
  // The server returns only eligible items; never fabricate a fallback dish.
  const dish = r.menu[0] ?? null;
  // An outlet-level dietary match answers "where", not "which dish": quoting one
  // dish as the match would imply that dish itself was reviewed.
  const outletDiet = r.dietBasis === 'venue';
  // Records point at a local photo of the outlet; the cuisine shot stays as the
  // fallback if a file is missing, so a broken image never reaches the card.
  const fallbackImage = photoFor(r);
  const image = r.image || fallbackImage;
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
             onerror="this.onerror=null;this.src='${esc(fallbackImage)}'">
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
          ${outletDiet || !dish
            ? '<span class="mdish">🏷️ Outlet-level dietary listing</span>'
            : `<span class="mdish">⭐ ${esc(dish.name)} (${dish.price == null ? 'price unknown' : `HK$${dish.price}`})</span>`}
          <button class="mdetails" type="button" data-idx="${i}"
                  aria-label="Show details for ${esc(r.name)}">Details <span aria-hidden="true">→</span></button>
        </div>
        ${dish ? `<p class="msub">Stall: ${esc(dish.stall)}</p>` : ''}
      </div>
    </article>`;
}

/* ------------------------------ details modal ------------------------------ */

let modalTrigger = null;

/**
 * Every verification claim and caveat lives here, at the bottom of the detail
 * view — one section a curious user can read, instead of four grey paragraphs
 * repeated on every card. Each row states what was checked, on what basis, and
 * what that basis does *not* cover.
 */
function verificationHTML(r) {
  const sources = r.sources ?? [];
  const checked = sources.map((s) => s.checkedAt).filter(Boolean).sort().at(-1);
  const when = [lastMeta?.dayName, lastMeta?.checkTime].filter(Boolean).join(' ');

  const rows = [
    {
      key: 'Venue & hours',
      state: r.venueVerified ? 'ok' : 'none',
      value: r.venueVerified ? 'Verified' : 'Not verified',
      note: r.venueVerified
        ? `Address and opening hours match the official HKU catering directory${checked ? `, last checked ${checked}` : ''}.`
        : 'Prototype data — not checked against any official directory.',
    },
    {
      key: 'Dishes & prices',
      state: r.menuVerified ? 'ok' : 'partial',
      value: r.menuVerified ? 'Item-verified' : 'Representative',
      note: r.menuVerified
        ? 'Dish names and prices were reviewed on the outlet page.'
        : 'Names and prices show what the outlet serves; no dish was reviewed line by line.',
    },
    r.dietBasis === 'dish'
      ? {
          key: 'Dietary',
          state: 'ok',
          value: 'Dish evidence',
          note: 'The listed dishes carry their own dietary evidence; see the item sources above.',
        }
      : r.dietBasis === 'venue'
        ? {
            key: 'Dietary',
            state: 'partial',
            value: 'Outlet-level only',
            note: 'The outlet is listed or certified for this diet; the dishes shown were not individually reviewed. Ask staff which dishes qualify.',
          }
        : {
            key: 'Dietary',
            state: 'neutral',
            value: 'Not assessed',
            note: 'This search did not ask about dietary needs, so nothing was checked for them.',
          },
    lastMeta?.snapshotAt
      ? {
          key: 'Availability',
          state: 'partial',
          value: 'Historic snapshot',
          note: 'A saved walkthrough — not current opening status.',
        }
      : {
          key: 'Availability',
          state: r.status.open ? 'ok' : 'partial',
          value: r.status.open ? `Evaluated ${when} HKT`.trim() : 'Closed now',
          note: r.status.open
            ? 'Opening times checked against the published schedule for this day.'
            : `${r.status.reason} — from the published schedule, not a temporary closure notice.`,
        },
  ];

  const sourceList = sources.length
    ? `<ul class="modal-sources">
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
       </ul>`
    : `<div class="source-box">
         ⚠️ <span><strong>No source recorded:</strong> this outlet has not been checked
         against an official HKU catering directory.</span>
       </div>`;

  return `<section class="modal-verify" aria-label="Verification and disclaimer">
    <h4 class="modal-h">Verification</h4>
    <div class="verify-rows">
      ${rows
        .map(
          (row) => `<div class="verify-row">
            <span class="verify-key">${esc(row.key)}</span>
            <div class="verify-val">
              <span class="verify-state ${row.state}"><span class="verify-dot" aria-hidden="true"></span>${esc(row.value)}</span>
              <p class="verify-note">${esc(row.note)}</p>
            </div>
          </div>`
        )
        .join('')}
    </div>
    <h4 class="modal-h">Sources</h4>
    ${sourceList}
    <p class="modal-disclaimer">Informational only — not a safety guarantee. Confirm
    ingredients, allergens and dietary status with staff before ordering.</p>
  </section>`;
}

function openDetails(r, trigger = null) {
  modalTrigger = trigger;
  // An outlet-level dietary match has no reviewed dish to show; the outlet's
  // representative offerings are listed for context only.
  const menu = r.dietBasis === 'venue' ? (r.representativeMenu ?? []) : r.menu;
  const hours = r.status.opensAt && r.status.closesAt
    ? `${to12h(r.status.opensAt)} – ${to12h(r.status.closesAt)}`
    : 'Hours unavailable today';

  const reasons = r.reasons.length
    ? `<div class="modal-reasons">${r.reasons
        .map((x) => `<span class="mini-tag neutral">${esc(x.icon)} ${esc(x.text)}</span>`)
        .join('')}</div>`
    : '';

  // Some venue strings already end with the campus ("..., Centennial Campus");
  // appending the zone again printed the campus name twice.
  const location = r.venue.toLowerCase().includes(r.zone.toLowerCase())
    ? r.venue
    : `${r.venue}, ${r.zone}`;

  el.modalBody.innerHTML = `
    <h2 id="modalTitle">${esc(r.name)}</h2>
    ${r.nameZh ? `<p class="modal-zh">${esc(r.nameZh)}</p>` : ''}
    <div class="modal-meta">
      <div>📍 ${esc(location)}</div>
      <div>⏰ ${esc(hours)}</div>
    </div>
    ${reasons}
    <h4 class="modal-h">Overview</h4>
    <p class="modal-p">${esc(r.overview || r.note || '')}</p>
    <h4 class="modal-h">${r.dietBasis === 'venue' ? 'Representative dishes (not reviewed for this diet)' : 'Matching menu items'}</h4>
    <div class="modal-menu">
      ${menu
        .map(
          (m) =>
            `<div class="menu-row"><span>${esc(m.name)} - ${esc(m.stall)}${m.ingredients_listed?.length ? `<br />Ingredients: ${esc(m.ingredients_listed.join(', '))}` : ''}
            ${(m.sources ?? []).map((s) => `<br /><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.label)}</a> (checked ${esc(s.checkedAt)})`).join('')}
            ${(m.dietary_tags_source || []).map((s) => `<br /><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.tag)}: ${esc(s.statement)}</a> (checked ${esc(s.checkedAt)})`).join('')}
            </span><strong>${m.price == null ? 'Price unknown' : `HK$${m.price}`}</strong></div>`
        )
        .join('')}
    </div>
    ${verificationHTML(r)}`;

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
  if (!it) {
    el.panelFacts.textContent = data.notice || '';
    el.rawJson.textContent = 'No model call required for this safety response.';
    el.modeBadge.textContent = 'LOCAL SAFETY';
    el.rawDetails.querySelector('summary').textContent = 'Local policy response';
    el.rawDetails.open = false;
    el.panelNote.textContent = data.disclaimer;
    return;
  }
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

  facts.push(factRow('When', esc(it.arrive_by ? `evaluated at ${it.arrive_by}` : it.open_now ? 'open now' : 'not specified'), false));
  facts.push(factRow('Meal', esc(it.meal ? titleCase(it.meal) : 'unspecified'), !it.meal));
  if (it.zone) facts.push(factRow('Campus', esc(it.zone)));
  if (it.requested_stall) facts.push(factRow('Stall', esc(it.requested_stall)));
  if (it.unsupported?.length) facts.push(factRow('Unsupported', esc(it.unsupported.join('; '))));

  if (it.max_walk_minutes) facts.push(factRow('Max walk', `${it.max_walk_minutes} min`, false));
  if (it.keywords.length) {
    facts.push(
      factRow('Cues', `<span class="tagrow">${it.keywords.map((k) => `<span class="mini-tag neutral">${esc(k)}</span>`).join('')}</span>`)
    );
  }

  el.panelFacts.innerHTML = facts.join('');

  el.modeBadge.textContent = data.mode === 'cached' ? 'CACHED' : 'LLM';
  el.modeBadge.dataset.mode = 'llm';

  const raw = data.mode === 'cached' ? JSON.stringify(data.intent, null, 2) : data.llm?.raw || JSON.stringify(data.intent, null, 2);
  try {
    el.rawJson.textContent = JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    el.rawJson.textContent = raw;
  }
  el.rawDetails.open = false;

  // Label the disclosure honestly: only call it model output when it is.
  const summary = el.rawDetails.querySelector('summary');
  if (summary) {
    summary.textContent = data.mode === 'cached' ? 'Saved walkthrough intent' : data.llm?.raw ? 'Raw model output' : 'Validated intent';
  }

  const src = data.mode === 'cached'
    ? 'Saved walkthrough snapshot, not a live model response or current availability.'
    : 'Parsed by the model, validated and checked against local safety rules.';

  const conf = typeof data.intent.confidence === 'number' ? `${Math.round(data.intent.confidence * 100)}%` : '—';
  el.panelNote.innerHTML = data.mode === 'cached' ? esc(src)
    : `${esc(src)}<br />Confidence ${esc(conf)} · model ${esc(data.llm?.model || 'n/a')} · ${esc(data.llm?.latencyMs ?? 0)} ms. The model never sees the canteen list.`;
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
    msgs.push(`Nothing matched closely — the best option only scores ${data.meta.bestMatch}%. No weak alternatives are presented as matches.`);
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
  el.toggleIntent.setAttribute('aria-expanded', 'true');

  const n = results.length;
  const noPrefs = data.reason === 'no_preferences';

  lastMeta = data.meta || {};
  lastResults = results;
  visibleCount = RESULTS_PAGE;

  if (!n) {
    el.resultsTitle.textContent = data.reason?.endsWith('_refused') ? 'Information-only service' : noPrefs
      ? 'Nothing to search for'
      : 'Nothing matched';
    el.more.hidden = true;
    el.cards.innerHTML = `<article class="mcard blank">
      <div class="mcard-body">
        <div class="blank-emoji" aria-hidden="true">${noPrefs ? '💭' : '🤔'}</div>
        <h3>${noPrefs ? "I didn't catch any preferences" : data.reason?.endsWith('_refused') ? 'Information-only service' : 'No match found in the current dataset'}</h3>
        <p class="msub" style="margin-top:8px">
          ${
            noPrefs
              ? 'Try naming a cuisine, a budget, a meal, or somewhere on campus.'
              : esc(data.notice || 'No match found in the current dataset. This does not mean suitable food is unavailable on campus.')
          }
        </p>
      </div></article>`;
    paintResultsSub();
  } else {
    paintCards();
  }

  paintSortBar();
  renderHints(data.hints);
  renderPanel(data);
  renderBanner(data);
  setStatus(data.mode === 'cached' ? 'offline' : 'live',
    data.mode === 'cached' ? 'Cached walkthrough' : data.mode === 'local' ? 'Local safety response' : 'Model live');
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
  renderHints(null);
  el.toggleIntent.hidden = true; // there is no intent panel to toggle
  el.sortBar.hidden = true; // nothing to sort
  el.more.hidden = true; // nothing to reveal
  lastMeta = null;
  lastResults = [];
  visibleCount = RESULTS_PAGE;

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
  closeDetails();
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
      body: JSON.stringify({
        query: q,
        // Ask for the whole qualifying set: sorting and "show more" then need
        // no further round trip, and the server still owns the ranking.
        limit: RESULT_LIMIT,
        ...(timeOverride ? { at: timeOverride } : {}),
      }),
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

el.moreBtn.addEventListener('click', () => {
  const total = lastResults.length;
  if (!total) return;
  visibleCount = visibleCount >= total
    ? RESULTS_PAGE
    : Math.min(total, visibleCount + RESULTS_PAGE);
  paintCards();
  el.moreBtn.focus();
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
  if (e.key === 'Tab' && !el.modalOverlay.hidden) {
    const items = [...el.modalOverlay.querySelectorAll('button, a[href]')];
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
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
    const [health, list, vocab, coverage] = await Promise.all([
      fetch('/api/health').then((r) => r.json()),
      fetch('/api/canteens').then((r) => r.json()),
      fetch('/api/vocab').then((r) => r.json()),
      fetch('/api/coverage').then((r) => r.json()),
    ]);
    applyVocab(vocab);
    // The grid is the whole outlet list, always: there is no unverified tier to
    // switch away from, so browsing the dataset needs no toggle.
    renderEmptyState(list.canteens);
    $('coverageText').innerHTML = `<p>${esc(coverage.summary)}</p><p>Not covered: ${esc(coverage.notCovered)}</p>
      <p><a href="${esc(coverage.officialDirectory)}" target="_blank" rel="noopener noreferrer">Official HKU eatery directory</a></p>
      ${coverage.reviewedOutlets.map((o) => `<p><a href="${esc(o.url)}" target="_blank" rel="noopener noreferrer">${esc(o.name)}</a> - reviewed ${esc(o.checkedAt)}<br />${esc(o.finding)}</p>`).join('')}`;
    if (!health.hasKey) setStatus('offline', 'No API key');
  } catch (err) {
    $('coverageText').textContent = `Could not load coverage: ${err.message}`;
    setStatus('error', 'Startup failed - reload to retry');
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
    if (params.get('details') !== null && Number.isInteger(d) && lastResults[d]) {
      // Reveal the card before opening it: the link may point past the first page.
      if (d >= visibleCount) {
        visibleCount = Math.min(lastResults.length, d + 1);
        paintCards();
      }
      openDetails(lastResults[d]);
    }
  }
})();
