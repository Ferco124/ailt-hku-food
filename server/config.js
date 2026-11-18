import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..');

/** Minimal .env loader — no dependency needed for six variables. */
function loadDotEnv() {
  try {
    const raw = readFileSync(join(ROOT, '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

loadDotEnv();
// 4173 by default: macOS reserves 5000 and 7000 for AirPlay Receiver, so binding
// either one fails with EADDRINUSE on any Mac that has that feature enabled.
const port = process.env.PORT === undefined ? 4173 : Number(process.env.PORT);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer from 0 to 65535');

// Public-hosting knobs (docs/SELF_HOST.md). Every one of them is inert for a
// local run, so a checkout behaves exactly as before unless an operator opts in.
const flag = (value) => /^(1|true|yes|on)$/i.test(String(value ?? '').trim());
const budgetRaw = process.env.DAILY_REQUEST_BUDGET;
const dailyBudget = budgetRaw === undefined || budgetRaw.trim() === '' ? 0 : Number(budgetRaw);
if (!Number.isInteger(dailyBudget) || dailyBudget < 0) {
  throw new Error('DAILY_REQUEST_BUDGET must be a whole number of searches per Hong Kong day, or 0 for no cap');
}

export const config = {
  port,
  // 127.0.0.1 keeps the server off the network entirely. A tunnel reaches it
  // from the same machine, so a public deployment still binds loopback.
  host: (process.env.HOST || '127.0.0.1').trim(),
  apiKey: process.env.BAILIAN_API_KEY || '',
  baseUrl: (process.env.BAILIAN_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/$/, ''),
  model: process.env.BAILIAN_MODEL || 'deepseek-chat',
  timeoutMs: Number(process.env.LLM_TIMEOUT_MS) || 12000,
  hasKey: Boolean(process.env.BAILIAN_API_KEY),
  // Set only when every request arrives through a proxy that writes the real
  // client address (cloudflared). On a directly reachable server the header
  // would be chosen by the client, which defeats the per-visitor limit.
  trustProxy: flag(process.env.TRUST_PROXY),
  // 0 disables the cap. A public deployment needs a fuse on model spend.
  dailyBudget,
  // Once trustProxy is on, /api/stats requires this token and is otherwise
  // indistinguishable from a missing route.
  statsToken: (process.env.STATS_TOKEN || '').trim(),
};
