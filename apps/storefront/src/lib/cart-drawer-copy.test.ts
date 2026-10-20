// @vitest-environment node
import { describe, expect, it } from "vitest";
import { cartDrawerCopy } from "./cart-drawer-copy";

/** Every leaf, functions called with sample words, so both languages answer something for every key. */
function leaves(value: unknown, path = ""): Array<[string, string]> {
  if (typeof value === "function") return [[path, String((value as (...args: unknown[]) => unknown)("৳১", "২", "৩"))]];
  if (typeof value === "string") return [[path, value]];
  return Object.entries(value as object).flatMap(([key, child]) => leaves(child, path ? `${path}.${key}` : key));
}

describe("the cart drawer's words", () => {
  it("has every key in both languages, none empty, and no English word in Bangla", () => {
    const en = leaves(cartDrawerCopy("en"));
    const bn = leaves(cartDrawerCopy("bn"));
    expect(bn.map(([path]) => path)).toEqual(en.map(([path]) => path));
    expect([...en, ...bn].filter(([, text]) => !text.trim())).toEqual([]);
    expect(bn.filter(([, text]) => /[A-Za-z]{2,}/.test(text))).toEqual([]);
  });

  it("follows the page's language: Bangla for bn-BD, English otherwise", () => {
    expect(cartDrawerCopy("bn-BD").checkout).toBe("চেকআউট");
    expect(cartDrawerCopy("fr").checkout).toBe("Check out");
  });
});
