import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { config, ROOT } from './config.js';
import { parseIntent } from './llm.js';
import { hasConstraints } from './schema.js';
import { search } from './search.js';
import { nowInHK } from './geo.js';
import { getCanteens, getStats, logSearch, DB_PATH, SCHEMA_VERSION } from './db.js';
import { VOCAB } from './data/vocab.js';

const PUBLIC_DIR = join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

// --- tiny per-IP rate limiter ------------------------------------------------
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const window = 60_000;
  const entry = hits.get(ip) ?? { count: 0, reset: now + window };
  if (now > entry.reset) {
    entry.count = 0;
    entry.reset = now + window;
  }
  entry.count += 1;
  hits.set(ip, entry);
  return entry.count > 30;
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

async function readBody(req, limit = 16 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Payload too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const safe = normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(PUBLIC_DIR, safe);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const data = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

/**
 * Core pipeline:
 *   prompt → LLM (strict JSON) → validate → filter/rank → top 3
 *
 * There is deliberately no fallback search. If the model cannot be reached the
 * request fails with `model_offline` rather than quietly returning results from
 * a different code path — a status demo should never mask an outage.
 */
async function recommend(query, atMinutes = null) {
  const now = nowInHK();
  // Testing aid: ?at=HH:MM lets a reviewer check opening-hours logic at any hour.
  if (atMinutes != null) {
    now.minutes = atMinutes;
    now.hhmm = `${String(Math.floor(atMinutes / 60)).padStart(2, '0')}:${String(atMinutes % 60).padStart(2, '0')}`;
  }

  const llm = await parseIntent(query);

  if (!llm.ok) {
    return { offline: true, query, llm };
  }

  const base = {
    ok: true,
    query,
    intent: llm.intent,
    notice: null,
    llm: {
      ok: true,
      model: llm.model,
      latencyMs: llm.latencyMs,
      warnings: llm.warnings ?? [],
      raw: llm.raw ?? null,
    },
  };

  // The model answered, but the answer carried no usable constraints.
  if (!hasConstraints(llm.intent)) {
    return {
      ...base,
      reason: 'no_preferences',
      notice:
        "I couldn't pick any preferences out of that. Try naming a cuisine, a budget, a meal, or where you are.",
      results: [],
      meta: {
        evaluated: 0,
        totalMatches: 0,
        lowConfidence: false,
        bestMatch: 0,
        relaxed: [],
        sort: 'best_match',
        sortBasis: null,
        checkTime: now.hhmm,
        dayName: now.dayName,
      },
    };
  }

  const { results, meta } = search(llm.intent, { now });
  return { ...base, reason: null, results, meta };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const ip = req.socket.remoteAddress || 'unknown';

  if (req.method === 'GET' && url.pathname === '/api/health') {
    return json(res, 200, {
      ok: true,
      hasKey: config.hasKey,
      model: config.model,
      baseUrl: config.baseUrl,
      canteens: getCanteens().length,
      db: { driver: 'node:sqlite', path: DB_PATH, schemaVersion: SCHEMA_VERSION },
      serverTimeHK: nowInHK(),
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/stats') {
    try {
      return json(res, 200, { ok: true, ...getStats() });
    } catch (err) {
      return json(res, 500, { ok: false, error: String(err.message || err) });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/vocab') {
    return json(res, 200, { ok: true, ...VOCAB });
  }

  if (req.method === 'GET' && url.pathname === '/api/canteens') {
    return json(res, 200, {
      ok: true,
      canteens: getCanteens().map((c) => ({
        id: c.id, name: c.name, nameZh: c.nameZh, emoji: c.emoji,
        image: c.image, venue: c.venue, zone: c.zone,
      })),
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/recommend') {
    if (rateLimited(ip)) {
      return json(res, 429, { ok: false, error: 'Too many requests — please wait a moment.' });
    }

    let query = '';
    let atMinutes = null;
    try {
      const raw = await readBody(req);
      const parsed = JSON.parse(raw || '{}');
      query = String(parsed.query ?? '').trim();
      if (typeof parsed.at === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(parsed.at)) {
        const [h, m] = parsed.at.split(':').map(Number);
        atMinutes = h * 60 + m;
      }
    } catch {
      return json(res, 400, { ok: false, error: 'Invalid JSON body' });
    }

    if (!query) return json(res, 400, { ok: false, error: 'Please describe what you are looking for.' });
    if (query.length > 300) return json(res, 400, { ok: false, error: 'Query is too long (max 300 characters).' });

    const t0 = Date.now();
    try {
      const result = await recommend(query, atMinutes);

      if (result.offline) {
        logSearch({ query, mode: 'offline', latencyMs: Date.now() - t0 });
        return json(res, 503, {
          ok: false,
          error: {
            code: 'model_offline',
            message: 'The language model is not reachable right now.',
          },
          detail: result.llm.error ?? null,
          llm: { model: result.llm.model, latencyMs: result.llm.latencyMs },
        });
      }

      logSearch({
        query,
        mode: result.reason === 'no_preferences' ? 'no_preferences' : 'llm',
        intent: result.intent,
        resultIds: result.results.map((r) => r.id),
        latencyMs: Date.now() - t0,
      });
      return json(res, 200, result);
    } catch (err) {
      // No fallback results here either: an internal error is an internal error.
      console.error('[recommend] failed:', err);
      logSearch({ query, mode: 'error', latencyMs: Date.now() - t0 });
      return json(res, 500, {
        ok: false,
        error: { code: 'internal', message: 'Something went wrong on the server.' },
      });
    }
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    return serveStatic(res, url.pathname);
  }

  json(res, 405, { ok: false, error: 'Method not allowed' });
});

server.listen(config.port, () => {
  const { hhmm, dayName } = nowInHK();
  const count = getCanteens().length;
  console.log(`\n  HKU Canteen Finder`);
  console.log(`  ─────────────────────────────────────────`);
  console.log(`  http://localhost:${config.port}`);
  console.log(`  model      ${config.model} @ ${config.baseUrl}`);
  console.log(`  api key    ${config.hasKey ? 'configured' : 'MISSING — searches will fail'}`);
  console.log(`  database   ${DB_PATH} (${count} canteens)`);
  console.log(`  hong kong  ${dayName} ${hhmm}\n`);
});
