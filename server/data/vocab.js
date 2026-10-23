/**
 * Closed vocabularies the intent parser is allowed to emit.
 *
 * These are the contract between the LLM and the validator, so the model can
 * only ever echo values that exist here. They now live in data/vocab.json — a
 * migration cannot silently change what the model may say without editing a
 * file that is reviewed as data, not as code.
 *
 * This module re-exports the same names the rest of the app already imports, so
 * loaders stay JSON-backed without every caller changing.
 */

import { loadVocab } from './loadData.js';

export const VOCAB = loadVocab();

export const CUISINES = VOCAB.cuisines.map((c) => c.key);
export const DIETS = VOCAB.diets.map((d) => d.key);

/** Facet metadata: { key, label, color, synonyms }. */
export const FACETS = VOCAB.facets;

export const CUISINE_META = Object.fromEntries(VOCAB.cuisines.map((c) => [c.key, c]));
export const DIET_META = Object.fromEntries(VOCAB.diets.map((d) => [d.key, d]));
export const FACET_META = Object.fromEntries(VOCAB.facets.map((f) => [f.key, f]));

/**
 * Map a free-text cue onto a canonical facet key.
 * "late night" → "open-late", "fast" → "quick", "cheap" → "budget".
 * Returns null when nothing in the vocabulary matches.
 */
const SYNONYM_INDEX = (() => {
  const index = new Map();
  for (const facet of VOCAB.facets) {
    index.set(facet.key.replace(/-/g, ' '), facet.key);
    for (const syn of facet.synonyms) index.set(syn, facet.key);
  }
  return index;
})();

export function facetForCue(cue) {
  if (typeof cue !== 'string') return null;
  const key = cue.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!key) return null;
  if (SYNONYM_INDEX.has(key)) return SYNONYM_INDEX.get(key);

  // Fall back to matching a known synonym inside a longer cue ("open late tonight").
  for (const [needle, facet] of SYNONYM_INDEX) {
    if (needle.length >= 4 && key.includes(needle)) return facet;
  }
  return null;
}