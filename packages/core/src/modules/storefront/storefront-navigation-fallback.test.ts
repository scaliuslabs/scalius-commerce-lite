import { describe, expect, it } from "vitest";

import { readStorefrontNavigationConfigs } from "./storefront.service";

describe("storefront persisted navigation fallback", () => {
  it("keeps a valid footer when the header document is malformed", () => {
    const result = readStorefrontNavigationConfigs(
      "{not-json",
      JSON.stringify({
        tagline: "Demo store",
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
      }),
    );

    expect(result.headerConfig).toEqual({});
    expect(result.footerConfig).toMatchObject({
      tagline: "Demo store",
      menus: [{
        id: "help",
        links: [{ target: { type: "internal_path", path: "/returns" } }],
      }],
    });
  });

  it("keeps a valid header when the footer document is malformed", () => {
    const result = readStorefrontNavigationConfigs(
      JSON.stringify({
        navigation: [{
          id: "home",
          target: { type: "internal_path", path: "/" },
          labelMode: "custom",
          customLabel: "Home",
        }],
      }),
      JSON.stringify({ menus: [{ id: "broken" }] }),
    );

    expect(result.headerConfig).toMatchObject({
      navigation: [{ target: { type: "internal_path", path: "/" } }],
    });
    expect(result.footerConfig).toEqual({});
  });

  it("normalizes legacy demo links in memory for the public layout", () => {
    const result = readStorefrontNavigationConfigs(
      JSON.stringify({
        navigation: [{
          id: "catalog",
          title: "Catalog",
          href: "/products",
          subMenu: [{ id: "contact", title: "Contact", href: "/contact" }],
        }],
      }),
      JSON.stringify({ menus: [] }),
    );

    expect(result.headerConfig).toMatchObject({
      navigation: [{
        id: "catalog",
        target: { type: "internal_path", path: "/products" },
        labelMode: "custom",
        customLabel: "Catalog",
        subMenu: [{
          id: "contact",
          target: { type: "internal_path", path: "/contact" },
          customLabel: "Contact",
        }],
      }],
    });
  });
});
