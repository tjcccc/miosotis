/**
 * Language-agnostic text helpers. Original text is never rewritten; these produce derived forms only.
 */

const FOLDABLE_MARKS = /(\p{Script=Latin}|\p{Script=Greek}|\p{Script=Cyrillic})\p{M}+/gu;

/**
 * Search folding: compatibility-normalize (full-width → ASCII, ligatures), lowercase, and strip
 * diacritics only from Latin/Greek/Cyrillic letters. Marks that carry meaning in other scripts
 * (Japanese dakuten, Devanagari vowel signs, Hangul composition) are preserved.
 */
export function foldForSearch(text: string): string {
  return text.normalize("NFKC").toLowerCase().normalize("NFD").replace(FOLDABLE_MARKS, "$1").normalize("NFC");
}

export function codePointLength(text: string): number {
  let count = 0;
  for (const _ of text) {
    count += 1;
  }
  return count;
}

/** True when `index` would split a UTF-16 surrogate pair. */
export function splitsSurrogatePair(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) {
    return false;
  }
  const before = text.charCodeAt(index - 1);
  const after = text.charCodeAt(index);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

/** Truncates to at most `max` UTF-16 units without splitting a surrogate pair. */
export function safeSlice(text: string, start: number, end: number): string {
  let from = Math.max(0, Math.min(start, text.length));
  let to = Math.max(from, Math.min(end, text.length));
  if (splitsSurrogatePair(text, from)) {
    from -= 1;
  }
  if (splitsSurrogatePair(text, to)) {
    to -= 1;
  }
  return text.slice(from, to);
}

const SLUG_FORBIDDEN = /[\s/\\?#%*:|"<>.,;'`!@$^&(){}[\]=+~]+/gu;

/**
 * Project slugs may use any script. Folded to a stable, comparable form: NFKC, lowercase,
 * separators collapsed to single hyphens.
 */
export function normalizeSlug(input: string): string {
  return input
    .normalize("NFKC")
    .toLowerCase()
    .trim()
    .replace(SLUG_FORBIDDEN, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function isValidSlug(slug: string): boolean {
  return slug.length > 0 && slug.length <= 64 && /^[\p{L}\p{N}][\p{L}\p{N}\p{M}_-]*$/u.test(slug);
}
