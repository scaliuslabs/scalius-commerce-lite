import type { Database } from "@scalius/database/client";
import { categories, products } from "@scalius/database/schema";
import { and, desc, eq, isNull } from "drizzle-orm";

import { publicCategoryConditions } from "../modules/categories/categories.publication";
import { sanitizeSearchTokens } from "./fts5";

// The vocabulary is read only after a search returned nothing, and is bounded
// so a zero-result query costs at most this many short name rows.
const VOCABULARY_PRODUCT_LIMIT = 1_000;
const VOCABULARY_CATEGORY_LIMIT = 200;

// Words buyers use for things a catalog may name differently: native Bangla
// shopping words (loanwords such as ব্যাগ, শার্ট, কেতলি are handled by
// transliteration) and a few English synonyms. Each entry lists catalog words
// to try in order; a candidate is used only when the store's own product or
// category names contain it, so a correction never suggests a missing word.
const SHOPPING_SYNONYMS: ReadonlyArray<readonly [terms: readonly string[], candidates: readonly string[]]> = [
  [["জুতা", "জুতো"], ["shoe", "footwear", "sneaker", "sandal", "slipper", "loafer", "boot"]],
  [["shoe", "sneaker", "trainer", "sandal", "slipper", "boot", "loafer"], ["footwear", "shoe"]],
  [["footwear"], ["shoe"]],
  [["ব্যাগ", "থলে"], ["bag", "backpack", "tote", "handbag"]],
  [["মানিব্যাগ"], ["wallet", "purse"]],
  [["ঘড়ি"], ["watch", "clock"]],
  [["চশমা"], ["glasses", "sunglasses", "eyewear"]],
  [["glasses", "sunglasses", "spectacles"], ["eyewear"]],
  [["বই"], ["book"]],
  [["জামা"], ["shirt", "dress", "top", "kurti"]],
  [["কাপড়"], ["clothing", "fabric"]],
  [["শাড়ি"], ["saree", "sari"]],
  [["saree", "sari"], ["saree", "sari"]],
  [["থালা"], ["plate"]],
  [["বাটি"], ["bowl"]],
  [["চামচ"], ["spoon"]],
  [["ছুরি"], ["knife"]],
  [["হাঁড়ি", "পাতিল"], ["pot", "cookware"]],
  [["কড়াই"], ["wok", "pan"]],
  [["ছাতা"], ["umbrella"]],
  [["চা"], ["tea"]],
  [["মোজা"], ["socks"]],
  [["টুপি"], ["cap", "hat"]],
  [["বালিশ"], ["pillow", "cushion"]],
  [["pillow", "cushion"], ["cushion", "pillow"]],
  [["চাদর"], ["bedsheet", "sheet", "shawl"]],
  [["কম্বল"], ["blanket"]],
  [["তোয়ালে", "গামছা"], ["towel"]],
  [["পর্দা"], ["curtain"]],
  [["আয়না"], ["mirror"]],
  [["বাতি"], ["lamp", "light"]],
  [["ঝুড়ি"], ["basket"]],
  [["খেলনা"], ["toy"]],
  [["সাবান"], ["soap"]],
  [["আংটি"], ["ring"]],
  [["চুড়ি"], ["bangle", "bracelet"]],
  [["গয়না", "গহনা"], ["jewellery", "jewelry"]],
  [["jewelry", "jewellery"], ["jewellery", "jewelry"]],
  [["সুগন্ধি", "আতর"], ["perfume", "attar", "fragrance"]],
  [["sofa", "couch"], ["sofa", "couch"]],
  [["mug", "cup"], ["mug", "cup"]],
];
const SYNONYM_CANDIDATES = new Map<string, readonly string[]>(
  SHOPPING_SYNONYMS.flatMap(([terms, candidates]) =>
    terms.map((term) => [term.normalize("NFC"), candidates] as const)),
);

/** "shoes" → "shoe", "watches" → "watch"; "dress" stays "dress". */
function singular(word: string): string {
  if (word.length <= 3 || word.endsWith("ss")) return word;
  return word.replace(/(?:(?<=s|x|ch|sh)es|s)$/, "");
}

