import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

test('real parser transport validates local fake-provider responses before retrieval', { timeout: 15000 }, async (t) => {
  let status = 200;
  let content = '{}';
  let request;
  const provider = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    request = JSON.parse(body);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  t.after(() => new Promise((resolve) => { provider.closeAllConnections(); provider.close(resolve); }));
  process.env.DB_PATH = ':memory:';
  process.env.BAILIAN_API_KEY = 'local-test-only';
  process.env.BAILIAN_BASE_URL = `http://127.0.0.1:${provider.address().port}`;
  const { parseIntent } = await import('../server/llm.js');
  const { recommend } = await import('../server/recommend.js');
  const { closeDb } = await import('../server/db.js');
  t.after(closeDb);

  content = JSON.stringify({ diets: ['halal', 'vegetarian', 'vegan', 'gluten_free'], max_price_hkd: 29.9 });
  const valid = await parseIntent('Four restrictions, budget 29.9');
  assert.equal(valid.ok, true);
  assert.equal(valid.intent.diets.length, 4);
  assert.equal(valid.intent.max_price_hkd, 29.9);
  assert.equal(request.messages[1].content, 'Four restrictions, budget 29.9');
  assert.ok(request.messages[0].content.includes('never truncate'));

  for (const malformed of [{ diets: { halal: true } }, { open_now: 'true' }, { requested_stall: 123 }]) {
    content = JSON.stringify(malformed);
    const result = await parseIntent('Malformed fixture');
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'invalid_schema');
  }
  content = 'This is not JSON';
  assert.equal((await parseIntent('Broken response')).error.code, 'bad_json');
  content = JSON.stringify({ refusal: 'medical_refused' });
  const refused = await recommend('Interpret this clinical case', { allowCache: false });
  assert.equal(refused.reason, 'medical_refused');
  assert.deepEqual(refused.results, []);
  status = 503;
  assert.equal((await parseIntent('Unavailable provider')).error.code, 'upstream');
});
