import { describe, expect, it } from "vitest";

import {
  canTransitionReviewStatus,
  checkReviewContent,
  defaultReviewerDisplayName,
  isReviewRating,
  isReviewRejectionReason,
  isReviewableFulfillmentType,
  normalizeReviewBlockWords,
  normalizeReviewText,
  ratingAverageCenti,
  ratingFacetMinCenti,
  REVIEW_FALLBACK_DISPLAY_NAME,
  REVIEW_LIMITS,
  REVIEW_REJECTION_REASONS,
  reviewRankMilli,
  reviewStatusAfterCheck,
} from "./reviews";

describe("review vocabulary", () => {
  it("accepts integer ratings 1–5 only", () => {
    expect([1, 2, 3, 4, 5].every(isReviewRating)).toBe(true);
    for (const value of [0, 6, 4.5, "5", null, Number.NaN]) expect(isReviewRating(value)).toBe(false);
  });

  it("has content reasons only: low rating is never a rejection reason", () => {
    expect(REVIEW_REJECTION_REASONS).toEqual(["spam", "abusive", "personal_info", "off_topic", "not_about_product"]);
    expect(isReviewRejectionReason("low_rating")).toBe(false);
  });

  it("never lets a buyer review a gift-card line", () => {
    expect(isReviewableFulfillmentType("gift_card")).toBe(false);
    for (const type of ["ship", "pickup", "digital", "service"] as const) expect(isReviewableFulfillmentType(type)).toBe(true);
  });

  it("follows the §2.1 status machine", () => {
    expect(canTransitionReviewStatus("pending", "published", "staff")).toBe(true);
    expect(canTransitionReviewStatus("pending", "published", "system")).toBe(true);
    expect(canTransitionReviewStatus("pending", "rejected", "staff")).toBe(true);
    expect(canTransitionReviewStatus("published", "withdrawn", "buyer")).toBe(true);
    expect(canTransitionReviewStatus("pending", "withdrawn", "buyer")).toBe(true);
    expect(canTransitionReviewStatus("published", "rejected", "staff")).toBe(true);
    expect(canTransitionReviewStatus("rejected", "published", "staff")).toBe(true);
    expect(canTransitionReviewStatus("published", "pending", "system")).toBe(true);
    // Staff cannot withdraw for the buyer; buyers cannot publish or reject; withdrawn is terminal.
    expect(canTransitionReviewStatus("published", "withdrawn", "staff")).toBe(false);
    expect(canTransitionReviewStatus("pending", "published", "buyer")).toBe(false);
    expect(canTransitionReviewStatus("rejected", "published", "buyer")).toBe(false);
    expect(canTransitionReviewStatus("withdrawn", "published", "staff")).toBe(false);
  });
});

