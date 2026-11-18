#!/usr/bin/env node
/**
 * Replaces the stock cuisine photos on the result cards with photographs of the
 * actual outlets, taken from each outlet's own page on the HKU catering site.
 *
 *   npm run photos                 # fetch whatever is missing, then wire the JSON
 *   npm run photos -- --force      # refetch everything
 *   npm run photos -- --only=subway-rrs --candidate=2
 *
 * Why not name-matched stock images: the card is an answer to "where do I eat",
 * and a search for a bank of unrelated noodle photos teaches nothing about the
 * room you are walking into. The catering site already publishes 5-8 photos per
 * outlet; those are the only images that are both relevant and attributable.
 *
 * The picks are recorded in data/outlet-photos.json (page URL, photo URL,
 * fetch date) so the provenance of every card image is checkable later.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CANTEENS = join(ROOT, 'data/canteens.json');
const MANIFEST = join(ROOT, 'data/outlet-photos.json');
const OUT_DIR = join(ROOT, 'public/img/outlets');

const FORCE = process.argv.includes('--force');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) ?? '').split('=')[1];
const CANDIDATE = Number((process.argv.find((a) => a.startsWith('--candidate=')) ?? '').split('=')[1] ?? 1);

// A few galleries publish a product shot letterboxed on a white canvas. Cropping
// to the artwork is a per-outlet judgement call, so it is passed in explicitly
// (`--crop=top,left,height,width`) and recorded in the manifest rather than
// guessed from pixel colours.
const CROP = (process.argv.find((a) => a.startsWith('--crop=')) ?? '').split('=')[1];
const crop = CROP ? CROP.split(',').map(Number) : null;
if (crop && (crop.length !== 4 || crop.some((n) => !Number.isFinite(n) || n < 0))) {
  throw new Error('--crop expects top,left,height,width');
}
if (crop && !ONLY) throw new Error('--crop only makes sense with --only=<id>');

// The site serves one shared placeholder PNG inside every gallery; it is not a
// photo of anything.
const LOGO = '/cache/img/110c37885cee7710dbc856251d6a19f6ea8f1b762520.png';
const UA = 'hku-canteen-finder/1.0 (prototype; outlet photo cache)';
const MAX_WIDTH = 900;

const G = '\x1b[32m', R = '\x1b[31m', D = '\x1b[2m', B = '\x1b[1m', X = '\x1b[0m';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, attempt = 1) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    if (attempt >= 3) throw err;
    // The catering host times out under bursts; back off rather than hammering.
    await sleep(attempt * 1500);
    return fetchText(url, attempt + 1);
  }
}

async function fetchBuffer(url, attempt = 1) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    if (attempt >= 3) throw err;
    await sleep(attempt * 1500);
    return fetchBuffer(url, attempt + 1);
  }
}

/** Real gallery photos, in page order, minus the shared placeholder. */
function galleryPhotos(html) {
  const start = html.indexOf('gallery-container');
  const slice = start < 0 ? html : html.slice(start, start + 8000);
  const seen = new Set();
  return [...slice.matchAll(/<img\b[^>]*\bsrc="(\/cache\/img\/[^"]+)"/g)]
    .map((m) => m[1])
    .filter((url) => url !== LOGO && /\.(jpe?g|webp)$/i.test(url))
    .filter((url) => (seen.has(url) ? false : seen.add(url)));
}

