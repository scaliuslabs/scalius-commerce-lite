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
 * Hindi (Devanagari) goes through the same engine with its own letters and
 * an inherent "a" (कुर्ता → kurta). Cyrillic, Greek, Arabic, Thai and Korean
 * are spelled from tables (МОСКВА → moskva). A run of letters in any other
 * script (Chinese, Japanese, Hebrew…) is never dropped: it becomes a short
 * stable code of its own (连衣裙 → four base-36 characters), so a name in any
 * script keeps a word for every word, and two names never read alike only
 * because one script was skipped.
 * Latin letters lose their accents; anything else becomes a single dash.
 */

export const HANDLE_MIN_LENGTH = 3;
export const HANDLE_MAX_LENGTH = 100;
export const HANDLE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type HandleResource = "product" | "category" | "collection" | "page" | "post" | "attribute";

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

/** One Brahmic script's letters, as the word engine below reads them. */
interface BrahmicScript {
  independentVowels: Record<string, string>;
  vowelSigns: Record<string, string>;
  consonants: Record<string, string>;
  nuktaConsonants: Record<string, string>;
  nukta: string;
  virama: string;
  modifiers: Record<string, string>;
  /** The modifier that does not keep the inherent vowel (candrabindu). */
  nasal: string;
  inherent: string;
  digitZero: number;
}

const BENGALI: BrahmicScript = {
  independentVowels: INDEPENDENT_VOWELS,
  vowelSigns: VOWEL_SIGNS,
  consonants: CONSONANTS,
  nuktaConsonants: NUKTA_CONSONANTS,
  nukta: NUKTA,
  virama: HASANTA,
  modifiers: MODIFIERS,
  nasal: "ঁ",
  inherent: "o",
  digitZero: BENGALI_DIGIT_ZERO,
};

const DEVANAGARI: BrahmicScript = {
  independentVowels: {
    "अ": "a", "आ": "a", "इ": "i", "ई": "i", "उ": "u", "ऊ": "u", "ऋ": "ri",
    "ए": "e", "ऐ": "ai", "ओ": "o", "औ": "au", "ऍ": "e", "ऑ": "o",
  },
  vowelSigns: {
    "ा": "a", "ि": "i", "ी": "i", "ु": "u", "ू": "u", "ृ": "ri",
    "े": "e", "ै": "ai", "ो": "o", "ौ": "au", "ॅ": "e", "ॉ": "o",
  },
  consonants: {
    "क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "n",
    "च": "ch", "छ": "chh", "ज": "j", "झ": "jh", "ञ": "n",
    "ट": "t", "ठ": "th", "ड": "d", "ढ": "dh", "ण": "n",
    "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n",
    "प": "p", "फ": "ph", "ब": "b", "भ": "bh", "म": "m",
    "य": "y", "र": "r", "ल": "l", "ळ": "l", "व": "v", "श": "sh", "ष": "sh", "स": "s", "ह": "h",
  },
  nuktaConsonants: { "क": "q", "ख": "kh", "ग": "gh", "ज": "z", "ड": "r", "ढ": "rh", "फ": "f", "य": "y" },
  nukta: "\u093C",
  virama: "\u094D",
  modifiers: { "ं": "n", "ः": "h", "ँ": "n" },
  nasal: "ँ",
  inherent: "a",
  digitZero: 0x0966,
};

type Unit =
  | { kind: "vowel"; text: string; suffix: string }
  | { kind: "consonant"; letter: string; text: string; vowel: string | undefined; hasanta: boolean; suffix: string; keepsInherent: boolean };

function isScriptLetter(char: string, script: BrahmicScript): boolean {
  return char in script.independentVowels || char in script.vowelSigns || char in script.consonants
    || char in script.modifiers || char === script.virama || char === script.nukta || JOINERS.has(char);
}

