import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { conversationBodySearchCondition, tokenizeConversationSearch } from "./search";

describe("conversation search terms", () => {
  it("normalizes canonical Unicode and preserves Bangla combining marks", () => {
    expect(tokenizeConversationSearch("CAFÉ cafe\u0301 বাংলা বাংলাদেশ ১২৩"))
      .toEqual(["café", "বাংলা", "বাংলাদেশ", "১২৩"]);
  });

  it("splits punctuation, deduplicates and ignores single-character words", () => {
    expect(tokenizeConversationSearch("Red/red—BLUE! a 1 red"))
      .toEqual(["red", "blue"]);
  });

  it("limits word length by Unicode code points, without splitting surrogate pairs", () => {
    const word = "𐐀".repeat(40);
    expect(tokenizeConversationSearch(word)).toEqual([word.toLowerCase().slice(0, 64)]);
    expect(Array.from(tokenizeConversationSearch(word)[0]!)).toHaveLength(32);
  });

  it("indexes words after the first 128 distinct words", () => {
    const words = Array.from({ length: 220 }, (_, index) => `word${index}`);
    expect(tokenizeConversationSearch(words.join(" "))).toEqual(words);
  });

  it("rejects overlong or overbroad queries instead of dropping terms", () => {
    expect(() => conversationBodySearchCondition(sql`conversation_id`, "x".repeat(101)))
      .toThrow("100 characters");
    expect(() => conversationBodySearchCondition(sql`conversation_id`, "aa bb cc dd ee ff gg hh ii"))
      .toThrow("8 words");
  });
});
