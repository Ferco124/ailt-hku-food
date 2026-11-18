import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { hkDateKey } from '../server/time.js';

const ENTRY = fileURLToPath(new URL('../server/index.js', import.meta.url));

/**
 * Start a throwaway server with a known environment. Every hosting switch is
 * cleared first so a developer's own .env cannot decide what these tests see.
 */
async function startServer(t, env = {}) {
  const child = spawn(process.execPath, [ENTRY], {
    env: {
      ...process.env,
      DB_PATH: ':memory:',
      PORT: '0',
      BAILIAN_API_KEY: '',
      HOST: '127.0.0.1',
      TRUST_PROXY: '0',
      DAILY_REQUEST_BUDGET: '0',
      STATS_TOKEN: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await once(child, 'exit');
    }
  });
  let errors = '';
  child.stderr.on('data', (chunk) => { errors += chunk; });
  let output = '';
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server startup timeout: ${errors}`)), 8000);
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${errors}`)); });
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
  });
  return { base, startupLog: () => output };
}

const post = (base, body, headers = {}) => fetch(`${base}/api/recommend`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

test('a local run keeps /api/stats and full health diagnostics', { timeout: 20000 }, async (t) => {
  const { base } = await startServer(t);
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.ok, true);
  assert.equal(health.hasKey, false);
  assert.ok(health.model);
  assert.ok(health.db?.path);
  assert.equal((await fetch(`${base}/api/stats`)).status, 200);
});

test('a public host hides stats unless the token matches', { timeout: 20000 }, async (t) => {
  const { base } = await startServer(t, { TRUST_PROXY: '1', STATS_TOKEN: 'test-token' });
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.ok, true);
  assert.equal(health.hasKey, false);
  // The provider endpoint and database path describe the machine, not the site.
  assert.equal(health.model, undefined);
  assert.equal(health.baseUrl, undefined);
  assert.equal(health.db, undefined);
  assert.ok(health.serverTimeHK);

  assert.equal((await fetch(`${base}/api/stats`)).status, 404);
  assert.equal((await fetch(`${base}/api/stats`, {
    headers: { Authorization: 'Bearer wrong-token' },
  })).status, 404);
  const allowed = await fetch(`${base}/api/stats`, {
    headers: { Authorization: 'Bearer test-token' },
  });
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).ok, true);
});

test('a public host without a token keeps stats closed', { timeout: 20000 }, async (t) => {
  const { base } = await startServer(t, { TRUST_PROXY: '1' });
  assert.equal((await fetch(`${base}/api/stats`)).status, 404);
});

test('per-visitor limits follow the forwarded address, not the socket', { timeout: 30000 }, async (t) => {
  const { base } = await startServer(t, { TRUST_PROXY: '1' });
  const send = (ip) => post(base, { query: '' }, { 'cf-connecting-ip': ip }).then((r) => r.status);

  // An empty query is rejected after the limiter has counted it, so this
  // exercises the limiter without ever reaching the model.
  const first = [];
  for (let i = 0; i < 30; i += 1) first.push(await send('203.0.113.9'));
  assert.deepEqual([...new Set(first)], [400]);
  assert.equal(await send('203.0.113.9'), 429);

  // A different visitor still has their own allowance: behind a tunnel the
  // socket is always 127.0.0.1, so a shared bucket would lock everyone out.
  assert.equal(await send('203.0.113.10'), 400);
});

test('the forwarded chain is read from the hop the proxy observed', { timeout: 30000 }, async (t) => {
  const { base } = await startServer(t, { TRUST_PROXY: '1' });
  // A client may prepend its own entry; the appended one is what the proxy saw.
  const send = (chain) => post(base, { query: '' }, { 'x-forwarded-for': chain }).then((r) => r.status);
  for (let i = 0; i < 30; i += 1) assert.equal(await send('1.1.1.1, 203.0.113.7'), 400);
  assert.equal(await send('1.1.1.1, 203.0.113.7'), 429);
  // The same visitor arriving with a different forged prefix is still limited.
  assert.equal(await post(base, { query: '' }, { 'cf-connecting-ip': '203.0.113.7' }).then((r) => r.status), 429);
  // A different appended hop is a different visitor.
  assert.equal(await send('1.1.1.1, 203.0.113.8'), 400);
});

test('forwarded headers are ignored when no proxy is trusted', { timeout: 30000 }, async (t) => {
  const { base } = await startServer(t);
  const statuses = [];
  for (let i = 0; i < 31; i += 1) {
    statuses.push(await post(base, { query: '' }, { 'cf-connecting-ip': `198.51.100.${i}` })
      .then((r) => r.status));
  }
  // Rotating the header must not buy fresh buckets when it is not trusted.
  assert.equal(statuses.filter((s) => s === 429).length, 1);
  assert.equal(statuses.at(-1), 429);
});

test('the daily budget caps spending across every visitor', { timeout: 20000 }, async (t) => {
  const { base } = await startServer(t, { TRUST_PROXY: '1', DAILY_REQUEST_BUDGET: '2' });
  const send = (ip) => post(base, { query: '' }, { 'cf-connecting-ip': ip });

  assert.equal((await send('203.0.113.1')).status, 400);
  assert.equal((await send('203.0.113.2')).status, 400);
  const capped = await send('203.0.113.3');
  assert.equal(capped.status, 429);
  const body = await capped.json();
  assert.equal(body.code, 'daily_budget');
  assert.match(body.error, /daily search limit/i);
});

test('the budget day is the Hong Kong date, not the server date', () => {
  // 15:30 UTC is 23:30 in Hong Kong; 16:30 UTC is already the next day there.
  assert.equal(hkDateKey(new Date('2026-11-18T15:30:00Z')), '2026-11-18');
  assert.equal(hkDateKey(new Date('2026-11-18T16:30:00Z')), '2026-11-19');
});