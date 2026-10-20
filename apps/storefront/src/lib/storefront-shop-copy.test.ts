// @vitest-environment node
import { describe, expect, it } from "vitest";
import { shopCopy } from "./storefront-shop-copy";

/** The same shape, leaf by leaf, with every word filled in (functions answer a word, never nothing). */
function shape(value: unknown, name = "copy"): string[] {
  if (typeof value === "function") {
    const answer = (value as (...args: unknown[]) => unknown)("Women");
    return typeof answer === "string" && answer.trim() ? [`${name}()`] : [`${name}() EMPTY`];
  }
  if (typeof value === "string") return value.trim() ? [name] : [`${name} EMPTY`];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => shape(child, `${name}.${key}`));
}

describe("the listing, product page and cart words", () => {
  it("has every key in English and Bangla, none empty", () => {
    const english = shape(shopCopy("en"));
    expect(english.some((entry) => entry.endsWith("EMPTY"))).toBe(false);
    expect(shape(shopCopy("bn"))).toEqual(english);
  });

  it("speaks Bangla for a Bangla store, English otherwise", () => {
    expect(shopCopy("bn").cart.popularNow).not.toBe(shopCopy("en").cart.popularNow);
    expect(shopCopy("bn-BD").description.readMore).toBe(shopCopy("bn").description.readMore);
    expect(shopCopy(undefined).description.about("Women")).toBe("about Women");
    expect(shopCopy("fr").product.zoomPhoto).toBe("Zoom photo");
    expect(shopCopy("bn").product.contact.call).not.toBe(shopCopy("en").product.contact.call);
    expect(shopCopy("en").product.contact.callNumber("01711-000000")).toBe("Call 01711-000000");
  });
});