describe("normalizeReviewText", () => {
  it("normalizes to NFC, converts CRLF, trims", () => {
    expect(normalizeReviewText(`  Cafe${String.fromCharCode(0x301)}\r\nGreat\r fit  `, "body")).toEqual({ ok: true, value: "Café\nGreat\n fit" });
  });

  it("treats absent and blank as null (every field is optional)", () => {
    expect(normalizeReviewText(undefined, "title")).toEqual({ ok: true, value: null });
    expect(normalizeReviewText(null, "body")).toEqual({ ok: true, value: null });
    expect(normalizeReviewText(" \n\t ", "body")).toEqual({ ok: true, value: null });
    expect(normalizeReviewText(5, "body")).toEqual({ ok: false, reason: "not_text" });
  });

  it("rejects control characters but keeps newline, tab and Bangla joiners", () => {
    expect(normalizeReviewText("a\u0000b", "body")).toEqual({ ok: false, reason: "invalid_characters" });
    expect(normalizeReviewText("a\u0085b", "body")).toEqual({ ok: false, reason: "invalid_characters" });
    expect(normalizeReviewText("a\u007fb", "body")).toEqual({ ok: false, reason: "invalid_characters" });
    expect(normalizeReviewText("a\uD800b", "body")).toEqual({ ok: false, reason: "invalid_characters" });
    expect(normalizeReviewText("a\tb\nc", "body")).toEqual({ ok: true, value: "a\tb\nc" });
    const joined = `র${String.fromCharCode(0x200d)}্যাব`;
    expect(normalizeReviewText(joined, "body")).toEqual({ ok: true, value: joined });
  });

  it("keeps titles and display names on one line", () => {
    expect(normalizeReviewText("Good\nproduct", "title")).toEqual({ ok: false, reason: "invalid_characters" });
    expect(normalizeReviewText("Rahim\nK.", "displayName")).toEqual({ ok: false, reason: "invalid_characters" });
    expect(normalizeReviewText("Line one\nline two", "reply")).toEqual({ ok: true, value: "Line one\nline two" });
  });

  it("counts code points against each limit", () => {
    expect(normalizeReviewText("x".repeat(REVIEW_LIMITS.titleLength), "title").ok).toBe(true);
    expect(normalizeReviewText("x".repeat(REVIEW_LIMITS.titleLength + 1), "title")).toEqual({ ok: false, reason: "too_long" });
    expect(normalizeReviewText("😀".repeat(REVIEW_LIMITS.titleLength), "title").ok).toBe(true);
    expect(normalizeReviewText("x".repeat(5_001), "body")).toEqual({ ok: false, reason: "too_long" });
    expect(normalizeReviewText("x".repeat(61), "displayName")).toEqual({ ok: false, reason: "too_long" });
    expect(normalizeReviewText("x".repeat(2_001), "reply")).toEqual({ ok: false, reason: "too_long" });
  });
});

describe("defaultReviewerDisplayName", () => {
  it("is First L.", () => {
    expect(defaultReviewerDisplayName("Abdur Rob Badhon")).toBe("Abdur B.");
    expect(defaultReviewerDisplayName("  rahima   khatun ")).toBe("rahima K.");
    expect(defaultReviewerDisplayName("Madonna")).toBe("Madonna");
  });

  it("keeps a Bangla initial whole (grapheme, not code unit)", () => {
    expect(defaultReviewerDisplayName("আব্দুর রহিম")).toBe("আব্দুর র.");
    expect(defaultReviewerDisplayName("সুমি খাতুন")).toBe("সুমি খা.");
  });

  it("skips punctuation and falls back when no name is left", () => {
    expect(defaultReviewerDisplayName("Karim (Dhaka)")).toBe("Karim D.");
    expect(defaultReviewerDisplayName("Karim -")).toBe("Karim");
    expect(defaultReviewerDisplayName("")).toBe(REVIEW_FALLBACK_DISPLAY_NAME);
    expect(defaultReviewerDisplayName(null)).toBe(REVIEW_FALLBACK_DISPLAY_NAME);
    expect(defaultReviewerDisplayName("  ...  ")).toBe(REVIEW_FALLBACK_DISPLAY_NAME);
  });

  it("never exceeds the display-name limit", () => {
    const name = defaultReviewerDisplayName(`${"A".repeat(100)} Zaman`);
    expect(Array.from(name).length).toBe(REVIEW_LIMITS.displayNameLength);
    expect(name.endsWith(" Z.")).toBe(true);
    expect(normalizeReviewText(name, "displayName").ok).toBe(true);
  });
});

