import { describe, expect, it } from "vitest";
import { parseShortcodes } from "./shortcodes";

describe("parseShortcodes", () => {
  it("parses supported product and widget forms", () => {
    expect(
      parseShortcodes(
        [
          '[product slug="fish"]',
          "[product id='rice']",
          '[widget id="wid_1"]',
          "[widget slug='wid_2']",
        ].join(" "),
      ),
    ).toMatchObject([
      { type: "product", id: "fish" },
      { type: "product", id: "rice" },
      { type: "widget", id: "wid_1" },
      { type: "widget", id: "wid_2" },
    ]);
  });

  it("normalizes sanitized CMS quote entities", () => {
    expect(
      parseShortcodes(
        [
          "[product slug=&quot;monster-energy-drink&quot;]",
          "[widget id=&#34;wid_1&#34;]",
          "[product slug=&apos;rice&apos;]",
          "[widget id=&#x27;wid_2&#x27;]",
        ].join(" "),
      ).map((shortcode) => shortcode.id),
    ).toEqual(["monster-energy-drink", "wid_1", "rice", "wid_2"]);
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
