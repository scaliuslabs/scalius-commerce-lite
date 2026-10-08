// One Bangla word per idea across every dashboard catalog. Merchants saw
// "খসড়া" on one list and "ড্রাফট" on the next, "সক্রিয়" beside "চালু" for the
// same Active state, and a period glued into a sentence ("আগের সময়ের
// সঙ্গে-এর তুলনায়"). This test reads every catalog and flags those.
import { describe, expect, it } from "vitest";

type Catalog = { en: Record<string, string>; bn: Record<string, string> };

const modules = import.meta.glob<Record<string, unknown>>(["./*.ts", "!./*.test.ts"], { eager: true });

/** Every en/bn catalog exported by `src/i18n/*`, by "file › export". */
const catalogs: Array<[string, Catalog]> = Object.entries(modules)
  .filter(([file]) => !file.endsWith(".test.ts"))
  .flatMap(([file, exports]) => Object.entries(exports).flatMap(([name, value]): Array<[string, Catalog]> => {
    const catalog = value as Partial<Catalog> | null;
    return catalog && typeof catalog === "object" && catalog.en && catalog.bn && typeof catalog.bn === "object"
      ? [[`${file.slice(2)} › ${name}`, catalog as Catalog]]
      : [];
  }));

const nfc = (text: string) => text.normalize("NFC");

/** bn strings (with where they are) that match. */
function bnMatching(test: (bn: string, en: string | undefined) => boolean): string[] {
  return catalogs.flatMap(([where, catalog]) =>
    Object.entries(catalog.bn).flatMap(([key, bn]) =>
      typeof bn === "string" && test(nfc(bn), catalog.en[key]) ? [`${where} › ${key}: ${bn}`] : []));
}

/** Words merchants were shown for the same thing; the first is the one to use. */
const SYNONYMS: ReadonlyArray<{ use: string; never: readonly string[] }> = [
  { use: "খসড়া", never: ["ড্রাফট", "ড্রাফ্ট"] },
];

/** "Active" as a state of a record: সক্রিয়, never চালু (চালু stays for "turn on"). */
const ACTIVE_STATE_PHRASES = /চালু (ক্যাটাগরি|পণ্য|প্রোডাক্ট|ডিসকাউন্ট|রেট|লোকেশন|কালেকশন)|^চালু নয়$/;

describe("Bangla vocabulary", () => {
  it("reads every catalog", () => {
    expect(catalogs.length).toBeGreaterThan(40);
  });

  it.each(SYNONYMS)("says $use, never its synonyms", ({ never }) => {
    expect(bnMatching((bn) => never.some((word) => bn.includes(nfc(word))))).toEqual([]);
  });

  it("names the Draft and Active states with one word each", () => {
    expect(bnMatching((bn, en) => en?.trim().toLowerCase() === "draft" && bn !== nfc("খসড়া"))).toEqual([]);
    expect(bnMatching((bn, en) => en?.trim().toLowerCase() === "active" && bn !== nfc("সক্রিয়"))).toEqual([]);
    expect(bnMatching((bn) => ACTIVE_STATE_PHRASES.test(bn))).toEqual([]);
  });

  it("never glues a phrase into another sentence", () => {
    expect(bnMatching((bn) => /সঙ্গে-এর|সাথে-এর/.test(bn))).toEqual([]);
  });
});