describe("checkReviewContent", () => {
  const flagsOf = (body: string, blockWords?: readonly string[]) => checkReviewContent({ body }, { blockWords }).flags;

  it("passes an ordinary review", () => {
    expect(checkReviewContent({ title: "Great fit", body: "Fabric is soft. Size M fits 5'8\" well. 4.5 stars e.g. for price." }))
      .toEqual({ hold: false, flags: [] });
    expect(checkReviewContent({ body: "খুব ভালো পণ্য, দাম অনুযায়ী মান ভালো।" })).toEqual({ hold: false, flags: [] });
    expect(checkReviewContent({})).toEqual({ hold: false, flags: [] });
  });

  it("holds links", () => {
    for (const body of [
      "see https://example.org/x",
      "http://a.b",
      "go to www.shop-deals.net now",
      "order at cheap.com.bd",
      "bit.ly/abc",
      "message wa.me/8801712345678",
      "visit MyStore.SHOP",
    ]) expect(flagsOf(body), body).toContain("url");
    for (const body of ["It is 4.5 out of 5", "e.g. the collar", "Mr.Rahim delivered", "size 2.0.1"]) {
      expect(flagsOf(body), body).not.toContain("url");
    }
  });

  it("holds email addresses", () => {
    expect(flagsOf("mail me: rahim.k+shop@gmail.com")).toContain("email");
    expect(flagsOf("rahim at gmail")).toEqual([]);
  });

  it("holds Bangladesh mobile numbers in every common shape, Bangla digits too", () => {
    for (const body of [
      "call 01712345678",
      "call 01712-345678",
      "call 0171 234 5678",
      "call +8801712345678",
      "call +880 1712-345678",
      "call 8801712345678",
      "call +88 01712345678",
      "call (+880) 1712 345 678",
      "ফোন ০১৭১২৩৪৫৬৭৮",
      "ফোন +৮৮০ ১৭১২-৩৪৫৬৭৮",
    ]) expect(flagsOf(body), body).toEqual(["phone"]);
  });

  it("does not mistake other numbers for phones", () => {
    for (const body of [
      "order 1234567890123",
      "01212345678 is not a mobile prefix",
      "017123456789012 is too long",
      "paid 1500 taka for 2 pieces",
    ]) expect(flagsOf(body), body).not.toContain("phone");
  });

  it("holds a run of more than 20 identical non-space characters", () => {
    expect(flagsOf(`wow${"!".repeat(20)}`)).toEqual([]);
    expect(flagsOf(`wow${"!".repeat(21)}`)).toEqual(["repeated_characters"]);
    expect(flagsOf(`so goo${"o".repeat(30)}d`)).toEqual(["repeated_characters"]);
    expect(flagsOf(`a${" ".repeat(40)}b`)).toEqual([]);
    expect(flagsOf("ha".repeat(40))).toEqual([]);
  });

  it("holds merchant block words: case-insensitive, whole words, English and Bangla", () => {
    const blockWords = ["Scam", "fake product", "নকল"];
    expect(flagsOf("This is a SCAM.", blockWords)).toEqual(["block_word"]);
    expect(flagsOf("total fake   product", blockWords)).toEqual(["block_word"]);
    expect(flagsOf("এটা নকল জিনিস", blockWords)).toEqual(["block_word"]);
    expect(flagsOf("scampi was tasty", blockWords)).toEqual([]);
    expect(flagsOf("fake products", blockWords)).toEqual([]);
    expect(flagsOf("নকলি", blockWords)).toEqual([]);
    expect(flagsOf("regex chars a+b (c)", ["a+b", "(c)"])).toEqual(["block_word"]);
  });

  it("reports every reason in a fixed order and checks the title too", () => {
    const result = checkReviewContent(
      { title: "Scam!", body: `mail x@y.com or visit x.com, call 01812345678 ${"?".repeat(25)}` },
      { blockWords: ["scam"] },
    );
    expect(result).toEqual({ hold: true, flags: ["url", "email", "phone", "repeated_characters", "block_word"] });
  });

  it("is rating-blind by construction (R5): the check has no rating input", () => {
    const content = { title: "Honest", body: "Arrived late, call 01712345678" };
    const oneStar = { rating: 1, ...content };
    const fiveStar = { rating: 5, ...content };
    // A rating passed along is ignored: the outcome depends on the text alone.
    expect(checkReviewContent(oneStar)).toEqual(checkReviewContent(fiveStar));
    expect(checkReviewContent({ title: "Great", body: "Loved it" })).toEqual({ hold: false, flags: [] });
    // @ts-expect-error the check has no rating parameter.
    checkReviewContent({ title: "Honest", body: "Arrived late", rating: 1 });
    expect(checkReviewContent.length).toBeLessThanOrEqual(2);
    for (const mode of ["auto", "hold"] as const) {
      expect(reviewStatusAfterCheck(mode, checkReviewContent(oneStar))).toBe(reviewStatusAfterCheck(mode, checkReviewContent(fiveStar)));
    }
  });

  it("runs in linear time on hostile input", () => {
    const started = Date.now();
    checkReviewContent({ body: "a".repeat(5_000) });
    checkReviewContent({ body: "a.".repeat(2_500) });
    checkReviewContent({ body: "0 ".repeat(2_500) });
    checkReviewContent({ body: "a".repeat(5_000) }, { blockWords: Array.from({ length: 50 }, (_, index) => `w${index}`) });
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("reviewStatusAfterCheck", () => {
  it("publishes only in auto mode with a clean check", () => {
    expect(reviewStatusAfterCheck("auto", { hold: false, flags: [] })).toBe("published");
    expect(reviewStatusAfterCheck("auto", { hold: true, flags: ["url"] })).toBe("pending");
    expect(reviewStatusAfterCheck("hold", { hold: false, flags: [] })).toBe("pending");
  });
});

describe("normalizeReviewBlockWords", () => {
  it("cleans, lowercases, dedupes and caps the list", () => {
    expect(normalizeReviewBlockWords(["  Scam ", "scam", "", "fake\t product", 5, "x".repeat(41), `bad${String.fromCharCode(1)}word`, "ok"]))
      .toEqual(["scam", "fake product", "ok"]);
    const many = Array.from({ length: 80 }, (_, index) => `word${index}`);
    expect(normalizeReviewBlockWords(many)).toHaveLength(REVIEW_LIMITS.blockWords);
  });
});

describe("review aggregates match the stats trigger", () => {
  it("computes the Bayesian rank with integer truncation, null at zero", () => {
    expect(reviewRankMilli(0, 0)).toBeNull();
    expect(reviewRankMilli(5, 1)).toBe(3333);
    expect(reviewRankMilli(1, 1)).toBe(2666);
    expect(reviewRankMilli(1440, 300)).toBe(4770);
    // One 5★ never outranks 300 reviews averaging 4.8★.
    expect(reviewRankMilli(5, 1)!).toBeLessThan(reviewRankMilli(1440, 300)!);
  });

  it("computes the average in centi-stars, truncated, null at zero", () => {
    expect(ratingAverageCenti(0, 0)).toBeNull();
    expect(ratingAverageCenti(14, 3)).toBe(466);
    expect(ratingAverageCenti(9, 2)).toBe(450);
    expect(ratingAverageCenti(5, 1)).toBe(500);
    expect(ratingAverageCenti(399, 100)).toBe(399);
  });

  it("maps the N★ & up facet onto rating_avg_centi", () => {
    expect(ratingFacetMinCenti(4)).toBe(400);
    expect(ratingAverageCenti(399, 100)! >= ratingFacetMinCenti(4)).toBe(false);
  });

  it("equals SQLite integer division for every small (sum, count)", async () => {
    const sqlite = await openSqlite();
    // The stats columns are INTEGER; node:sqlite binds JS numbers as REAL, so cast like the column affinity does.
    const statement = sqlite.prepare(
      `SELECT (s + 15) * 1000 / (c + 5) AS rank, s * 100 / NULLIF(c, 0) AS avg
         FROM (SELECT CAST(? AS INTEGER) AS s, CAST(? AS INTEGER) AS c)`,
    );
    for (let count = 1; count <= 60; count += 1) {
      for (let sum = count; sum <= count * 5; sum += 1) {
        const row = statement.get(sum, count) as { rank: number; avg: number };
        expect(reviewRankMilli(sum, count)).toBe(row.rank);
        expect(ratingAverageCenti(sum, count)).toBe(row.avg);
      }
    }
    sqlite.close();
  });

  it("rejects negative or fractional aggregates", () => {
    expect(() => reviewRankMilli(-1, 0)).toThrow(RangeError);
    expect(() => ratingAverageCenti(1.5, 1)).toThrow(RangeError);
  });
});

interface SqliteDatabase {
  prepare(sql: string): { get(...values: unknown[]): unknown };
  close(): void;
}

/** Node 24's built-in SQLite, loaded by a runtime specifier so the Workers typecheck needs no Node types. */
async function openSqlite(): Promise<SqliteDatabase> {
  const specifier = "node:sqlite";
  const module = (await import(/* @vite-ignore */ specifier)) as { DatabaseSync: new (path: string) => SqliteDatabase };
  return new module.DatabaseSync(":memory:");
}
