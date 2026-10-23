import { config } from './config.js';
import { validateIntent } from './schema.js';
import { CUISINES, DIETS } from './data/vocab.js';
import { landmarks } from './db.js';

/**
 * Prompt is deliberately narrow: the model is a *parser*, not a recommender.
 * It may only emit values from the vocabularies below, and it never sees the
 * canteen database — so it cannot recommend or invent a venue.
 */
const SYSTEM_PROMPT = `You are the query parser for "HKU Canteen Finder", an app that helps students at the University of Hong Kong find a place to eat.

Your only job: convert the user's request into a single JSON object describing their preferences.

STRICT RULES
1. Output ONLY a JSON object. No markdown, no code fences, no commentary.
2. Never invent canteen names, venues, dish names, prices, opening hours, ratings or tags. You are not recommending anything.
3. Only extract preferences that the user actually states or that are unambiguous.
4. If a value is not clearly stated, use null (for scalars) or [] (for arrays). Do not guess.
5. Use ONLY the allowed values listed below. If the user asks for something outside these lists, omit it.

ALLOWED VALUES
cuisines: ${CUISINES.join(', ')}
diets: ${DIETS.join(', ')}
near (pick at most one key): ${Object.keys(landmarks).join(', ')}
meal: breakfast, lunch, dinner, snack
price_preference: cheap, mid, any
sort: best_match, cheapest, closest, top_rated

OUTPUT SCHEMA
{
  "cuisines": string[],            // 0-4 entries from the cuisine list
  "diets": string[],               // 0-3 entries from the diet list
  "max_price_hkd": number | null,  // hard budget per person, only if the user gives a number
  "price_preference": "cheap" | "mid" | "any",
  "open_now": boolean,             // true unless the user implies they are eating later
  "arrive_by": "HH:MM" | null,     // 24-hour clock, only if the user gives a deadline such as "before 2pm"
  "near": string | null,           // a landmark key from the list above
  "max_walk_minutes": number | null,
  "meal": "breakfast" | "lunch" | "dinner" | "snack" | null,
  "keywords": string[],            // 0-5 short free-text cues, e.g. "quick", "quiet", "takeaway"
  "sort": "best_match" | "cheapest" | "closest" | "top_rated",  // ranking order the user asks for; default "best_match"
  "confidence": number             // 0.0-1.0, how sure you are the parse is complete
}

Use "sort" only when the user explicitly asks for an order: cheapest / budget-first,
nearest / closest, or highest rated / best. Otherwise use "best_match".

EXAMPLES
User: "I need a cheap vegetarian lunch near the Main Library before 2pm."
{"cuisines":["vegetarian"],"diets":["vegetarian"],"max_price_hkd":null,"price_preference":"cheap","open_now":false,"arrive_by":"14:00","near":"main_library","max_walk_minutes":null,"meal":"lunch","keywords":["cheap"],"sort":"best_match","confidence":0.92}

User: "I want noodles near Centennial Campus."
{"cuisines":["noodles"],"diets":[],"max_price_hkd":null,"price_preference":"any","open_now":true,"arrive_by":null,"near":"centennial_campus","max_walk_minutes":null,"meal":null,"keywords":[],"sort":"best_match","confidence":0.88}

User: "Something quick and open now for coffee and a snack."
{"cuisines":["coffee","snack"],"diets":[],"max_price_hkd":null,"price_preference":"any","open_now":true,"arrive_by":null,"near":null,"max_walk_minutes":null,"meal":"snack","keywords":["quick"],"sort":"best_match","confidence":0.9}

User: "Cheapest lunch near the library."
{"cuisines":[],"diets":[],"max_price_hkd":null,"price_preference":"cheap","open_now":false,"arrive_by":null,"near":"main_library","max_walk_minutes":null,"meal":"lunch","keywords":["cheap"],"sort":"cheapest","confidence":0.85}`;

class LLMError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Pull the first JSON object out of a model response, tolerating fences. */
export function extractJSON(text) {
  if (typeof text !== 'string') throw new LLMError('bad_json', 'Model returned no text');

  let s = text.trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();

  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) {
    throw new LLMError('bad_json', 'No JSON object found in model output');
  }
  const candidate = s.slice(first, last + 1);

  try {
    return JSON.parse(candidate);
  } catch (err) {
    throw new LLMError('bad_json', `Malformed JSON: ${err.message}`);
  }
}

function classifyHttp(status, body) {
  const snippet = (body || '').slice(0, 300);
  if (status === 401 || status === 403) return new LLMError('auth', `API key rejected (${status})`);
  if (status === 429) return new LLMError('rate_limit', 'Rate limited by the model provider');
  if (status >= 500) return new LLMError('upstream', `Model provider error ${status}`);
  return new LLMError('http_error', `HTTP ${status}: ${snippet}`);
}

/**
 * Call the Bailian (OpenAI-compatible) chat completions endpoint and return a
 * validated intent. Always resolves to a result object — it never throws, so
 * the caller can distinguish "model offline" from "model said something odd".
 */
export async function parseIntent(prompt) {
  const started = Date.now();
  const base = { model: config.model, latencyMs: 0 };

  if (!config.hasKey) {
    return { ...base, ok: false, error: { code: 'no_key', message: 'BAILIAN_API_KEY is not set' } };
  }

  let res;
  try {
    res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        temperature: 0,
        // Reasoning models bill their scratchpad against max_tokens, so leave
        // room for it: too tight and the JSON gets cut mid-object.
        max_tokens: 700,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (err) {
    const code = err.name === 'TimeoutError' ? 'timeout' : 'network';
    const message =
      code === 'timeout'
        ? `Model call exceeded ${config.timeoutMs}ms`
        : `Cannot reach ${config.baseUrl}: ${err.cause?.code || err.message}`;
    return { ...base, latencyMs: Date.now() - started, ok: false, error: { code, message } };
  }

  const bodyText = await res.text().catch(() => '');

  if (!res.ok) {
    const e = classifyHttp(res.status, bodyText);
    return { ...base, latencyMs: Date.now() - started, ok: false, error: { code: e.code, message: e.message } };
  }

  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    return {
      ...base,
      latencyMs: Date.now() - started,
      ok: false,
      error: { code: 'bad_response', message: 'Provider returned a non-JSON envelope' },
    };
  }

  const content = payload?.choices?.[0]?.message?.content;
  const latencyMs = Date.now() - started;

  let rawIntent;
  try {
    rawIntent = extractJSON(content);
  } catch (err) {
    return {
      ...base,
      latencyMs,
      ok: false,
      raw: typeof content === 'string' ? content.slice(0, 600) : null,
      error: { code: err.code || 'bad_json', message: err.message },
    };
  }

  const { ok, intent, errors, warnings } = validateIntent(rawIntent);
  if (!ok) {
    return {
      ...base,
      latencyMs,
      ok: false,
      raw: content.slice(0, 600),
      error: { code: 'invalid_schema', message: errors.join('; ') },
    };
  }

  return {
    ...base,
    latencyMs,
    ok: true,
    intent,
    rawIntent,
    raw: typeof content === 'string' ? content.slice(0, 800) : null,
    warnings,
    usage: payload?.usage ?? null,
  };
}
