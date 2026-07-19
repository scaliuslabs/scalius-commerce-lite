import { describe, expect, it } from "vitest";

import { readStorefrontPresentationConfigs } from "./storefront.service";

describe("storefront presentation isolation", () => {
  it("keeps header and footer presentation while ignoring embedded navigation", () => {
    const result = readStorefrontPresentationConfigs(
      JSON.stringify({
        logo: { src: "/logo.svg", alt: "Store" },
        navigation: [{ id: "broken", href: 42 }],
      }),
      JSON.stringify({
        tagline: "Made nearby",
        menus: [{ id: "broken" }],
      }),
    );

    expect(result.headerConfig).toEqual({
      logo: { src: "/logo.svg", alt: "Store" },
    });
    expect(result.footerConfig).toEqual({ tagline: "Made nearby" });
  });

  it("isolates malformed presentation documents", () => {
    const result = readStorefrontPresentationConfigs(
      "{not-json",
      JSON.stringify({ copyrightText: "All rights reserved" }),
    );

    expect(result.headerConfig).toEqual({});
    expect(result.footerConfig).toEqual({
      copyrightText: "All rights reserved",
    });
  });
});
