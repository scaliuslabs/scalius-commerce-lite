import { describe, expect, it } from "vitest";

import { parseNavigationHref } from "./navigation-href";

describe("navigation href policy", () => {
  it.each([
    ["/", "/"],
    ["returns", "/returns"],
    ["/categories/shoes?color=Blue", "/categories/shoes?color=Blue"],
    ["#details", "#details"],
    ["?sort=newest", "?sort=newest"],
    ["/pages/returns", "/returns"],
    ["/pages/returns?source=footer", "/returns?source=footer"],
    ["https://example.com/help", "https://example.com/help"],
  ])("normalizes safe target %s", (input, expected) => {
    expect(parseNavigationHref(input)).toMatchObject({ ok: true, href: expected });
  });

  it.each([undefined, null, "", "  ", "#"])(
    "treats %j as a non-clickable label",
    (input) => {
      expect(parseNavigationHref(input)).toEqual({ ok: true, kind: "label" });
    },
  );

  it.each([
    "javascript:alert(1)",
    "data:text/html,boom",
    "vbscript:msgbox(1)",
    "http://example.com",
    "//example.com/path",
    "https://user:secret@example.com",
    "../checkout",
    "/safe path",
    "/safe\\path",
  ])("rejects unsafe target %s", (input) => {
    expect(parseNavigationHref(input)).toMatchObject({ ok: false });
  });
});
