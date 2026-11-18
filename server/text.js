/**
 * Outlet names are typed from memory, never copied: the dataset says
 * "JuYing Tai 聚英臺" and "TamJai SamGor 譚仔三哥", while people write
 * "ju ying tai", "juyingtai" or "tam jai". Comparing raw strings makes every
 * one of those a miss, so names are compared on a compact form instead:
 * case, spacing, punctuation and width folded away on both sides.
 */
export function compact(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Does `request` name `value`? Containment rather than equality, so "tamjai"
 * finds "TamJai SamGor 譚仔三哥" and "ju ying tai" finds "JuYing Tai 聚英臺".
 *
 * A fragment shorter than three characters must match exactly: "ta" or "so"
 * would otherwise anchor to half the directory. Nothing is guessed beyond
 * that — a typo still misses, and says so, rather than resolving to the
 * nearest outlet the user never asked for.
 */
export function looseNameMatch(request, value) {
  const asked = compact(request);
  const offered = compact(value);
  if (!asked || !offered) return false;
  if (asked.length < 3) return asked === offered;
  return offered.includes(asked);
}