function transliterateWord(word: string, script: BrahmicScript = BENGALI): string {
  const units: Unit[] = [];
  for (const char of word) {
    const last = units.at(-1);
    if (JOINERS.has(char)) continue;
    if (char === script.nukta) {
      if (last?.kind === "consonant" && last.vowel === undefined && last.letter in script.nuktaConsonants) {
        last.text = script.nuktaConsonants[last.letter]!;
      }
    } else if (char in script.consonants) {
      const fixed = char === "ৎ";
      const yaPhala = char === "য" && last?.kind === "consonant" && last.hasanta;
      units.push({ kind: "consonant", letter: char, text: yaPhala ? "y" : script.consonants[char]!, vowel: fixed ? "" : undefined, hasanta: fixed, suffix: "", keepsInherent: false });
    } else if (char in script.vowelSigns) {
      if (last?.kind === "consonant" && last.vowel === undefined) last.vowel = script.vowelSigns[char]!;
      else units.push({ kind: "vowel", text: script.vowelSigns[char]!, suffix: "" });
    } else if (char === script.virama) {
      if (last?.kind === "consonant") {
        last.vowel = "";
        last.hasanta = true;
      }
    } else if (char in script.modifiers) {
      if (last) {
        last.suffix += script.modifiers[char]!;
        if (last.kind === "consonant" && char !== script.nasal) last.keepsInherent = true;
      }
    } else if (char in script.independentVowels) {
      units.push({ kind: "vowel", text: script.independentVowels[char]!, suffix: "" });
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
      if (unit.keepsInherent) vowel = script.inherent;
      else if (!next) vowel = "";
      else if (firstSyllable) vowel = script.inherent;
      else vowel = previousEndsInVowel && nextHasOwnVowel ? "" : script.inherent;
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
    if (isScriptLetter(char, BENGALI)) {
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

/** Letters spelled one by one: Cyrillic (Russian, Ukrainian, Belarusian, Serbian), Greek and Arabic, lower case. */
const LETTERS: Record<string, string> = {
  "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e", "ж": "zh", "з": "z", "и": "i",
  "й": "y", "к": "k", "л": "l", "м": "m", "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t",
  "у": "u", "ф": "f", "х": "kh", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "shch", "ъ": "", "ы": "y", "ь": "",
  "э": "e", "ю": "yu", "я": "ya", "є": "ye", "і": "i", "ї": "yi", "ґ": "g", "ў": "u",
  "ђ": "dj", "ј": "j", "љ": "lj", "њ": "nj", "ћ": "c", "џ": "dz", "ѓ": "g", "ќ": "k", "ѕ": "dz",
  "α": "a", "β": "v", "γ": "g", "δ": "d", "ε": "e", "ζ": "z", "η": "i", "θ": "th", "ι": "i", "κ": "k",
  "λ": "l", "μ": "m", "ν": "n", "ξ": "x", "ο": "o", "π": "p", "ρ": "r", "σ": "s", "ς": "s", "τ": "t",
  "υ": "y", "φ": "f", "χ": "ch", "ψ": "ps", "ω": "o",
  "ا": "a", "أ": "a", "إ": "i", "آ": "a", "ب": "b", "ت": "t", "ث": "th", "ج": "j", "ح": "h", "خ": "kh",
  "د": "d", "ذ": "dh", "ر": "r", "ز": "z", "س": "s", "ش": "sh", "ص": "s", "ض": "d", "ط": "t", "ظ": "z",
  "ع": "", "غ": "gh", "ف": "f", "ق": "q", "ك": "k", "ل": "l", "م": "m", "ن": "n", "ه": "h", "و": "w",
  "ي": "y", "ى": "a", "ة": "a", "ء": "", "ئ": "y", "ؤ": "w", "پ": "p", "چ": "ch", "ژ": "zh", "گ": "g",
  "ک": "k", "ی": "y", "ـ": "",
};

/** Thai, RTGS-like: a vowel written before its consonant is read after it. */
const THAI: Record<string, string> = {
  "ก": "k", "ข": "kh", "ฃ": "kh", "ค": "kh", "ฅ": "kh", "ฆ": "kh", "ง": "ng", "จ": "ch", "ฉ": "ch", "ช": "ch",
  "ซ": "s", "ฌ": "ch", "ญ": "y", "ฎ": "d", "ฏ": "t", "ฐ": "th", "ฑ": "th", "ฒ": "th", "ณ": "n", "ด": "d",
  "ต": "t", "ถ": "th", "ท": "th", "ธ": "th", "น": "n", "บ": "b", "ป": "p", "ผ": "ph", "ฝ": "f", "พ": "ph",
  "ฟ": "f", "ภ": "ph", "ม": "m", "ย": "y", "ร": "r", "ล": "l", "ว": "w", "ศ": "s", "ษ": "s", "ส": "s",
  "ห": "h", "ฬ": "l", "อ": "o", "ฮ": "h", "ฤ": "rue", "ฦ": "lue",
  "ะ": "a", "ั": "a", "า": "a", "ำ": "am", "ิ": "i", "ี": "i", "ึ": "ue", "ื": "ue", "ุ": "u", "ู": "u",
  "เ": "e", "แ": "ae", "โ": "o", "ใ": "ai", "ไ": "ai", "ๅ": "",
  "็": "", "่": "", "้": "", "๊": "", "๋": "", "์": "", "ๆ": "", "ฯ": "",
};
const THAI_LEADING_VOWELS = new Set(["เ", "แ", "โ", "ใ", "ไ"]);

const HANGUL_INITIALS = ["g", "kk", "n", "d", "tt", "r", "m", "b", "pp", "s", "ss", "", "j", "jj", "ch", "k", "t", "p", "h"];
const HANGUL_VOWELS = ["a", "ae", "ya", "yae", "eo", "e", "yeo", "ye", "o", "wa", "wae", "oe", "yo", "u", "wo", "we", "wi", "yu", "eu", "ui", "i"];
const HANGUL_FINALS = ["", "k", "k", "k", "n", "n", "n", "t", "l", "k", "m", "l", "l", "l", "p", "l", "m", "p", "p", "t", "t", "ng", "t", "t", "k", "t", "p", "t"];
const HANGUL_FIRST = 0xac00;
const HANGUL_LAST = 0xd7a3;

/** Other digits (Arabic-Indic, Persian, Devanagari, Thai) as 0–9. */
const DIGIT_ZEROS = [0x0660, 0x06f0, 0x0966, 0x0e50];
const ARABIC_MARK = /[\u064B-\u065F\u0670]/u;
const LATIN = /[\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u;
const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;

/**
 * `text` with every letter spelled in Latin (see the file comment): Bangla
 * and Hindi by the word engine, Cyrillic, Greek, Arabic, Thai and Korean by
 * table, and a run of any other script as one short stable code. Latin and
 * everything else is kept for `toHandle` to fold.
 */
export function transliterate(text: string): string {
  let output = "";
  let word = "";
  let wordScript: BrahmicScript | "other" | null = null;
  let thaiLeading = "";
  const flush = () => {
    if (word) output += wordScript === "other" ? `-${shortHash(word)}-` : transliterateWord(word, wordScript as BrahmicScript);
    word = "";
    wordScript = null;
  };
  for (const char of transliterateBangla(text).toLowerCase().normalize("NFC")) {
    const script = isScriptLetter(char, DEVANAGARI) ? DEVANAGARI : null;
    if (script) {
      if (wordScript !== script) flush();
      word += char;
      wordScript = script;
      continue;
    }
    const code = char.codePointAt(0)!;
    const zero = DIGIT_ZEROS.find((start) => code >= start && code <= start + 9);
    const greek = char.normalize("NFD")[0]!;
    if (zero !== undefined) {
      flush();
      output += String(code - zero);
    } else if (char in LETTERS || greek in LETTERS) {
      flush();
      output += LETTERS[char] ?? LETTERS[greek]!;
    } else if (ARABIC_MARK.test(char)) {
      flush();
    } else if (char in THAI) {
      flush();
      if (THAI_LEADING_VOWELS.has(char)) {
        thaiLeading += THAI[char]!;
        continue;
      }
      output += THAI[char]! + thaiLeading;
      thaiLeading = "";
      continue;
    } else if (code >= HANGUL_FIRST && code <= HANGUL_LAST) {
      flush();
      const index = code - HANGUL_FIRST;
      output += HANGUL_INITIALS[Math.floor(index / 588)]! + HANGUL_VOWELS[Math.floor((index % 588) / 28)]! + HANGUL_FINALS[index % 28]!;
    } else if (WORD_CHAR.test(char) && !LATIN.test(char)) {
      // A script with no spelling here: kept as its own stable code, never dropped.
      if (wordScript !== "other") flush();
      word += char;
      wordScript = "other";
      continue;
    } else {
      flush();
      output += char;
    }
    output += thaiLeading;
    thaiLeading = "";
  }
  flush();
  return output + thaiLeading;
}

/**
 * The handle a name reads as: every script spelled in Latin (`transliterate`), Latin accents folded,
 * lowercase, runs of anything else as one dash, at most 100 characters.
 * May be shorter than 3 characters or empty; see `handleFromText`.
 */
export function toHandle(text: string): string {
  const folded = transliterate(text)
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

/**
 * A SKU code for a name: its handle in upper case (ASCII, every script spelled
 * in Latin), at most `max` characters; a name that reads as fewer than three
 * characters (emoji, punctuation) gets a short stable code from the name
 * (`SKU-7K3F`), never a bare counter. Uniqueness is the caller's
 * (`readableDefaultSku` adds `-2`, `-3`…).
 */
export function skuCodeFromText(text: string, max = 60): string {
  const code = toHandle(text).toUpperCase().slice(0, max).replace(/-+$/, "");
  return code.length >= 3 ? code : `SKU-${shortHash(text.normalize("NFC").trim()).toUpperCase()}`;
}
