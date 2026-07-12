import { describe, expect, it } from "vitest";

import { ValidationError } from "@scalius/core/errors";
import { parseNavigationConfig } from "./navigation.validation";

describe("navigation configuration validation", () => {
  it("normalizes CMS page links to the actual root-level public route", () => {
    expect(parseNavigationConfig("header", {
      navigation: [{
        id: "returns",
        title: "Returns",
        href: "/pages/returns?from=header",
      }],
    })).toMatchObject({
      navigation: [{ href: "/returns?from=header" }],
    });
  });

  it("normalizes safe relative links and legacy label placeholders", () => {
    expect(parseNavigationConfig("footer", {
      menus: [{
        id: "support",
        title: "Support",
        links: [
          { id: "contact", title: "Contact", href: "contact" },
          { id: "topics", title: "Topics", href: "#" },
        ],
      }],
    })).toMatchObject({
      menus: [{
        links: [
          { href: "/contact" },
          { href: undefined },
        ],
      }],
    });
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,boom",
    "http://example.com",
    "//example.com",
    "https://user:secret@example.com",
  ])("rejects unsafe nested href %s", (href) => {
    expect(() => parseNavigationConfig("header", {
      navigation: [{ id: "unsafe", title: "Unsafe", href }],
    })).toThrow(ValidationError);
  });
});
