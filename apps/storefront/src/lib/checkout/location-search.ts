/**
 * Place-name search for the location pickers: "mirpur 2" finds "Mirpur-2",
 * case, accents and Bengali digits don't matter, and Bangla typing
 * ("মিরপুর") finds the English name through a rough transliteration and,
 * failing an exact spelling, a consonant skeleton. Names that start with the
 * typed text come first, then names with a word that starts with it.
 */
import { toLatinDigits } from "@scalius/shared/phone-input";

const BANGLA_LATIN: Record<string, string> = {
  "অ": "o", "আ": "a", "ই": "i", "ঈ": "i", "উ": "u", "ঊ": "u", "ঋ": "ri", "এ": "e", "ঐ": "oi", "ও": "o", "ঔ": "ou",
  "া": "a", "ি": "i", "ী": "i", "ু": "u", "ূ": "u", "ৃ": "ri", "ে": "e", "ৈ": "oi", "ো": "o", "ৌ": "ou",
  "ক": "k", "খ": "kh", "গ": "g", "ঘ": "gh", "ঙ": "ng", "চ": "ch", "ছ": "chh", "জ": "j", "ঝ": "jh", "ঞ": "n",
  "ট": "t", "ঠ": "th", "ড": "d", "ঢ": "dh", "ণ": "n", "ত": "t", "থ": "th", "দ": "d", "ধ": "dh", "ন": "n",
  "প": "p", "ফ": "f", "ব": "b", "ভ": "bh", "ম": "m", "য": "j", "র": "r", "ল": "l", "শ": "sh", "ষ": "sh",
  "স": "s", "হ": "h", "ড়": "r", "ঢ়": "rh", "য়": "y", "ৎ": "t", "ং": "ng", "ঃ": "h", "ঁ": "", "্": "",
};

/** Lower-case Latin letters and digits only; Bangla transliterated, accents dropped. */
export function placeSearchText(value: string): string {
  const plain = value.normalize("NFD").replace(/[̀-ͯ]/g, "").normalize("NFC");
  const latin = Array.from(toLatinDigits(plain))
    .map((character) => BANGLA_LATIN[character] ?? character)
    .join("");
  return latin.toLocaleLowerCase("en-US").replace(/[^a-z0-9]/g, "");
}

/** Consonants and digits, doubled letters collapsed: spelling-tolerant. */
function skeleton(text: string): string {
  return text
    .replace(/z/g, "j")
    .replace(/v/g, "b")
    .replace(/[aeiouyw]/g, "")
    .replace(/(.)\1+/g, "$1")
    .replace(/(?<=[bcdgjkpt])h/g, "");
}

/** Each word's search text; a word runs to the next space or punctuation. */
function placeWords(name: string): string[] {
  return name.split(/[\s\-_,./()]+/u).map(placeSearchText).filter(Boolean);
}

/**
 * Official and everyday spellings of the same place (the 2018 renames and
 * common romanisations): the courier's list says "Chittagong" while a buyer
 * types "Chattogram". Search text on both sides.
 */
const PLACE_NAME_VARIANTS: ReadonlyArray<readonly [string, string]> = [
  ["chattogram", "chittagong"],
  ["barishal", "barisal"],
  ["bogura", "bogra"],
  ["jashore", "jessore"],
  ["cumilla", "comilla"],
  ["brahmanbaria", "bbaria"],
  ["narsingdi", "narshingdi"],
  ["jhenaidah", "jhenidah"],
  ["gopalganj", "gopalgonj"],
  ["moulvibazar", "maulvibazar"],
  ["coxsbazar", "coxbazar"],
];

/** The typed text and the other spelling of a place it begins (at least 4 letters). */
function searchSpellings(wanted: string): string[] {
  const spellings = [wanted];
  if (wanted.length < 4) return spellings;
  for (const [first, second] of PLACE_NAME_VARIANTS) {
    if (first.startsWith(wanted) || wanted.startsWith(first)) spellings.push(second + wanted.slice(first.length));
    else if (second.startsWith(wanted) || wanted.startsWith(second)) spellings.push(first + wanted.slice(second.length));
  }
  return spellings;
}

/**
 * A place name as a buyer reads it: a courier's lower-case word starts with
 * a capital ("Double mooring" reads "Double Mooring"); other letters stay.
 */
export function placeDisplayName(name: string): string {
  return name.replace(/(^|[\s\-(/])([a-z])/g, (_, before: string, letter: string) => before + letter.toUpperCase());
}

/**
 * How well `name` answers `query`: 0 the name starts with it, 1 a word
 * starts with it, 2 it appears inside the name, 3 a word starts with it
 * spelled differently. `null` when it doesn't match. Another spelling of
 * the same place ("Chattogram" for "Chittagong") answers as well.
 */
export function placeRank(name: string, query: string): number | null {
  const typed = placeSearchText(query);
  if (!typed) return 0;
  let best: number | null = null;
  for (const wanted of searchSpellings(typed)) {
    const rank = rankSpelling(name, wanted);
    if (rank !== null && (best === null || rank < best)) best = rank;
  }
  return best;
}

function rankSpelling(name: string, wanted: string): number | null {
  const words = placeWords(name);
  // From each word to the end of the name, so "mirpur 2" finds "Road, Mirpur-2".
  const tails = words.map((_, index) => words.slice(index).join(""));
  if (tails[0]?.startsWith(wanted)) return 0;
  if (tails.some((tail) => tail.startsWith(wanted))) return 1;
  if (tails[0]?.includes(wanted)) return 2;
  const wantedSkeleton = skeleton(wanted);
  if (wantedSkeleton.length >= 2 && tails.some((tail) => skeleton(tail).startsWith(wantedSkeleton))) return 3;
  return null;
}

/** The places matching `query`, best first; equally good ones keep their order. */
export function rankPlaces<T extends { name: string }>(places: readonly T[], query: string): T[] {
  return places
    .map((place, index) => ({ place, index, rank: placeRank(place.name, query) }))
    .filter((entry): entry is { place: T; index: number; rank: number } => entry.rank !== null)
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((entry) => entry.place);
}
