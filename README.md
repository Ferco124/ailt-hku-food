# HKU Canteen Finder

A vertical slice of a natural-language canteen finder for the University of Hong Kong.  
You type what you want, a lightweight LLM turns it into strict JSON, the server  
validates that JSON, filters a small demo database, and the top three places are  
rendered as cards.

This is a **demo prototype**, not a product. The canteen data is illustrative.

---

## Quick start

```bash
npm start          # http://localhost:4173
```

No dependencies, no build step. Node 18+ (developed on 22).

The database is created automatically on first run, so `npm start` is enough. To
manage it explicitly:

```bash
npm run migrate    # create/verify the database
npm run db:reset   # drop and re-import from data/canteens.json
```

The only requirement is a working API key in `.env`:

```
BAILIAN_API_KEY=sk-...
BAILIAN_BASE_URL=https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
BAILIAN_MODEL=qwen3.8-flash
```

---

## Getting a working key

If the model path fails, run the diagnostic before changing anything:

```bash
npm run check-key
```

It inspects the key's shape, makes one real call, and explains the failure in
plain terms (expired token, wrong region, unknown model, missing quota).

**Standard Model Studio keys are a single `sk-…` token with no dots.** Create one
at <https://bailian.console.aliyun.com> → 模型服务 → API-KEY.

### Which endpoint does the key belong to?

A key only authenticates against the gateway that issued it. Mixing them up is the
most common cause of a 401:

| Key type | Base URL |
| --- | --- |
| Console key, 华北2 (Beijing) | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| Console key, Singapore | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` |
| MaaS **token plan** key | `https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` |

Token-plan keys look different from console keys: `sk-sp-…` followed by three more
dot-separated segments, the last being a DER ECDSA signature. If `npm run check-key`
reports an unusual shape, the key is almost certainly a token-plan key and needs the
`token-plan` host. Token-plan gateways also serve their own model catalogue — run
`curl -H "Authorization: Bearer $KEY" …/v1/models` to see what is available, since
`qwen-turbo` may not exist there.

### Using a different provider

The client only speaks the OpenAI chat-completions shape, so any compatible
provider works by editing `.env` alone:

| Provider | `BAILIAN_BASE_URL` | `BAILIAN_MODEL` |
| --- | --- | --- |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| Moonshot | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| Ollama (local) | `http://localhost:11434/v1` | `qwen2.5:7b` |

No code changes — the parser only cares about the JSON the model returns.

---

## The pipeline

```
prompt
  │
  ├─► Bailian chat/completions (temperature 0, JSON mode)
  │      │
  │      ├─ unreachable / rejected / timed out ──► 503 model_offline
  │      ▼                                        (no results, by design)
  │   extractJSON()  →  validateIntent()
  │      │                    │
  │      │                    └─ unknown cuisine, invented venue,
  │      │                       bad enum → dropped or rejected
  │      ▼
  └─► Intent
         │
         ▼
  search(): filter → score → relevance floor → sort
         ▼
    top 3 results
```

There is **no fallback search**. If the model cannot be reached, the request fails
with `503 model_offline` and the UI shows an offline state instead of results. A
status demo should never mask an outage by quietly answering from a different code
path.

### Why the model cannot invent canteens

The model **never sees the canteen database**. It only receives a fixed  
vocabulary (cuisines, diets, landmark keys, sort options) and returns an intent  
object. Even if it hallucinated `"near": "Fuji Restaurant"`, `normaliseLandmark()`  
would drop it before it reached the search stage. Prices and opening hours are  
never taken from the model at all — they come only from the `canteens` and  
`canteen_hours` tables.

`server/schema.js` is the enforcement point: every field is type-checked, every  
enum value is whitelisted, and numeric ranges are clamped.

The vocabularies used to live as constants in `server/data/vocab.js`. They now
live in `data/vocab.json`, and that file is also where facet synonyms live
(`"late night" → open-late`, `"fast" → quick`), so keyword matching is data-driven
in the same way the parser contract is.

---

## Data layer

Canteens and landmarks live in **SQLite**, accessed through Node's built-in
`node:sqlite` module — no dependency, no server process, no connection pool. The
database file is `data/canteens.db` (gitignored).

The records themselves live in two files under `data/`, which are the source of
truth:

```
data/canteens.json   landmarks + canteens, with menus, sources and opening hours
data/vocab.json      cuisines, diets and the facet vocabulary (+ synonyms)
```

