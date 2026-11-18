import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

test('HTTP contract: refusal, cache, strict empty results and offline errors', { timeout: 20000 }, async (t) => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server/index.js', import.meta.url))], {
    env: { ...process.env, DB_PATH: ':memory:', PORT: '0', BAILIAN_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
  });
  let errors = '';
  child.stderr.on('data', (chunk) => { errors += chunk; });
  const base = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Server startup timeout: ${errors}`)), 8000);
    child.once('error', (err) => { clearTimeout(timer); reject(err); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${errors}`)); });
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
  });
  const send = (body) => fetch(`${base}/api/recommend`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  const coverage = await (await fetch(`${base}/api/coverage`)).json();
  assert.match(coverage.summary, /\b23 venues\b/);
  assert.match(coverage.summary, /\b69 menu items\b/);
  assert.match(coverage.summary, /not individually verified/);
  const refusal = await (await send({ query: 'Order this for me' })).json();
  assert.equal(refusal.reason, 'ordering_refused');
  assert.deepEqual(refusal.results, []);
  const verified = await (await send({ query: 'I want noodles near Centennial Campus.' })).json();
  assert.equal(verified.mode, 'cached');
  assert.ok(verified.results.length > 0);
  assert.match(verified.notice, /representative/);
  const demo = await (await send({ query: 'I want noodles near Centennial Campus.', demo: true })).json();
  assert.ok(demo.results.length > 0);
  assert.equal(demo.meta.demo, true);
  assert.match(demo.notice, /not current opening status/);
  const offline = await send({ query: 'An uncached arbitrary meal' });
  assert.equal(offline.status, 503);
  const override = await send({ query: 'I want noodles near Centennial Campus.', at: '12:30' });
  assert.equal(override.status, 503);
  assert.equal((await send({ query: '' })).status, 400);
  assert.equal((await send({ query: 'a'.repeat(301) })).status, 400);
  assert.equal((await send({ query: 'lunch', demo: 'true' })).status, 400);
  assert.equal((await send({ query: 'lunch', at: '25:00' })).status, 400);
  assert.equal((await send({ query: 'lunch', limit: 0 })).status, 400);
  assert.equal((await send({ query: 'lunch', limit: 25 })).status, 400);
  assert.equal((await send({ query: 'lunch', limit: 3.5 })).status, 400);
  // Saved snapshots are deliberately left at three results: asking for a larger
  // page must not pretend the cached answer has more.
  const widened = await (await send({ query: 'I want noodles near Centennial Campus.', limit: 12 })).json();
  assert.equal(widened.results.length, verified.results.length);
});