const BANGLA_VOWELS: Record<string, string> = {
  "অ": "o", "আ": "a", "ই": "i", "ঈ": "i", "উ": "u", "ঊ": "u", "ঋ": "ri",
  "এ": "e", "ঐ": "oi", "ও": "o", "ঔ": "ou",
  "া": "a", "ি": "i", "ী": "i", "ু": "u", "ূ": "u", "ৃ": "ri",
  "ে": "e", "ৈ": "oi", "ো": "o", "ৌ": "ou",
};
const BANGLA_CONSONANTS: Record<string, string> = {
  "ক": "k", "খ": "kh", "গ": "g", "ঘ": "gh", "ঙ": "ng",
  "চ": "ch", "ছ": "ch", "জ": "j", "ঝ": "jh", "ঞ": "n",
  "ট": "t", "ঠ": "th", "ড": "d", "ঢ": "dh", "ণ": "n",
  "ত": "t", "থ": "th", "দ": "d", "ধ": "dh", "ন": "n",
  "প": "p", "ফ": "f", "ব": "b", "ভ": "bh", "ম": "m",
  "য": "j", "র": "r", "ল": "l", "শ": "sh", "ষ": "sh", "স": "s", "হ": "h",
  "ড়": "r", "ঢ়": "rh", "য়": "y", "ৎ": "t", "ং": "ng", "ঃ": "h",
};
const NUKTA = "়";
const HASANTA = "্";
const NUKTA_CONSONANTS: Record<string, string> = { "য": "y", "ড": "r", "ঢ": "rh" };

/**
 * Phonetic Bangla → Latin transliteration for matching Bangla-typed loanwords
 * (ব্যাগ → bag, শার্ট → shart, কেতলি → ketli) against English catalog names.
 * Inherent vowels are dropped and the ya-phala is silent, which is how these
 * loanwords are pronounced; non-Bangla text passes through unchanged.
 */
export function transliterateBangla(text: string): string {
  const chars = [...text.normalize("NFC")];
  let output = "";
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]!;
    const next = chars[index + 1];
    if (next === NUKTA && NUKTA_CONSONANTS[char]) {
      output += NUKTA_CONSONANTS[char];
      index += 1;
    } else if (char === HASANTA) {
      // ্য (ya-phala) and ্ব (ba-phala) are not pronounced as separate letters.
      if (next === "য" || next === "ব") index += 1;
    } else if ((char === "অ" || char === "এ") && next === HASANTA && chars[index + 2] === "য") {
      output += "a"; // অ্যা / এ্যা spell the English "a" sound.
      index += 2;
    } else if (BANGLA_VOWELS[char] || BANGLA_CONSONANTS[char]) {
      output += BANGLA_VOWELS[char] ?? BANGLA_CONSONANTS[char];
    } else if (char >= "০" && char <= "৯") {
      output += String(char.charCodeAt(0) - 0x09e6);
    } else if (char !== "ঁ" && char !== NUKTA && char !== "ৗ") {
      output += char;
    }
  }
  return output;
}

/**
 * A spelling-insensitive key: transliterated, accent-free, lowercase, with
 * aspirates, c/k, v/b, y/i and doubled letters folded so "kettel", "ketle"
 * and "কেতলি" land within one or two edits of "kettle".
 */
export function phoneticSearchKey(word: string): string {
  return transliterateBangla(word)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/ph/g, "f")
    .replace(/([kgcjtdbs])h/g, "$1")
    .replace(/[cq]/g, "k")
    .replace(/x/g, "ks")
    .replace(/z/g, "j")
    .replace(/v/g, "b")
    .replace(/y/g, "i")
    .replace(/ee/g, "i")
    .replace(/oo/g, "u")
    .replace(/(.)\1+/g, "$1")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

