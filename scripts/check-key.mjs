#!/usr/bin/env node
/**
 * Diagnoses why a Bailian API key is or isn't working.
 *
 *   npm run check-key
 *
 * Checks the key's shape first (most failures are format or region problems),
 * then makes one real call and explains the failure in plain terms.
 */

import { config } from '../server/config.js';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';

const ok = (s) => `${GREEN}✓${RESET} ${s}`;
const bad = (s) => `${RED}✗${RESET} ${s}`;
const warn = (s) => `${YELLOW}!${RESET} ${s}`;

const mask = (k) => (k.length <= 16 ? k : `${k.slice(0, 10)}…${k.slice(-8)}`);

const advice = [];
const addAdvice = (s) => advice.push(s);

console.log(`\n${BOLD}HKU Canteen Finder — API key check${RESET}\n`);
console.log(`  ${DIM}endpoint${RESET}  ${config.baseUrl}`);
console.log(`  ${DIM}model   ${RESET}  ${config.model}`);

if (!config.hasKey) {
  console.log(`  ${DIM}key     ${RESET}  ${bad('not set')}\n`);
  addAdvice('Add BAILIAN_API_KEY to .env — see README, "Getting a working key".');
  report();
  process.exit(1);
}

console.log(`  ${DIM}key     ${RESET}  ${mask(config.apiKey)}  ${DIM}(${config.apiKey.length} chars)${RESET}\n`);

// ---------------------------------------------------------------- format ---
console.log(`${BOLD}Format${RESET}`);

if (/\s/.test(config.apiKey)) {
  console.log(`  ${bad('contains whitespace')} — copy the key again, without spaces or newlines.`);
  addAdvice('Remove whitespace from BAILIAN_API_KEY.');
}

const segments = config.apiKey.split('.');
const looksStandard = /^sk-[A-Za-z0-9]{20,}$/.test(config.apiKey);

if (looksStandard) {
  console.log(`  ${ok('standard Model Studio key (single sk-… token)')}`);
} else if (segments.length > 1) {
  console.log(`  ${warn(`unusual shape (${segments.length} dot-separated segments)`)}`);
  console.log(`    ${DIM}Standard Model Studio keys are one sk-… token with no dots.${RESET}`);

  const last = segments.at(-1).replace(/-/g, '+').replace(/_/g, '/');
  const buf = Buffer.from(last, 'base64');
  if (buf.length > 8 && buf[0] === 0x30 && buf[2] === 0x02) {
    console.log(`    ${DIM}The last segment decodes to a ${buf.length}-byte DER ECDSA signature,${RESET}`);
    console.log(`    ${DIM}i.e. a signed token. These are issued for MaaS "token plan"${RESET}`);
    console.log(`    ${DIM}gateways, not for dashscope.aliyuncs.com.${RESET}`);
    addAdvice(
      'Signed tokens belong to a token-plan gateway. Use its own base URL, e.g. https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1 — not dashscope.aliyuncs.com.'
    );
  }
} else {
  console.log(`  ${warn('unrecognised key shape')} — continuing anyway.`);
}

// ----------------------------------------------------------- reachability ---
console.log(`\n${BOLD}Reachability${RESET}`);

const t0 = Date.now();
let res;
let body = '';
try {
  res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
      max_tokens: 8,
      temperature: 0,
    }),
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  body = await res.text();
  console.log(`  ${ok(`reached ${new URL(config.baseUrl).host} (HTTP ${res.status} in ${Date.now() - t0} ms)`)}`);
} catch (err) {
  const code = err.cause?.code || err.name;
  console.log(`  ${bad(`cannot reach endpoint (${code})`)}`);
  addAdvice(`Check your network / proxy. ${config.baseUrl} was unreachable.`);
  report();
  process.exit(1);
}

// -------------------------------------------------------- authentication ---
console.log(`\n${BOLD}Authentication${RESET}`);

let payload = null;
try {
  payload = JSON.parse(body);
} catch {
  /* non-JSON error page */
}

const errCode = payload?.error?.code || payload?.code || '';
const errMsg = payload?.error?.message || payload?.message || body.slice(0, 200);

if (res.ok) {
  console.log(`  ${ok('accepted — the model replied')}`);
  const reply = payload?.choices?.[0]?.message?.content?.trim();
  if (reply) console.log(`    ${DIM}response: "${reply.slice(0, 60)}"${RESET}`);
  console.log(`\n${GREEN}${BOLD}Everything works.${RESET} Run \`npm start\` and the app will use the model path.\n`);
  process.exit(0);
}

console.log(`  ${bad(`rejected (HTTP ${res.status})`)}`);
console.log(`    ${DIM}${errCode || 'no code'} — ${errMsg}${RESET}`);

switch (true) {
  case res.status === 401 && /expired/i.test(errMsg):
    console.log(`\n  ${warn('The token is well-formed but expired.')}`);
    addAdvice('Re-issue the token. If it was supplied to you, ask the issuer — signed tokens cannot be refreshed locally.');
    break;

  case res.status === 401:
    console.log(`\n  ${warn('The endpoint does not recognise this key.')}`);
    addAdvice(
      'Check that the base URL matches the key\'s gateway. A token-plan key needs https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1, a console key needs https://dashscope.aliyuncs.com/compatible-mode/v1.'
    );
    addAdvice(
      'If it is a console key: create one at https://bailian.console.aliyun.com → 模型服务 → API-KEY and copy it into .env.'
    );
    addAdvice('Check the region too — a Beijing key only works on Beijing endpoints, a Singapore key only on dashscope-intl.aliyuncs.com.');
    break;

  case res.status === 403:
    addAdvice('Key is valid but not authorised for this model or workspace. Check the business space and model permissions in the console.');
    break;

  case res.status === 429:
    addAdvice('Rate limited or out of quota. Check the account balance and the free-tier limits.');
    break;

  case res.status === 404 || /model.*not.*(found|support)/i.test(errMsg):
    addAdvice(`Model "${config.model}" is not available on this endpoint. Try qwen-plus, or check the model list for the region.`);
    break;

  default:
    addAdvice('Unexpected response — see the message above.');
}

report();
process.exitCode = 1;

function wrap(text, width = 92, indent = '     ') {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if (line && (line + ' ' + w).length > width) {
      lines.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(line);
  return lines.join(`\n${indent}`);
}

function report() {
  if (!advice.length) return;
  console.log(`\n${BOLD}What to do${RESET}`);
  advice.forEach((a, i) => {
    console.log(`  ${i + 1}. ${wrap(a)}`);
  });
  console.log(
    `\n  ${DIM}Until this is fixed the app will report the model as offline and return no results.${RESET}\n`
  );
}
