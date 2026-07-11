import { describe, expect, it } from "vitest";
import { parseShortcodes } from "./shortcodes";

describe("parseShortcodes", () => {
  it("parses supported product forms and ignores unsupported tags", () => {
    expect(
      parseShortcodes(
        [
          '[product slug="fish"]',
          "[product id='rice']",
          '[banner id="old_1"]',
        ].join(" "),
      ),
    ).toMatchObject([
      { type: "product", id: "fish" },
      { type: "product", id: "rice" },
    ]);
  });

  it("normalizes sanitized CMS quote entities", () => {
    expect(
      parseShortcodes(
        [
          "[product slug=&quot;monster-energy-drink&quot;]",
          "[product slug=&apos;rice&apos;]",
        ].join(" "),
      ).map((shortcode) => shortcode.id),
    ).toEqual(["monster-energy-drink", "rice"]);
  });

  it("preserves current id precedence and case-sensitive tag behavior", () => {
    expect(parseShortcodes('[product id="canonical" slug="ignored"]')).toEqual([
      {
        fullMatch: '[product id="canonical" slug="ignored"]',
        type: "product",
        id: "canonical",
        attributes: { id: "canonical", slug: "ignored" },
      },
    ]);
    expect(parseShortcodes('[Product slug="fish"]')).toEqual([]);
  });
});
