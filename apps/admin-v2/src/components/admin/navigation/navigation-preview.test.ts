// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  openNavigationPreview,
  resolveNavigationPreviewDestination,
} from "./navigation-preview";

describe("navigation preview safety", () => {
  afterEach(() => vi.restoreAllMocks());

  it("resolves only shared-policy destinations", () => {
    const storefrontPath = (path: string) => `https://store.example${path}`;

    expect(resolveNavigationPreviewDestination("products", storefrontPath))
      .toBe("https://store.example/products");
    expect(resolveNavigationPreviewDestination("https://example.com/help", storefrontPath))
      .toBe("https://example.com/help");
    expect(resolveNavigationPreviewDestination("javascript:alert(1)", storefrontPath))
      .toBeNull();
  });

  it("opens a valid destination without exposing the admin window as opener", () => {
    const opened = { opener: window } as unknown as Window;
    const open = vi.spyOn(window, "open").mockReturnValue(opened);

    openNavigationPreview("/products", (path) => `https://store.example${path}`);

    expect(open).toHaveBeenCalledWith(
      "https://store.example/products",
      "_blank",
      "noopener,noreferrer",
    );
    expect(opened.opener).toBeNull();
  });
});
