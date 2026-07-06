// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SEO_DISCOVERY_SETTINGS } from "@scalius/shared/seo-discovery";

import { SeoDiscoveryStatusCard } from "./SeoDiscoveryStatusCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const storefrontUrlState = vi.hoisted(() => ({
  storefrontUrl: "https://shop.example.com" as string | null,
  isLoading: false,
  error: null as Error | null,
}));

vi.mock("../../hooks/use-storefront-url", () => ({
  useStorefrontUrl: () => storefrontUrlState,
}));

describe("SeoDiscoveryStatusCard", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    storefrontUrlState.storefrontUrl = "https://shop.example.com";
    storefrontUrlState.isLoading = false;
    storefrontUrlState.error = null;
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
  });

  function renderCard(robotsTxt = "User-agent: *\nAllow: /") {
    act(() => {
      root.render(
        <SeoDiscoveryStatusCard
          discovery={DEFAULT_SEO_DISCOVERY_SETTINGS}
          robotsTxt={robotsTxt}
        />,
      );
    });
  }

  it("renders dashboard preview links only for an absolute Store URL", () => {
    renderCard();

    const links = Array.from(host.querySelectorAll("a")).map((link) =>
      link.getAttribute("href"),
    );

    expect(host.textContent).toContain("Discovery Status / QA");
    expect(host.textContent).toContain(
      "This is a dashboard preview, not a live probe of the storefront Worker env.",
    );
    expect(links).toEqual([
      "https://shop.example.com/robots.txt",
      "https://shop.example.com/sitemap.xml",
      "https://shop.example.com/api/facebook-feed.xml",
    ]);
  });

  it("does not render broken external links for relative Store URLs", () => {
    storefrontUrlState.storefrontUrl = "/local-store";

    renderCard();

    expect(host.querySelector("a")).toBeNull();
    expect(host.textContent).toContain("Path-only preview");
    expect(host.textContent).toContain("/sitemap.xml");
  });

  it("surfaces custom robots sitemap line warnings", () => {
    renderCard(
      "User-agent: *\nAllow: /\nSitemap: https://old.example.com/sitemap.xml",
    );

    expect(host.textContent).toContain(
      "Custom Sitemap lines are preserved; confirm they point to the right storefront.",
    );
  });

  it("keeps editing available when Store URL preview fails to load", () => {
    storefrontUrlState.storefrontUrl = null;
    storefrontUrlState.error = new Error("Failed to load");

    renderCard();

    expect(host.querySelector("a")).toBeNull();
    expect(host.textContent).toContain(
      "Store URL preview failed to load; editing remains available.",
    );
  });
});
