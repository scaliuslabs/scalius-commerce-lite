import { describe, expect, it } from "vitest";

import { ValidationError } from "@scalius/core/errors";
import {
  normalizeLegacyNavigationConfig,
  parseNavigationConfig,
  readPersistedNavigationConfig,
} from "./navigation.validation";

describe("navigation configuration validation", () => {
  it("accepts stable resource authority and canonicalizes query projections", () => {
    expect(parseNavigationConfig("header", {
      navigation: [{
        id: "returns",
        target: {
          type: "resource",
          resourceType: "page",
          resourceId: "page_returns",
          query: "from=header",
        },
        labelMode: "resource",
        lastKnownLabel: "Returns",
      }],
    })).toMatchObject({
      navigation: [{
        target: { resourceId: "page_returns", query: "?from=header" },
        labelMode: "resource",
      }],
    });
  });

  it("normalizes safe custom links and represents labels explicitly", () => {
    expect(parseNavigationConfig("footer", {
      menus: [{
        id: "support",
        title: "Support",
        links: [
          {
            id: "contact",
            target: { type: "internal_path", path: "contact" },
            labelMode: "custom",
            customLabel: "Contact",
          },
          {
            id: "topics",
            target: { type: "label" },
            labelMode: "custom",
            customLabel: "Topics",
          },
        ],
      }],
    })).toMatchObject({
      menus: [{
        links: [
          { target: { type: "internal_path", path: "/contact" } },
          { target: { type: "label" } },
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
  ])("rejects unsafe nested target %s", (href) => {
    expect(() => parseNavigationConfig("header", {
      navigation: [{
        id: "unsafe",
        target: { type: "external_url", url: href },
        labelMode: "custom",
        customLabel: "Unsafe",
      }],
    })).toThrow(ValidationError);
  });

  it("rejects the copied href/title authority even beside a typed target", () => {
    expect(() => parseNavigationConfig("header", {
      navigation: [{
        id: "dual-authority",
        title: "Copied title",
        href: "/copied-path",
        target: { type: "internal_path", path: "/current-path" },
        labelMode: "custom",
        customLabel: "Current label",
      }],
    })).toThrow(ValidationError);
  });

  it("rejects navigation trees that are too deep or reuse item IDs", () => {
    expect(() => parseNavigationConfig("header", {
      navigation: [{
        id: "one",
        target: { type: "label" },
        labelMode: "custom",
        customLabel: "One",
        subMenu: [{
          id: "two",
          target: { type: "label" },
          labelMode: "custom",
          customLabel: "Two",
          subMenu: [{
            id: "three",
            target: { type: "label" },
            labelMode: "custom",
            customLabel: "Three",
            subMenu: [{
              id: "four",
              target: { type: "label" },
              labelMode: "custom",
              customLabel: "Four",
            }],
          }],
        }],
      }],
    })).toThrow("at most 3 levels");

    expect(() => parseNavigationConfig("footer", {
      menus: [{
        id: "support",
        title: "Support",
        links: [
          {
            id: "same",
            target: { type: "internal_path", path: "/contact" },
            labelMode: "custom",
            customLabel: "Contact",
          },
          {
            id: "same",
            target: { type: "internal_path", path: "/returns" },
            labelMode: "custom",
            customLabel: "Returns",
          },
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
      navigation: [{
        id: "blank",
        target: { type: "label" },
        labelMode: "custom",
        customLabel: "  ",
      }],
    })).toThrow(ValidationError);

    expect(() => parseNavigationConfig("footer", {
      menus: [
        { id: "links", title: "Shop", links: [] },
        { id: "links", title: "Help", links: [] },
      ],
    })).toThrow("menu IDs must be unique");
  });

  it("requires custom labels outside resource mode", () => {
    expect(() => parseNavigationConfig("header", {
      navigation: [{
        id: "bad-label-mode",
        target: { type: "internal_path", path: "/contact" },
        labelMode: "resource",
      }],
    })).toThrow("Only resource targets");
  });

  it("strictly normalizes the former demo item shape to one typed authority", () => {
    expect(normalizeLegacyNavigationConfig("header", {
      topBar: { text: "Demo", isEnabled: true },
      navigation: [{
        id: "shop",
        title: "Shop",
        href: "/products",
        subMenu: [
          { id: "support", title: "Support", href: "#" },
          {
            id: "external",
            title: "Journal",
            href: "https://example.com/journal",
          },
        ],
      }],
    })).toMatchObject({
      topBar: { text: "Demo", isEnabled: true },
      navigation: [{
        id: "shop",
        target: { type: "internal_path", path: "/products" },
        labelMode: "custom",
        customLabel: "Shop",
        subMenu: [
          {
            id: "support",
            target: { type: "label" },
            customLabel: "Support",
          },
          {
            id: "external",
            target: { type: "external_url", url: "https://example.com/journal" },
            customLabel: "Journal",
          },
        ],
      }],
    });
  });

  it("normalizes legacy footer links while preserving the menu presentation", () => {
    expect(normalizeLegacyNavigationConfig("footer", {
      tagline: "Made locally",
      menus: [{
        id: "help",
        title: "Help",
        links: [{ id: "returns", title: "Returns", href: "/returns" }],
      }],
    })).toMatchObject({
      tagline: "Made locally",
      menus: [{
        id: "help",
        title: "Help",
        links: [{
          id: "returns",
          target: { type: "internal_path", path: "/returns" },
          labelMode: "custom",
          customLabel: "Returns",
        }],
      }],
    });
  });

  it("never normalizes mixed or unsafe legacy authority", () => {
    expect(() => normalizeLegacyNavigationConfig("header", {
      navigation: [{
        id: "mixed",
        title: "Copied title",
        href: "/copied",
        target: { type: "internal_path", path: "/typed" },
        labelMode: "custom",
        customLabel: "Typed label",
      }],
    })).toThrow("not safe to normalize");

    expect(() => normalizeLegacyNavigationConfig("header", {
      navigation: [{
        id: "unsafe",
        title: "Unsafe",
        href: "javascript:alert(1)",
      }],
    })).toThrow(ValidationError);
  });

  it("isolates malformed persisted sections and marks in-memory legacy cutover", () => {
    expect(readPersistedNavigationConfig("header", "{not-json"))
      .toMatchObject({ state: "invalid", config: {} });

    expect(readPersistedNavigationConfig("header", JSON.stringify({
      navigation: [{ id: "home", title: "Home", href: "/" }],
    }))).toMatchObject({
      state: "legacy_normalized",
      config: {
        navigation: [{
          id: "home",
          target: { type: "internal_path", path: "/" },
        }],
      },
    });
  });
});
