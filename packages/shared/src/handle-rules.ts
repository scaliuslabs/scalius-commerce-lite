/**
 * What a web-address handle (`/products/<handle>`) is, and how one is read
 * from a name once the name is spelled in Latin: the part of handles that
 * carries no script tables. The spelling itself (Bangla, Hindi, Cyrillic…)
 * is `transliterate` in ./handle, whose `toHandle`, `handleFromText` and
 * `skuCodeFromText` are `handleSpelling(transliterate)`. The dashboard loads
 * those tables only when a name needs them (apps/admin-v2/src/lib/handle-spelling.ts):
 * a pure-ASCII name reads the same through `handleSpelling` with no spelling.
 */

export const HANDLE_MIN_LENGTH = 3;
export const HANDLE_MAX_LENGTH = 100;
export const HANDLE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type HandleResource = "product" | "category" | "collection" | "page" | "post" | "attribute";

const LATIN_LETTERS_WITHOUT_DECOMPOSITION: Record<string, string> = {
  "ß": "ss", "æ": "ae", "œ": "oe", "ø": "o", "đ": "d", "ł": "l", "þ": "th",
};

/** Four stable base-36 characters for `text` (FNV-1a), so a preview never flickers. */
export function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (const char of text) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(4, "0").slice(-4);
}

export interface HandleSpelling {
  /**
   * The handle a name reads as: every script spelled in Latin, Latin accents folded,
   * lowercase, runs of anything else as one dash, at most 100 characters.
   * May be shorter than 3 characters or empty; see `handleFromText`.
   */
  toHandle(text: string): string;
  /**
   * A valid handle for `text`, always 3–100 characters: a name that reads as
   * nothing (emoji, punctuation) becomes `product-7k3f`, and a one- or
   * two-character reading is prefixed (`attribute-xl`).
   */
  handleFromText(text: string, resource: HandleResource): string;
  /**
   * A SKU code for a name: its handle in upper case (ASCII, every script spelled
   * in Latin), at most `max` characters; a name that reads as fewer than three
   * characters (emoji, punctuation) gets a short stable code from the name
   * (`SKU-7K3F`), never a bare counter. Uniqueness is the caller's
   * (`readableDefaultSku` adds `-2`, `-3`…).
   */
  skuCodeFromText(text: string, max?: number): string;
}

/** The handle functions over `spell`, which writes a name's letters in Latin (lower case or not). */
export function handleSpelling(spell: (text: string) => string): HandleSpelling {
  const toHandle = (text: string): string => {
    const folded = spell(text)
      .toLowerCase()
      .replace(/[ßæœøđłþ]/g, (char) => LATIN_LETTERS_WITHOUT_DECOMPOSITION[char]!)
      .normalize("NFKD")
      .replace(/\p{M}+/gu, "");
    return folded
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, HANDLE_MAX_LENGTH)
      .replace(/-+$/, "");
  };
  return {
    toHandle,
    handleFromText(text, resource) {
      const handle = toHandle(text);
      if (handle.length >= HANDLE_MIN_LENGTH) return handle;
      return handle ? `${resource}-${handle}` : `${resource}-${shortHash(text.normalize("NFC").trim())}`;
    },
    skuCodeFromText(text, max = 60) {
      const code = toHandle(text).toUpperCase().slice(0, max).replace(/-+$/, "");
      return code.length >= 3 ? code : `SKU-${shortHash(text.normalize("NFC").trim()).toUpperCase()}`;
    },
  };
}

/**
 * The lowest free handle among `base`, `base-2`, `base-3`…, trimming the base
 * so the result stays within 100 characters. `taken` needs only the handles
 * equal to `base` or starting with `base-`.
 */
export function nextFreeHandle(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const tail = `-${suffix}`;
    const candidate = `${base.slice(0, HANDLE_MAX_LENGTH - tail.length).replace(/-+$/, "")}${tail}`;
    if (!used.has(candidate)) return candidate;
  }
}