`server/db.js` projects those files into SQLite and keeps the projection honest:
it stores a content hash and a schema version in `meta`, and on startup rebuilds
automatically when either changes. Editing the JSON and restarting is enough — no
manual step.

```
meta               key, value          (schema_version, data_hash, imported_at)
landmarks          key, label, lat, lng
canteens           id, name, name_zh, venue, zone, lat, lng,
                   price_level, avg_price, rating, emoji, image, overview
canteen_cuisines   canteen_id → cuisine     (many-to-many)
canteen_diets      canteen_id → diet        (many-to-many)
canteen_tags       canteen_id → tag         (many-to-many)
canteen_menu       canteen_id, position, name, price
canteen_sources    canteen_id, position, label, url, checked_at
canteen_hours      canteen_id, day_of_week, opens_min, closes_min
search_log         every query, mode, intent, result ids, latency
```

A few deliberate choices:

- **Normalised, not a JSON blob per row.** Cuisines, diets and hours are things a
  real app filters on; stuffing them into a text column would make the database
  decorative.
- **A missing `canteen_hours` row means "closed that day"**, rather than a nullable
  sentinel. Weekday-only venues need no special casing.
- **Times are stored as minutes since midnight**, so opening-hours logic does
  integer comparisons with range checks (`CHECK (opens_min BETWEEN 0 AND 1439)`)
  instead of parsing strings.
- **Some tags are derived, not authored.** `weekday-only` and `open-late` are
  computed from a canteen's own hours at import, so the tag can never drift out of
  step with the opening times it describes.
- **`search_log` is written on every search**, which makes the database a live part
  of the app rather than a read-only dump.

`server/db.js` is the only module that touches SQL. Everything else asks it for
plain objects, so swapping in Postgres means rewriting that one file.

### Verifying a migration

`npm run migrate` does not just insert rows — it checks that the copy is intact:

```
Checks
  ✓ canteen rows match JSON  (15 / 15)
  ✓ landmark rows match JSON  (10 / 10)
  ✓ menu items match JSON  (45 rows)
  ✓ sources match JSON  (15 rows)
  ✓ schema version recorded  (expect 2)
  ✓ every canteen has ≥1 cuisine
  ✓ every canteen has ≥1 opening slot
  ✓ every canteen has ≥1 menu item
  ✓ every canteen has ≥1 source
  ✓ every canteen has an image
  ✓ cuisine values are in the vocabulary
  ✓ tag values are known facets
  ✓ derived tags present where expected
  ✓ foreign keys intact
  ✓ sqlite integrity_check  (ok)
  ✓ hours round-trip correctly  (Mon 660–1230 min (expect 660–1230))
```

It exits non-zero if any check fails, so it can gate a deploy. `npm run db:reset`
additionally drops and re-imports everything first.

### Inspecting the data

`GET /api/stats` reports row counts, how searches split by outcome (`llm`,
`no_preferences`, `offline`, `error`), average latency, and the five most recent
queries.

```bash
curl -s localhost:4173/api/stats
```

---

## Request / response

`POST /api/recommend`

```json
{ "query": "cheap vegetarian lunch near the Main Library before 2pm" }
```

```json
{
  "ok": true,
  "reason": null,
  "intent": {
    "cuisines": ["vegetarian"],
    "diets": ["vegetarian"],
    "max_price_hkd": null,
    "price_preference": "cheap",
    "open_now": false,
    "arrive_by": "14:00",
    "near": "main_library",
    "max_walk_minutes": null,
    "meal": "lunch",
    "keywords": ["cheap"],
    "sort": "best_match",
    "confidence": 0.92
  },
  "results": [ { "name": "...", "matchPct": 85, "reasons": [ ... ] } ],
  "meta": {
    "totalMatches": 11, "relaxed": [], "checkTime": "14:00",
    "sort": "best_match", "sortBasis": null
  },
  "llm": { "ok": true, "latencyMs": 640, "model": "qwen3.8-flash" }
}
```

`reason` is `null` on a normal search, or `no_preferences` when the model answered
but found nothing actionable in the prompt — in that case `results` is empty and
`notice` explains what to try instead.

Each result also carries `image`, `overview`, `menu` (`[{ name, price }]`) and
`sources` (`[{ label, url, checkedAt }]`), so the detail view renders real menu and
provenance data rather than placeholders.

### Sorting

The relevance floor decides *which* canteens qualify; `sort` decides their order:

| `sort` | ordered by | tie-break |
| --- | --- | --- |
| `best_match` (default) | match score | walk, rating |
| `cheapest` | average price | match score |
| `closest` | walking distance | match score |
| `top_rated` | rating | match score |

