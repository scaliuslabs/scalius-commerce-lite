/**
 * Place-name search for every place picker (the storefront's checkout, the
 * dashboard's and the API's place searches): "mirpur 2" finds "Mirpur-2",
 * case, accents and Bengali digits don't matter, and Bangla typing
 * ("মিরপুর") finds the English name through a rough transliteration and,
 * failing an exact spelling, a consonant skeleton. Names that start with the
 * typed text come first, then names with a word that starts with it.
 */
import { toLatinDigits } from "./phone-input";

const BANGLA_LATIN: Record<string, string> = {
  "অ": "o", "আ": "a", "ই": "i", "ঈ": "i", "উ": "u", "ঊ": "u", "ঋ": "ri", "এ": "e", "ঐ": "oi", "ও": "o", "ঔ": "ou",
  "া": "a", "ি": "i", "ী": "i", "ু": "u", "ূ": "u", "ৃ": "ri", "ে": "e", "ৈ": "oi", "ো": "o", "ৌ": "ou",
  "ক": "k", "খ": "kh", "গ": "g", "ঘ": "gh", "ঙ": "ng", "চ": "ch", "ছ": "chh", "জ": "j", "ঝ": "jh", "ঞ": "n",
  "ট": "t", "ঠ": "th", "ড": "d", "ঢ": "dh", "ণ": "n", "ত": "t", "থ": "th", "দ": "d", "ধ": "dh", "ন": "n",
  "প": "p", "ফ": "f", "ব": "b", "ভ": "bh", "ম": "m", "য": "j", "র": "r", "ল": "l", "শ": "sh", "ষ": "sh",
  "স": "s", "হ": "h", "ৎ": "t", "ং": "ng", "ঃ": "h", "ঁ": "", "্": "",
};

/**
 * ড়, ঢ় and য় are a letter plus the nukta sign (U+09BC) after Unicode
 * normalisation, whichever way they were typed: two code points, so they
 * are read as a pair before the letters one by one ("বগুড়া" is "bogura",
 * not "boguda"; "নারায়ণগঞ্জ" is "narayanganj", not "narajanganj").
 */
const BANGLA_NUKTA_LATIN: Record<string, string> = {
  "\u09A1\u09BC": "r", "\u09A2\u09BC": "rh", "\u09AF\u09BC": "y",
};

/** Lower-case Latin letters and digits only; Bangla transliterated, accents dropped. */
export function placeSearchText(value: string): string {
  const plain = value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").normalize("NFC")
    .replace(/[\u09A1\u09A2\u09AF]\u09BC/gu, (pair) => BANGLA_NUKTA_LATIN[pair] ?? pair)
    // ক্ষ reads "kh" (সাতক্ষীরা is Satkhira, লক্ষ্মীপুর Lakshmipur), not "ksh".
    .replace(/\u0995\u09CD\u09B7/gu, "kh");
  const latin = Array.from(toLatinDigits(plain))
    .map((character) => BANGLA_LATIN[character] ?? character)
    .join("");
  return latin.toLocaleLowerCase("en-US").replace(/[^a-z0-9]/g, "");
}

/**
 * Consonants and digits, read the way Bangla typing and the everyday English
 * spellings agree: c/k, x/ks, ph/f, z/j and v/b are one sound; an h or an n
 * after the first letter is not written alike ("sh", "bh", "lh"; the nasal
 * Bangla writes as ং or ঁ or drops: চাঁদপুর "chadpur", মুন্সীগঞ্জ), so
 * neither counts; vowels never do (Bangla typing leaves out the inherent
 * one); doubled letters collapse. "kksbajar", "coxsbazar" and "Cox's Bazar"
 * all read "kbjr"; "silet" and "sylhet" read "slt".
 */
function skeleton(text: string): string {
  const sounds = text
    .replace(/x/g, "ks")
    .replace(/q/g, "k")
    .replace(/c(?!h)/g, "k")
    .replace(/ph/g, "f")
    .replace(/z/g, "j")
    .replace(/v/g, "b");
  return (sounds.slice(0, 1) + sounds.slice(1).replace(/[hn]/g, ""))
    .replace(/[aeiouyw]/g, "")
    .replace(/(.)\1+/g, "$1")
    .replace(/ks/g, "k")
    .replace(/(.)\1+/g, "$1");
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

/**
 * The typed text and the other spelling of a place it begins (at least 4
 * letters). Bangla typing has no fixed vowels ("চট্টগ্রাম" reads
 * "chttgram"), so a spelling also counts when its consonant skeleton begins
 * the typed text's, or the typed text's begins it.
 */
function searchSpellings(wanted: string): string[] {
  const spellings = [wanted];
  if (wanted.length < 4) return spellings;
  const wantedSkeleton = skeleton(wanted);
  for (const [first, second] of PLACE_NAME_VARIANTS) {
    for (const [from, to] of [[first, second], [second, first]] as const) {
      if (from.startsWith(wanted) || wanted.startsWith(from)) {
        spellings.push(to + wanted.slice(from.length));
        continue;
      }
      const fromSkeleton = skeleton(from);
      if (wantedSkeleton.length >= 3 && fromSkeleton.startsWith(wantedSkeleton)) {
        spellings.push(to);
      } else if (wantedSkeleton.startsWith(fromSkeleton)) {
        // The rest after the shortest typed prefix spelling the whole place.
        const end = [...wanted].findIndex((_, index) => skeleton(wanted.slice(0, index + 1)) === fromSkeleton);
        spellings.push(to + wanted.slice(end + 1));
      }
    }
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
 * the same place ("Chattogram" for "Chittagong") answers as well, half a
 * step after a match of the text as typed.
 */
export function placeRank(name: string, query: string): number | null {
  const typed = placeSearchText(query);
  if (!typed) return 0;
  let best: number | null = null;
  searchSpellings(typed).forEach((wanted, index) => {
    const found = rankSpelling(name, wanted);
    // A match through another spelling ranks just after the same match as typed.
    const rank = found === null ? null : found + (index > 0 ? 0.5 : 0);
    if (rank !== null && (best === null || rank < best)) best = rank;
  });
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
  // Two typed consonants at least ("ঝিনাই" reads "jhinai": j, h, n), though h and n do not count.
  const typedConsonants = wanted.replace(/[^a-z]|[aeiouyw]/g, "").length;
  if (wantedSkeleton.length >= 1 && typedConsonants >= 2 && tails.some((tail) => skeleton(tail).startsWith(wantedSkeleton))) return 3;
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
