import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { config, ROOT } from './config.js';
import { recommend, coverage } from './recommend.js';
import { nowInHK } from './geo.js';
import { hkDateKey } from './time.js';
import { getCanteens, getStats, logSearch, DB_PATH, SCHEMA_VERSION } from './db.js';
import { VOCAB } from './data/vocab.js';

const PUBLIC_DIR = join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

// --- who a request is charged to ---------------------------------------------
/**
 * The address a limit should be charged to. Behind a tunnel every socket says
 * 127.0.0.1, so charging the socket would turn a per-visitor limit into one
 * global limit shared by the whole internet. The forwarded header is only
 * honoured when the operator declared a proxy; on a directly reachable server
 * any client could otherwise pick its own bucket by sending the header.
 */
function clientIp(req) {
  if (config.trustProxy) {
    const cf = req.headers['cf-connecting-ip'];
    if (typeof cf === 'string' && cf.trim()) return cf.trim();
    // Last hop, not first: a proxy appends the address it actually saw, so the
    // leftmost entry is the one a client can write for itself.
    const forwarded = String(req.headers['x-forwarded-for'] ?? '')
      .split(',').map((part) => part.trim()).filter(Boolean).pop();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress || 'unknown';
}

// --- tiny per-IP rate limiter ------------------------------------------------
const RATE_LIMIT = 30; // searches per minute per visitor
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
  // Bounded memory: a rotating set of source addresses cannot grow this table
  // without limit. Dropping every bucket is harmless; the next request starts
  // a fresh window.
  if (hits.size > 5000) hits.clear();
  return entry.count > RATE_LIMIT;
}

// --- daily spend fuse --------------------------------------------------------
// Per-IP limits do not bound total spend: a few addresses, or one address with
// a pool of proxies, can still bill every single request. This caps the whole
// process per Hong Kong calendar day and resets at local midnight. It is a
// fuse on the operator's bill, not billing: a restart clears the counter.
let budgetDay = '';
let budgetUsed = 0;
function budgetExhausted() {
  if (!config.dailyBudget) return false;
  const today = hkDateKey();
  if (today !== budgetDay) {
    budgetDay = today;
    budgetUsed = 0;
  }
  if (budgetUsed >= config.dailyBudget) return true;
  budgetUsed += 1;
  return false;
}

/** A public deployment hides the diagnostics that describe the machine. */
const detailedResponses = () => !config.trustProxy;

/** `/api/stats` reports the query log, so a public host must present a token. */
function statsAllowed(req) {
  if (!config.statsToken) return detailedResponses();
  const given = Buffer.from(String(req.headers.authorization ?? ''));
  const expected = Buffer.from(`Bearer ${config.statsToken}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
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
 *   prompt → LLM (strict JSON) → validate → filter/rank → page of 3
 *
 * Exact walkthrough snapshots may be served offline with an explicit label.
 * No arbitrary fallback search or generated menu data is permitted.
 */
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const ip = clientIp(req);

  if (req.method === 'GET' && url.pathname === '/api/health') {
    const body = {
      ok: true,
      hasKey: config.hasKey,
      canteens: getCanteens().length,
      serverTimeHK: nowInHK(),
    };
    // Provider endpoint, database path and schema version describe the machine
    // they run on, so a public deployment keeps them off the wire.
    if (detailedResponses()) {
      body.model = config.model;
      body.baseUrl = config.baseUrl;
      body.db = { driver: 'node:sqlite', path: DB_PATH, schemaVersion: SCHEMA_VERSION };
    }
    return json(res, 200, body);
  }

  if (req.method === 'GET' && url.pathname === '/api/stats') {
    // 404 rather than 401: a stranger learns nothing about what exists here.
    if (!statsAllowed(req)) return json(res, 404, { ok: false, error: 'Not found' });
    try {
      return json(res, 200, { ok: true, ...getStats() });
    } catch (err) {
      return json(res, 500, { ok: false, error: String(err.message || err) });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/vocab') {
    return json(res, 200, { ok: true, ...VOCAB });
  }
  if (req.method === 'GET' && url.pathname === '/api/coverage') {
    return json(res, 200, { ok: true, ...coverage });
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
    if (budgetExhausted()) {
      return json(res, 429, {
        ok: false,
        code: 'daily_budget',
        error: 'This site has reached its daily search limit. Please try again tomorrow (Hong Kong time).',
      });
    }

    let query = '';
    let atMinutes = null;
    let demo = false;
    let limit = null;
    try {
      const raw = await readBody(req);
      const parsed = JSON.parse(raw || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
          (parsed.query !== undefined && typeof parsed.query !== 'string') ||
          (parsed.demo !== undefined && typeof parsed.demo !== 'boolean') ||
          (parsed.limit !== undefined && (!Number.isInteger(parsed.limit) || parsed.limit < 1 || parsed.limit > 24)) ||
          (parsed.at !== undefined && (typeof parsed.at !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(parsed.at)))) {
        return json(res, 400, { ok: false, error: 'Expected query as text, demo as a boolean, optional limit as an integer from 1 to 24, and optional at as HH:MM.' });
      }
      query = String(parsed.query ?? '').trim();
      demo = parsed.demo === true;
      limit = parsed.limit ?? null;
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
      const now = nowInHK();
      if (atMinutes != null) {
        now.minutes = atMinutes;
        now.hhmm = `${String(Math.floor(atMinutes / 60)).padStart(2, '0')}:${String(atMinutes % 60).padStart(2, '0')}`;
      }
      const result = await recommend(query, {
        now, demo, allowCache: atMinutes == null, ...(limit ? { limit } : {}),
      });

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
        mode: result.reason || result.mode,
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

server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') throw err;
  const airplay = process.platform === 'darwin' && (config.port === 5000 || config.port === 7000)
    ? `\n  macOS reserves ports 5000 and 7000 for AirPlay Receiver. Turn it off in`
      + `\n  System Settings > General > AirDrop & Handoff, or set another PORT in .env.`
    : '';
  const message =
    `\n  Port ${config.port} may already be in use: another program is listening on it.`
    + airplay
    + `\n  Stop that program, or choose another port in .env, for example: PORT=4173\n`;
  process.stderr.write(message, () => process.exit(1));
});

server.listen(config.port, config.host, () => {
  const { hhmm, dayName } = nowInHK();
  const count = getCanteens().length;
  const { port } = server.address();
  console.log(`\n  HKU Canteen Finder`);
  console.log(`  ─────────────────────────────────────────`);
  console.log(`  http://127.0.0.1:${port}`);
  console.log(`  model      ${config.model} @ ${config.baseUrl}`);
  console.log(`  api key    ${config.hasKey ? 'configured' : 'MISSING — safety responses and exact cached walkthroughs only'}`);
  console.log(`  database   ${DB_PATH} (${count} canteens)`);
  console.log(`  hong kong  ${dayName} ${hhmm}`);
  if (config.host !== '127.0.0.1') {
    console.log(`  bind       ${config.host}:${port} (reachable beyond loopback)`);
  }
  if (config.trustProxy) {
    console.log(`  proxy      client address from CF-Connecting-IP / X-Forwarded-For`);
    console.log(`  stats      ${config.statsToken ? 'token required' : 'disabled (set STATS_TOKEN to enable)'}`);
  }
  if (config.dailyBudget) console.log(`  budget     ${config.dailyBudget} searches per Hong Kong day`);
  console.log('');
  if (process.send) process.send({ type: 'ready', port });
});
if (process.send) {
  process.on('disconnect', () => {
    server.closeAllConnections();
    server.close();
  });
}