The model only sets `sort` when the user asks for an order ("cheapest", "closest",
"best rated"). The UI also exposes a four-way control that re-orders the results
already on screen, so changing the order does not cost another model call.

### Other endpoints

```bash
curl -s localhost:4173/api/vocab      # cuisines, diets, facets — drives the UI labels
curl -s localhost:4173/api/health     # key present? which model? current HK time
curl -s localhost:4173/api/canteens   # id, name, emoji, image, venue, zone
```

### When the model is unavailable

A missing key, a rejected key, a timeout, a network error, malformed JSON, or a
failed schema check all produce the same response — no results:

```json
HTTP 503
{
  "ok": false,
  "error": { "code": "model_offline", "message": "The language model is not reachable right now." },
  "detail": { "code": "auth", "message": "API key rejected (401)" },
  "llm": { "model": "qwen3.8-flash", "latencyMs": 412 }
}
```

The UI shows an offline panel with the underlying error and a retry button. It
does not substitute other results, and an internal server error returns `500`
rather than inventing an answer.

---

## Ranking

Hard filters: dietary fit, price cap, walking budget, opening status.

Score components (weights in `server/search.js`): cuisine overlap 46, diet 28,  
budget 22, proximity 30, meal window 12, keyword hits 21, rating 10, availability 4.  
The percentage on each card is the score normalised against the maximum the  
current intent could achieve, so it is comparable within a search but not across  
different searches.

A relevance floor then trims the tail: only results scoring at least 60% of the
best match are shown, so `korean bbq` returns one honest food court rather than a
coffee shop at 29%. If even the best result scores below 25%, the UI says so
instead of pretending.

The floor decides which canteens qualify; the requested `sort` decides their
order (see [Sorting](#sorting)). Every sort keeps the match score as a tie-break,
so asking for "cheapest" cannot promote an irrelevant result over a relevant one
that happens to cost the same.

If nothing survives the hard filters, constraints are relaxed one at a time —  
walking distance, then budget, then opening hours, then diet — and the relaxation  
is reported in `meta.relaxed` and shown in the UI. Diet is relaxed last on  
purpose: showing a meat dish to a vegetarian is worse than showing a closed  
vegetarian restaurant.

---

## Demo helpers

| Flag             | Effect                                                   |
| ---------------- | -------------------------------------------------------- |
| `?q=...`         | Runs a query on page load (shareable link).              |
| `?at=12:30`      | Evaluates opening hours at a fixed time instead of now.  |
| `?sort=cheapest` | Overrides the result order (`cheapest`, `closest`, `top_rated`). |

```bash
open "http://localhost:4173/?q=noodles+near+Centennial&at=12:30"
```

---

## Layout

```
server/
  index.js        HTTP server, routes, pipeline orchestration
  db.js           SQLite access — the only module that touches SQL
  schema.sql      DDL: tables, constraints, indexes
  llm.js          Bailian client, prompt, JSON extraction
  schema.js       Intent contract + validation (the anti-hallucination guard)
  search.js       Filtering, scoring, sorting, constraint relaxation
  geo.js          Haversine distance, opening-hours logic
  time.js         HK local time, minute conversions
  data/
    loadData.js   Reads + validates the JSON records; derives hours-based tags
    vocab.js      Re-exports the vocabularies from data/vocab.json
scripts/
  migrate.mjs     Project the JSON into SQLite + verify integrity
  check-key.mjs   Diagnose API key / endpoint problems
data/
  canteens.json   Landmarks + canteens: menus, sources, hours (source of truth)
  vocab.json      Cuisines, diets, facets + synonyms (source of truth)
  canteens.db     SQLite database (generated, gitignored)
public/
  index.html  styles.css  app.js
```

---

## Known limitations

- Demo data: 15 canteens, approximate prices and hours, no live menus.
- Opening hours are weekday/weekend pairs; no public-holiday calendar.
- Distance is straight-line × 1.35, not a real pedestrian route.
- No caching: every submit is one model call.
- Single-process, in-memory rate limiting only.
- SQLite allows one writer at a time. Fine for a single process, but running
  several app instances against the same file would need WAL plus a busy timeout,
  or a client-server database.
- No offline mode: if the model is unreachable, search stops working entirely. That
  is a deliberate choice, not an oversight — but it does mean a model outage is a
  full outage for the app.
- Chinese prompts work because the model handles them; nothing else in the stack is
  localised (the UI copy is English-only).
