-- HKU Canteen Finder — schema
--
-- Normalised rather than one JSON blob per canteen: the vocabularies
-- (cuisines, diets, tags, opening hours) are things you would realistically
-- want to query and filter on, and a search box that only ever does
-- "give me all 15 rows" is not really using a database.
--
-- The database is a projection of data/canteens.json, rebuilt by db.js when
-- that file's content hash or the schema version below changes.

PRAGMA foreign_keys = ON;

-- Records which build of the schema/data produced this file, so db.js can tell
-- "stale" from "current" without inspecting every column.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS landmarks (
  key   TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  lat   REAL NOT NULL,
  lng   REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS canteens (
  id          TEXT PRIMARY KEY,
  name        TEXT    NOT NULL,
  name_zh     TEXT,               -- CJK part of the display name, when present
  venue       TEXT    NOT NULL,
  zone        TEXT    NOT NULL,
  lat         REAL    NOT NULL,
  lng         REAL    NOT NULL,
  price_level INTEGER NOT NULL CHECK (price_level BETWEEN 1 AND 3),
  avg_price   INTEGER NOT NULL CHECK (avg_price > 0),
  rating      REAL    NOT NULL CHECK (rating BETWEEN 0 AND 5),
  emoji       TEXT,
  image       TEXT,
  overview    TEXT
);

CREATE TABLE IF NOT EXISTS canteen_cuisines (
  canteen_id TEXT NOT NULL REFERENCES canteens(id) ON DELETE CASCADE,
  cuisine    TEXT NOT NULL,
  PRIMARY KEY (canteen_id, cuisine)
);

CREATE TABLE IF NOT EXISTS canteen_diets (
  canteen_id TEXT NOT NULL REFERENCES canteens(id) ON DELETE CASCADE,
  diet       TEXT NOT NULL,
  PRIMARY KEY (canteen_id, diet)
);

CREATE TABLE IF NOT EXISTS canteen_tags (
  canteen_id TEXT NOT NULL REFERENCES canteens(id) ON DELETE CASCADE,
  tag        TEXT NOT NULL,
  PRIMARY KEY (canteen_id, tag)
);

-- Sample menu items. position preserves the authored order.
CREATE TABLE IF NOT EXISTS canteen_menu (
  canteen_id TEXT    NOT NULL REFERENCES canteens(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL,
  name       TEXT    NOT NULL,
  price      INTEGER NOT NULL CHECK (price > 0),
  PRIMARY KEY (canteen_id, position)
);

-- Where a record came from, so the UI can show provenance instead of a
-- hand-waved "placeholder data" note.
CREATE TABLE IF NOT EXISTS canteen_sources (
  canteen_id TEXT    NOT NULL REFERENCES canteens(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL,
  label      TEXT    NOT NULL,
  url        TEXT,
  checked_at TEXT,
  PRIMARY KEY (canteen_id, position)
);

-- One row per open day. A missing row means closed that day, which is how the
-- weekday-only venues are represented without a nullable sentinel.
CREATE TABLE IF NOT EXISTS canteen_hours (
  canteen_id  TEXT    NOT NULL REFERENCES canteens(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6), -- 0 = Sunday
  opens_min   INTEGER NOT NULL CHECK (opens_min  BETWEEN 0 AND 1439),
  closes_min  INTEGER NOT NULL CHECK (closes_min BETWEEN 1 AND 1440),
  PRIMARY KEY (canteen_id, day_of_week)
);

-- Written on every search. Makes the database a live part of the app rather
-- than a read-only dump, and gives /api/stats something real to report.
CREATE TABLE IF NOT EXISTS search_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  query       TEXT NOT NULL,
  mode        TEXT NOT NULL,
  intent_json TEXT,
  result_ids  TEXT,
  latency_ms  INTEGER,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_cuisines_cuisine ON canteen_cuisines (cuisine);
CREATE INDEX IF NOT EXISTS idx_diets_diet       ON canteen_diets (diet);
CREATE INDEX IF NOT EXISTS idx_canteens_zone    ON canteens (zone);
CREATE INDEX IF NOT EXISTS idx_log_created      ON search_log (created_at);