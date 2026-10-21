// @vitest-environment node
import { describe, expect, it } from "vitest";
import { storefrontCopy, storefrontLanguage, type StorefrontLanguage } from "./storefront-copy";

const LANGUAGES: StorefrontLanguage[] = ["en", "bn"];
const BENGALI = /[ঀ-৿]/;

/** Every leaf path of the catalogue ("price.sale", "stock.low"), with its value. */
function leaves(value: unknown, path = ""): Array<[string, unknown]> {
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) => leaves(child, path ? `${path}.${key}` : key));
  }
  return [[path, value]];
}

/** Sample arguments for the catalogue's functions (a count, an amount, a list of names). */
function call(fn: (...args: never[]) => unknown, path: string): unknown {
  if (path === "rating.summary") return (fn as (average: string, count: string, reviews: number) => unknown)("4.6", "128", 128);
  if (path === "stock.low") return (fn as (count: string) => unknown)("3");
  if (path === "card.moreColours") return (fn as (count: string, colours: number) => unknown)("3", 3);
  return (fn as (text: string) => unknown)("৳600");
}

describe("storefront copy", () => {
  it("has the same keys, at every depth, in both languages", () => {
    const keys = (language: StorefrontLanguage) => leaves(storefrontCopy(language)).map(([path]) => path).sort();
    expect(keys("bn")).toEqual(keys("en"));
    expect(keys("en").length).toBeGreaterThan(20);
    // The same kind of value too: a function in one language is a function in the other.
    const kinds = (language: StorefrontLanguage) => leaves(storefrontCopy(language)).map(([path, value]) => `${path}:${typeof value}`).sort();
    expect(kinds("bn")).toEqual(kinds("en"));
  });

  it.each(LANGUAGES)("%s: every string and every function returns non-empty text", (language) => {
    for (const [path, value] of leaves(storefrontCopy(language))) {
      if (typeof value === "function") {
        const result = call(value as never, path);
        expect(typeof result, path).toBe("string");
        expect((result as string).trim().length, path).toBeGreaterThan(0);
      } else {
        expect(typeof value, path).toBe("string");
        expect((value as string).trim().length, path).toBeGreaterThan(0);
      }
    }
  });

  it("puts what the function was given into the sentence", () => {
    const en = storefrontCopy("en");
    expect(en.price.from("৳2,450")).toContain("৳2,450");
    expect(en.price.save("৳600")).toContain("৳600");
    expect(en.stock.low("3")).toContain("3");
    expect(en.card.deliveryFrom("৳60")).toContain("৳60");
    expect(en.card.colours("Navy")).toContain("Navy");
    expect(en.rating.summary("4.6", "128", 128)).toContain("4.6");
    expect(en.rating.summary("4.6", "128", 128)).toContain("128");
    const bn = storefrontCopy("bn");
    expect(bn.price.from("৳2,450")).toContain("৳2,450");
    expect(bn.price.save("৳600")).toContain("৳600");
    expect(bn.stock.low("৩")).toContain("৩");
    expect(bn.card.deliveryFrom("৳60")).toContain("৳60");
    expect(bn.card.colours("Navy")).toContain("Navy");
    expect(bn.rating.summary("4.6", "128", 128)).toContain("4.6");
    expect(bn.rating.summary("4.6", "128", 128)).toContain("128");
  });

  it("uses the singular for one review and one more colour in English", () => {
    const en = storefrontCopy("en");
    expect(en.rating.summary("5.0", "1", 1)).toBe("Rated 5.0 out of 5 from 1 review");
    expect(en.rating.summary("4.0", "2", 2)).toBe("Rated 4.0 out of 5 from 2 reviews");
    expect(en.card.moreColours("1", 1)).toBe("1 more colour");
    expect(en.card.moreColours("2", 2)).toBe("2 more colours");
  });

  it("writes Bangla in Bengali script", () => {
    for (const [path, value] of leaves(storefrontCopy("bn"))) {
      const text = typeof value === "function" ? (call(value as never, path) as string) : (value as string);
      expect(text, path).toMatch(BENGALI);
    }
  });

  it("keeps the English catalogue in Latin script", () => {
    for (const [path, value] of leaves(storefrontCopy("en"))) {
      const text = typeof value === "function" ? (call(value as never, path) as string).replace("৳600", "") : (value as string);
      expect(text, path).not.toMatch(BENGALI);
    }
  });

  describe("storefrontLanguage", () => {
    it("is Bangla for bn codes, in any case or region", () => {
      for (const code of ["bn", "bn-BD", "bn-IN", "BN", "bn_BD"]) expect(storefrontLanguage(code), code).toBe("bn");
    });

    it("is English for everything else", () => {
      for (const code of ["en", "en-US", "fr", "hi", "", "  ", undefined, null, 42, {}]) {
        expect(storefrontLanguage(code), String(code)).toBe("en");
      }
    });
  });
});
