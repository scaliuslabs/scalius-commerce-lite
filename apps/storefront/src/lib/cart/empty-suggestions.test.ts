// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const recommendations = vi.hoisted(() => ({ fetchRecommendationsFromBrowser: vi.fn() }));
vi.mock("@/lib/recommendations", () => recommendations);

import { resetEmptyCartSuggestions, showEmptyCartSuggestions } from "./empty-suggestions";

const product = (id: string, name: string) => ({
  id, slug: `${id}-slug`, name, imageUrl: null, discountedPrice: 1250,
});

describe("empty cart suggestions", () => {
  beforeEach(() => {
    resetEmptyCartSuggestions();
    recommendations.fetchRecommendationsFromBrowser.mockReset();
    document.body.innerHTML = '<section data-cart-empty-popular hidden><h2>Popular now</h2><ul></ul></section>';
  });

  it("asks for popular products without a source product, once, and shows them as links", async () => {
    recommendations.fetchRecommendationsFromBrowser.mockResolvedValue({ reason: "popular", products: [product("a", "Linen shirt"), product("b", "Belt")] });
    await showEmptyCartSuggestions();
    await showEmptyCartSuggestions();
    expect(recommendations.fetchRecommendationsFromBrowser).toHaveBeenCalledTimes(1);
    expect(recommendations.fetchRecommendationsFromBrowser.mock.calls[0]![0]).toEqual([]);
    const section = document.querySelector<HTMLElement>("[data-cart-empty-popular]")!;
    expect(section.hidden).toBe(false);
    expect(Array.from(section.querySelectorAll("a")).map((link) => [link.getAttribute("href"), link.textContent])).toEqual([
      ["/products/a-slug", expect.stringContaining("Linen shirt")],
      ["/products/b-slug", expect.stringContaining("Belt")],
    ]);
  });

  it("leaves the list out when nothing comes back", async () => {
    recommendations.fetchRecommendationsFromBrowser.mockResolvedValue(null);
    await showEmptyCartSuggestions();
    expect(document.querySelector<HTMLElement>("[data-cart-empty-popular]")!.hidden).toBe(true);
    resetEmptyCartSuggestions();
    recommendations.fetchRecommendationsFromBrowser.mockResolvedValue({ reason: "popular", products: [] });
    await showEmptyCartSuggestions();
    expect(document.querySelector<HTMLElement>("[data-cart-empty-popular]")!.hidden).toBe(true);
  });
});
