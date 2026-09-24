/**
 * Loose place-name matching for the thana filter: "mirpur 2" finds
 * "Mirpur-2", Bengali digits count, and Bangla typing ("মিরপুর") finds the
 * English name by comparing consonant skeletons of a rough transliteration.
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

/** Lower-case Latin letters and digits only; Bangla transliterated. */
export function placeSearchText(value: string): string {
  const latin = Array.from(toLatinDigits(value.normalize("NFC")))
    .map((character) => BANGLA_LATIN[character] ?? character)
    .join("");
  return latin.toLocaleLowerCase("en-US").replace(/[^a-z0-9]/g, "");
}

/** Consonants and digits, doubled letters collapsed: spelling-tolerant. */
function skeleton(text: string): string {
  return text
    .replace(/[aeiouyw]/g, "")
    .replace(/(.)\1+/g, "$1")
    .replace(/(?<=[bcdgjkpt])h/g, "");
}

export function placeMatches(name: string, query: string): boolean {
  const wanted = placeSearchText(query);
  if (!wanted) return true;
  const candidate = placeSearchText(name);
  if (candidate.includes(wanted)) return true;
  const wantedSkeleton = skeleton(wanted);
  return wantedSkeleton.length >= 2 && skeleton(candidate).includes(wantedSkeleton);
}