/** Optimal-string-alignment distance, abandoned once it exceeds `max`. */
function editDistance(left: string, right: string, max: number): number {
  if (Math.abs(left.length - right.length) > max) return max + 1;
  let previousPrevious: number[] = [];
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    let rowMin = row;
    for (let column = 1; column <= right.length; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      let value = Math.min(previous[column]! + 1, current[column - 1]! + 1, previous[column - 1]! + cost);
      if (
        row > 1 && column > 1 &&
        left[row - 1] === right[column - 2] && left[row - 2] === right[column - 1]
      ) {
        value = Math.min(value, previousPrevious[column - 2]! + 1);
      }
      current.push(value);
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > max) return max + 1;
    previousPrevious = previous;
    previous = current;
  }
  return previous[right.length]!;
}

function allowedEdits(key: string): number {
  if (key.length <= 3) return 0;
  return key.length <= 5 ? 1 : 2;
}

/**
 * Rewrites a query that matched nothing into the closest words the catalog
 * actually uses. Terms that already match a catalog word (or its prefix) are
 * kept; misspelled, transliterated or native-Bangla terms are replaced by the
 * nearest catalog word; terms with no plausible match are dropped. Returns
 * null when nothing would change.
 */
export function correctSearchQuery(query: string, catalogNames: readonly string[]): string | null {
  const tokens = sanitizeSearchTokens(query).map((token) => token.toLocaleLowerCase());
  if (tokens.length === 0) return null;

  const frequency = new Map<string, number>();
  for (const name of catalogNames) {
    for (const word of sanitizeSearchTokens(name)) {
      const normalized = word.toLocaleLowerCase();
      if (normalized.length > 1) frequency.set(normalized, (frequency.get(normalized) ?? 0) + 1);
    }
  }
  const vocabulary = [...frequency].map(([word, count]) => ({ word, count, key: phoneticSearchKey(word) }));

  const corrected: string[] = [];
  let changed = false;
  for (const token of tokens) {
    if (vocabulary.some(({ word }) => word.startsWith(token))) {
      corrected.push(token);
      continue;
    }
    changed = true;
    const synonyms = SYNONYM_CANDIDATES.get(token) ?? SYNONYM_CANDIDATES.get(singular(token)) ?? [];
    const synonym = synonyms
      .map((candidate) => vocabulary
        .filter(({ word }) => singular(word) === singular(candidate))
        .sort((left, right) => right.count - left.count)[0])
      .find(Boolean);
    if (synonym) {
      if (!corrected.includes(synonym.word)) corrected.push(synonym.word);
      continue;
    }
    const key = phoneticSearchKey(synonyms[0] ?? token);
    if (!key) continue;
    const maxEdits = allowedEdits(key);
    let best: { word: string; count: number; distance: number } | null = null;
    for (const entry of vocabulary) {
      const distance = entry.key === key
        ? 0
        : key.length >= 3 && entry.key.startsWith(key)
          ? 0.5
          : maxEdits > 0 ? editDistance(key, entry.key, maxEdits) : Infinity;
      if (distance > maxEdits && distance !== 0.5) continue;
      if (!best || distance < best.distance || (distance === best.distance && entry.count > best.count)) {
        best = { word: entry.word, count: entry.count, distance };
      }
    }
    if (best && !corrected.includes(best.word)) corrected.push(best.word);
  }

  return changed && corrected.length > 0 ? corrected.join(" ") : null;
}

/**
 * Suggests a corrected query from public product and category names. Callers
 * run it only after the original query returned no results.
 */
export async function suggestSearchCorrection(db: Database, query: string): Promise<string | null> {
  if (sanitizeSearchTokens(query).length === 0) return null;
  const [productNames, categoryNames] = await Promise.all([
    db
      .select({ name: products.name })
      .from(products)
      .where(and(eq(products.isActive, true), isNull(products.deletedAt)))
      .orderBy(desc(products.updatedAt))
      .limit(VOCABULARY_PRODUCT_LIMIT),
    db
      .select({ name: categories.name })
      .from(categories)
      .where(and(...publicCategoryConditions()))
      .limit(VOCABULARY_CATEGORY_LIMIT),
  ]);
  return correctSearchQuery(query, [...productNames, ...categoryNames].map(({ name }) => name));
}