/** sips is macOS-only; without it the original bytes are kept, only bigger. */
function resize(srcPath, destPath) {
  const encode = ['-s', 'format', 'jpeg', '-s', 'formatOptions', '72'];
  let input = srcPath;
  try {
    // Cropping and resampling in one sips call does not compose: the resample
    // factor is taken from the original, not from the cropped result, so the
    // output came out at 90% of the crop. Two passes, or the image is soft.
    if (crop) {
      input = `${destPath}.crop`;
      execFileSync(
        'sips',
        ['-c', String(crop[2]), String(crop[3]), '--cropOffset', String(crop[0]), String(crop[1]), srcPath, '--out', input],
        { stdio: 'ignore' }
      );
    }
    execFileSync('sips', ['--resampleWidth', String(MAX_WIDTH), ...encode, input, '--out', destPath], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  } finally {
    if (input !== srcPath && existsSync(input)) unlinkSync(input);
  }
}

/**
 * Point one canteen's `image` at its local photo. Done as a text edit inside the
 * record: several canteens share an image URL, so a global replace would hit the
 * wrong entries.
 */
function setImagePath(text, id, src) {
  const idIdx = text.indexOf(`"id": "${id}"`);
  if (idIdx < 0) throw new Error(`${id}: not present in data/canteens.json`);

  const nextIdIdx = text.indexOf('"id": "', idIdx + 1);
  const keyIdx = text.indexOf('"image": ', idIdx);
  if (keyIdx < 0 || (nextIdIdx >= 0 && keyIdx > nextIdIdx)) throw new Error(`${id}: image field not found`);

  const start = text.indexOf('"', keyIdx + '"image": '.length);
  const end = text.indexOf('"', start + 1);
  if (start < 0 || end < 0) throw new Error(`${id}: unterminated image value`);

  return text.slice(0, start + 1) + src + text.slice(end);
}

async function main() {
  const canteens = JSON.parse(readFileSync(CANTEENS, 'utf8')).canteens;
  const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : { note: '', photos: {} };
  const targets = ONLY ? canteens.filter((c) => c.id === ONLY) : canteens;
  if (ONLY && targets.length === 0) throw new Error(`unknown canteen id: ${ONLY}`);

  mkdirSync(OUT_DIR, { recursive: true });

  console.log(`\n${B}HKU Canteen Finder — outlet photos${X}`);
  console.log(`  ${D}out${X}     public/img/outlets/`);
  console.log(`  ${D}manifest${X} data/outlet-photos.json`);
  console.log(`  ${D}pick${X}     candidate ${CANDIDATE}${FORCE ? ' (refetch)' : ''}\n`);

  const failed = [];
  let written = 0;

  for (const c of targets) {
    const rel = `/img/outlets/${c.id}.jpg`;
    const dest = join(OUT_DIR, `${c.id}.jpg`);

    if (existsSync(dest) && !FORCE) {
      console.log(`  ${D}skip${X}  ${c.id} ${D}(already fetched)${X}`);
      continue;
    }

    const page = c.sources?.[0]?.url;
    if (!page || new URL(page).host !== 'catering.hku.hk') {
      failed.push([c.id, 'no catering.hku.hk source page']);
      console.log(`  ${R}✗${X}     ${c.id} ${D}no official outlet page${X}`);
      continue;
    }

    try {
      const photos = galleryPhotos(await fetchText(page));
      const photo = photos[CANDIDATE - 1];
      if (!photo) {
        failed.push([c.id, `only ${photos.length} gallery photos`]);
        console.log(`  ${R}✗${X}     ${c.id} ${D}only ${photos.length} gallery photos${X}`);
        continue;
      }

      const bytes = await fetchBuffer(`https://catering.hku.hk${photo}`);
      const tmp = `${dest}.download`;
      writeFileSync(tmp, bytes);

      const resized = resize(tmp, dest);
      if (!resized) renameSync(tmp, dest);
      else if (existsSync(tmp)) unlinkSync(tmp);

      const size = readFileSync(dest).length;
      manifest.photos[c.id] = {
        file: rel,
        page,
        photo: `https://catering.hku.hk${photo}`,
        candidate: CANDIDATE,
        ...(crop ? { crop: `top ${crop[0]}, left ${crop[1]}, ${crop[3]}x${crop[2]}` } : {}),
        fetchedAt: new Date().toISOString().slice(0, 10),
      };
      written += 1;
      console.log(`  ${G}✓${X}     ${c.id.padEnd(24)} ${D}${Math.round(size / 1024)} KB, candidate ${CANDIDATE}/${photos.length}${X}`);
      await sleep(300);
    } catch (err) {
      failed.push([c.id, err.message]);
      console.log(`  ${R}✗${X}     ${c.id} ${D}${err.message}${X}`);
    }
  }

  manifest.note =
    'Card photos are photographs of the outlet itself, taken from the gallery on that outlet\'s page at catering.hku.hk (HKU Campus Services Office, Catering and Hospitality). Images are downscaled to 900px and re-encoded; content is unmodified. Regenerate with `npm run photos`.';

  let text = readFileSync(CANTEENS, 'utf8');
  for (const c of canteens) {
    if (!existsSync(join(OUT_DIR, `${c.id}.jpg`))) continue;
    text = setImagePath(text, c.id, `/img/outlets/${c.id}.jpg`);
  }
  writeFileSync(CANTEENS, text);
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);

  // Fail loudly if the edit left the dataset unparseable.
  const check = JSON.parse(readFileSync(CANTEENS, 'utf8')).canteens;
  const local = check.filter((c) => String(c.image).startsWith('/img/outlets/')).length;
  if (local !== check.length) {
    console.log(`\n  ${R}${check.length - local} canteen(s) still point elsewhere${X}`);
  }

  console.log(`\n  ${written} written, ${local}/${check.length} canteens use a local outlet photo`);
  if (failed.length) {
    console.log(`  ${R}${failed.length} failed${X} — rerun with --force, or pick another candidate`);
    for (const [id, why] of failed) console.log(`    ${id}: ${why}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`${R}failed${X} ${err.stack}`);
  process.exit(1);
});