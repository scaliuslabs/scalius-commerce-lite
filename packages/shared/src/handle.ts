/**
 * Web-address handles (`/products/<handle>`) derived from merchant names.
 *
 * Bangla is transliterated phonetically so a Bangla-only name still gets a
 * readable Latin handle ("লাল শাড়ি" → "lal-shari", "কুর্তা" → "kurta"):
 * - Consonants and vowels follow the table below (শ/ষ → sh, ড়/র → r,
 *   য় → y, য → j, or y after a hasanta as in ব্যাগ → byag; ৎ → t).
 * - The inherent vowel is written "o" in a word's first syllable (মধু →
 *   modhu), before ং/ঃ (রং → rong), and in a middle consonant unless it sits
 *   between a vowel and a consonant carrying its own vowel sign (বোরকা →
 *   borka, কাপড় → kapor). It is never written at the end of a word or before
 *   a hasanta.
 * - ং → ng, ঃ → h, ঁ is dropped, Bengali digits become 0–9.
 * Latin letters lose their accents; anything else becomes a single dash.
 */

export const HANDLE_MIN_LENGTH = 3;
export const HANDLE_MAX_LENGTH = 100;
export const HANDLE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type HandleResource = "product" | "category" | "page" | "post" | "attribute";

const INDEPENDENT_VOWELS: Record<string, string> = {
  "অ": "o", "আ": "a", "ই": "i", "ঈ": "i", "উ": "u", "ঊ": "u", "ঋ": "ri",
  "এ": "e", "ঐ": "oi", "ও": "o", "ঔ": "ou",
};

const VOWEL_SIGNS: Record<string, string> = {
  "া": "a", "ি": "i", "ী": "i", "ু": "u", "ূ": "u", "ৃ": "ri",
  "ে": "e", "ৈ": "oi", "ো": "o", "ৌ": "ou",
};

const CONSONANTS: Record<string, string> = {
  "ক": "k", "খ": "kh", "গ": "g", "ঘ": "gh", "ঙ": "ng",
  "চ": "ch", "ছ": "chh", "জ": "j", "ঝ": "jh", "ঞ": "n",
  "ট": "t", "ঠ": "th", "ড": "d", "ঢ": "dh", "ণ": "n",
  "ত": "t", "থ": "th", "দ": "d", "ধ": "dh", "ন": "n",
  "প": "p", "ফ": "f", "ব": "b", "ভ": "bh", "ম": "m",
  "য": "j", "র": "r", "ল": "l", "শ": "sh", "ষ": "sh", "স": "s", "হ": "h",
  "ৎ": "t",
};

/** ড, ঢ, য followed by the nukta sign (how NFC stores ড় ঢ় য়). */
const NUKTA_CONSONANTS: Record<string, string> = { "ড": "r", "ঢ": "rh", "য": "y" };
const NUKTA = "\u09BC";
const HASANTA = "\u09CD";
const MODIFIERS: Record<string, string> = { "ং": "ng", "ঃ": "h", "ঁ": "" };
const JOINERS = new Set(["\u200C", "\u200D"]);
const BENGALI_DIGIT_ZERO = 0x09e6;
const LATIN_LETTERS_WITHOUT_DECOMPOSITION: Record<string, string> = {
  "ß": "ss", "æ": "ae", "œ": "oe", "ø": "o", "đ": "d", "ł": "l", "þ": "th",
};

type Unit =
  | { kind: "vowel"; text: string; suffix: string }
  | { kind: "consonant"; letter: string; text: string; vowel: string | undefined; hasanta: boolean; suffix: string; keepsInherent: boolean };

function isBengaliLetter(char: string): boolean {
  return char in INDEPENDENT_VOWELS || char in VOWEL_SIGNS || char in CONSONANTS
    || char in MODIFIERS || char === HASANTA || char === NUKTA || JOINERS.has(char);
}

