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
const port = process.env.PORT === undefined ? 5000 : Number(process.env.PORT);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer from 0 to 65535');

export const config = {
  port,
  apiKey: process.env.BAILIAN_API_KEY || '',
  baseUrl: (process.env.BAILIAN_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/$/, ''),
  model: process.env.BAILIAN_MODEL || 'deepseek-chat',
  timeoutMs: Number(process.env.LLM_TIMEOUT_MS) || 12000,
  hasKey: Boolean(process.env.BAILIAN_API_KEY),
};
