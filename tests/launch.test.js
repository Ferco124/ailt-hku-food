import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

function launch(t, port) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/launch.mjs', import.meta.url))], {
    env: { ...process.env, DB_PATH: ':memory:', PORT: String(port), NO_BROWSER: '1', BAILIAN_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = { text: '', errors: '' };
  child.stdout.on('data', (data) => { output.text += data; });
  child.stderr.on('data', (data) => { output.errors += data; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, 'exit');
    }
  });
  return { child, output };
}

test('launcher confirms its own child and cleans up when the launcher exits', { timeout: 15000 }, async (t) => {
  const { child, output } = launch(t, 0);
  let url;
  for (let attempt = 0; attempt < 80; attempt++) {
    const match = output.text.match(/Ready: (http:\/\/127\.0\.0\.1:\d+)/);
    if (match) { url = match[1]; break; }
    if (child.exitCode !== null) assert.fail(output.errors);
    await delay(100);
  }
  assert.ok(url, `No readiness acknowledgement: ${output.errors}`);
  assert.equal((await fetch(`${url}/api/health`)).status, 200);
  child.kill();
  await once(child, 'exit');
  let stopped = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(200) }); }
    catch { stopped = true; break; }
    await delay(100);
  }
  assert.ok(stopped, 'Server survived launcher exit');
});

test('launcher does not mistake an occupied port for its own healthy server', { timeout: 15000 }, async (t) => {
  let requests = 0;
  const occupant = createServer((req, res) => { requests++; res.end('{"ok":true}'); });
  occupant.listen(0, '127.0.0.1');
  await once(occupant, 'listening');
  t.after(() => new Promise((resolve) => { occupant.closeAllConnections(); occupant.close(resolve); }));
  const { child, output } = launch(t, occupant.address().port);
  const [code] = await once(child, 'exit');
  assert.notEqual(code, 0);
  assert.doesNotMatch(output.text, /Ready:/);
  assert.equal(requests, 0);
  assert.match(output.errors, /already be in use|EADDRINUSE/);
});