function transliterateWord(word: string): string {
  const units: Unit[] = [];
  for (const char of word) {
    const last = units.at(-1);
    if (JOINERS.has(char)) continue;
    if (char === NUKTA) {
      if (last?.kind === "consonant" && last.vowel === undefined && last.letter in NUKTA_CONSONANTS) {
        last.text = NUKTA_CONSONANTS[last.letter]!;
      }
    } else if (char in CONSONANTS) {
      const fixed = char === "ৎ";
      const yaPhala = char === "য" && last?.kind === "consonant" && last.hasanta;
      units.push({ kind: "consonant", letter: char, text: yaPhala ? "y" : CONSONANTS[char]!, vowel: fixed ? "" : undefined, hasanta: fixed, suffix: "", keepsInherent: false });
    } else if (char in VOWEL_SIGNS) {
      if (last?.kind === "consonant" && last.vowel === undefined) last.vowel = VOWEL_SIGNS[char]!;
      else units.push({ kind: "vowel", text: VOWEL_SIGNS[char]!, suffix: "" });
    } else if (char === HASANTA) {
      if (last?.kind === "consonant") {
        last.vowel = "";
        last.hasanta = true;
      }
    } else if (char in MODIFIERS) {
      if (last) {
        last.suffix += MODIFIERS[char]!;
        if (last.kind === "consonant" && char !== "ঁ") last.keepsInherent = true;
      }
    } else if (char in INDEPENDENT_VOWELS) {
      units.push({ kind: "vowel", text: INDEPENDENT_VOWELS[char]!, suffix: "" });
    }
  }

  let firstSyllable = true;
  let previousEndsInVowel = false;
  let output = "";
  units.forEach((unit, index) => {
    if (unit.kind === "vowel") {
      output += unit.text + unit.suffix;
      firstSyllable = false;
      previousEndsInVowel = true;
      return;
    }
    let vowel = unit.vowel;
    if (vowel === undefined) {
      const next = units[index + 1];
      const nextHasOwnVowel = next?.kind === "consonant" && Boolean(next.vowel);
      if (unit.keepsInherent) vowel = "o";
      else if (!next) vowel = "";
      else if (firstSyllable) vowel = "o";
      else vowel = previousEndsInVowel && nextHasOwnVowel ? "" : "o";
    }
    output += unit.text + vowel + unit.suffix;
    if (!unit.hasanta) firstSyllable = false;
    previousEndsInVowel = vowel !== "";
  });
  return output;
}

/** Bangla letters and digits in `text` spelled in Latin; everything else is kept. */
export function transliterateBangla(text: string): string {
  let output = "";
  let word = "";
  for (const char of text.normalize("NFC")) {
    if (isBengaliLetter(char)) {
      word += char;
      continue;
    }
    if (word) output += transliterateWord(word);
    word = "";
    const code = char.codePointAt(0)!;
    output += code >= BENGALI_DIGIT_ZERO && code <= BENGALI_DIGIT_ZERO + 9
      ? String(code - BENGALI_DIGIT_ZERO)
      : char;
  }
  return word ? output + transliterateWord(word) : output;
}

/**
 * The handle a name reads as: Bangla transliterated, Latin accents folded,
 * lowercase, runs of anything else as one dash, at most 100 characters.
 * May be shorter than 3 characters or empty; see `handleFromText`.
 */
export function toHandle(text: string): string {
  const folded = transliterateBangla(text)
    .toLowerCase()
    .replace(/[ßæœøđłþ]/g, (char) => LATIN_LETTERS_WITHOUT_DECOMPOSITION[char]!)
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "");
  return folded
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, HANDLE_MAX_LENGTH)
    .replace(/-+$/, "");
}

/** Four stable base-36 characters for `text` (FNV-1a), so a preview never flickers. */
function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (const char of text) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(4, "0").slice(-4);
}

/**
 * A valid handle for `text`, always 3–100 characters: a name that reads as
 * nothing (emoji, punctuation) becomes `product-7k3f`, and a one- or
 * two-character reading is prefixed (`attribute-xl`).
 */
export function handleFromText(text: string, resource: HandleResource): string {
  const handle = toHandle(text);
  if (handle.length >= HANDLE_MIN_LENGTH) return handle;
  return handle ? `${resource}-${handle}` : `${resource}-${shortHash(text.normalize("NFC").trim())}`;
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
