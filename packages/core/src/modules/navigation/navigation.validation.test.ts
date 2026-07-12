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

  it("rejects navigation trees that are too deep or reuse item IDs", () => {
    expect(() => parseNavigationConfig("header", {
      navigation: [{
        id: "one",
        title: "One",
        subMenu: [{
          id: "two",
          title: "Two",
          subMenu: [{
            id: "three",
            title: "Three",
            subMenu: [{ id: "four", title: "Four" }],
          }],
        }],
      }],
    })).toThrow("at most 3 levels");

    expect(() => parseNavigationConfig("footer", {
      menus: [{
        id: "support",
        title: "Support",
        links: [
          { id: "same", title: "Contact", href: "/contact" },
          { id: "same", title: "Returns", href: "/returns" },
        ],
      }],
    })).toThrow("item IDs must be unique");
  });

  it("keeps social destinations HTTPS-only and bounded", () => {
    expect(parseNavigationConfig("header", {
      social: [{
        id: "facebook",
        label: "Facebook",
        url: "https://facebook.com/scalius",
      }],
    })).toMatchObject({
      social: [{ url: "https://facebook.com/scalius" }],
    });

    expect(() => parseNavigationConfig("header", {
      social: [{
        id: "unsafe",
        label: "Unsafe",
        url: "javascript:alert(1)",
      }],
    })).toThrow("credential-free HTTPS URL");

    expect(() => parseNavigationConfig("footer", {
      social: Array.from({ length: 9 }, (_, index) => ({
        id: `social-${index}`,
        label: `Social ${index}`,
        url: `https://example.com/${index}`,
      })),
    })).toThrow(ValidationError);
  });

  it("rejects blank labels and duplicate footer menu IDs", () => {
    expect(() => parseNavigationConfig("header", {
      navigation: [{ id: "blank", title: "  " }],
    })).toThrow(ValidationError);

    expect(() => parseNavigationConfig("footer", {
      menus: [
        { id: "links", title: "Shop", links: [] },
        { id: "links", title: "Help", links: [] },
      ],
    })).toThrow("menu IDs must be unique");
  });
});
