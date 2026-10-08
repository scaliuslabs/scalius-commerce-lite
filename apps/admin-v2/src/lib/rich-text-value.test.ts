import { describe, expect, it } from "vitest";
import { isEmptyRichText, richTextOrEmpty, richTextOrNull } from "./rich-text-value";

describe("empty rich text", () => {
  it("is one value: nothing, an empty paragraph, two of them, a line break", () => {
    for (const empty of [null, undefined, "", "<p></p>", "<p></p><p></p>", "<p><br></p>", "<p> </p>"]) {
      expect(isEmptyRichText(empty)).toBe(true);
      expect(richTextOrEmpty(empty)).toBe("");
      expect(richTextOrNull(empty)).toBeNull();
    }
  });

  it("keeps text and media as written", () => {
    for (const filled of ["<p>Soft cotton</p>", "<p><img src=\"https://example.com/a.jpg\"></p>", "<p></p><p>x</p>"]) {
      expect(isEmptyRichText(filled)).toBe(false);
      expect(richTextOrEmpty(filled)).toBe(filled);
      expect(richTextOrNull(filled)).toBe(filled);
    }
  });
});
