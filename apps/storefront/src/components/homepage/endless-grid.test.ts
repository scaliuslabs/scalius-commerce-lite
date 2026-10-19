// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupEndlessGrids } from "./endless-grid";

const card = (id: number) => `<article data-theme-component="product-card"><a href="/products/p${id}">Product ${id}</a><img src="/${id}.jpg" sizes="20vw" loading="eager" fetchpriority="high"></article>`;
const range = (start: number, length: number) => Array.from({ length }, (_, index) => start + index);
const links = () => [...document.querySelectorAll<HTMLAnchorElement>("[data-endless-grid] .product-grid > article a")].map((link) => link.getAttribute("href"));
const more = () => document.querySelector<HTMLAnchorElement>("[data-endless-more]");
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function home(ids = range(0, 24), href = "/search?page=2") {
  document.body.innerHTML = `<section data-endless-grid><div class="product-grid">${ids.map(card).join("")}</div><a data-endless-more href="${href}">Load more</a></section>`;
  setupEndlessGrids();
}

// The actual CatalogPaging/CatalogPagination shapes, inside CatalogListing's root.
function listing(ids: number[], next: string | null, mode: "numbered" | "load-more" | "infinite" = "numbered") {
  const numbered = `<nav aria-label="Pagination" data-catalog-pagination>${next ? `<a aria-label="Next page" data-catalog-next href="${next}">Next</a>` : '<button aria-label="Next page" disabled>Next</button>'}</nav>`;
  const paging = mode === "numbered" ? numbered : `<div data-catalog-paging="${mode}">${mode === "infinite" ? numbered : ""}${next ? `<a data-catalog-load-more href="${next}">Load more</a>` : ""}</div>`;
  return `<html><body><div data-catalog-layout="sidebar">${ids.length ? `<div class="product-grid">${ids.map(card).join("")}</div>${paging}` : '<div data-catalog-empty-state>No products found</div>'}</div><aside class="product-grid">${card(9999)}</aside></body></html>`;
}

beforeEach(() => {
  history.replaceState({}, "", "/");
  delete document.documentElement.dataset.marketPresence;
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  delete document.documentElement.dataset.marketPresence;
});

describe("homepage endless-grid continuation", () => {
  it.each(["numbered", "load-more", "infinite"] as const)("exhausts exactly 200 products using %s authority without requesting page 11", async (mode) => {
    home();
    const fetcher = vi.fn(async (href: string) => {
      const page = Number(new URL(href).searchParams.get("page"));
      expect(page).toBeGreaterThanOrEqual(2);
      expect(page).toBeLessThanOrEqual(10);
      return new Response(listing(range((page - 1) * 20, 20), page < 10 ? `/search?page=${page + 1}` : null, mode));
    });
    vi.stubGlobal("fetch", fetcher);
    for (let page = 2; page <= 10; page++) {
      more()!.click();
      await flush();
      await flush();
      expect(links()).toEqual(range(0, page * 20).map((id) => `/products/p${id}`));
    }
    expect(fetcher).toHaveBeenCalledTimes(9);
    expect(more()).toBeNull();
    expect(location.pathname).toBe("/");
  });

  it.each([0, 7])("stops on a genuine %i-card final response and ignores unrelated cards", async (count) => {
    home();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(listing(range(24, count), null))));
    more()!.click();
    await flush();
    await flush();
    expect(links()).toEqual(range(0, 24 + count).map((id) => `/products/p${id}`));
    expect(more()).toBeNull();
  });

  it("keeps a short page's explicit continuation and preserves the buyer presence", async () => {
    document.documentElement.dataset.marketPresence = "bn";
    home(range(0, 24), "/bn/search?page=2");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(listing([24, 25, 26], "/search?page=3"))));
    more()!.click();
    await flush();
    await flush();
    expect(more()!.getAttribute("href")).toContain("/bn/search?page=3");
    expect(links()).toHaveLength(27);
  });

  it("deduplicates overlap and duplicate response cards while preserving image loading behavior", async () => {
    home();
    document.querySelector("img")!.setAttribute("sizes", "40vw");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(listing([23, 24, 24, 25], null))));
    more()!.click();
    await flush();
    await flush();
    expect(links()).toHaveLength(26);
    expect(new Set(links()).size).toBe(26);
    const appended = document.querySelector<HTMLImageElement>('img[src="/24.jpg"]')!;
    expect(appended.loading).toBe("lazy");
    expect(appended.hasAttribute("fetchpriority")).toBe(false);
    expect(appended.getAttribute("sizes")).toBe("40vw");
  });

  it.each([
    { status: 0, body: "Network failed" },
    { status: 404, body: "Gone after catalog changed" },
    { status: 503, body: "Unavailable" },
    { status: 200, body: "Not a listing" },
    { status: 200, body: "<div data-catalog-layout></div>" },
    { status: 200, body: '<div data-catalog-layout><div class="product-grid"><article data-theme-component="product-card">Broken card</article></div></div>' },
    { status: 200, body: listing([24], "/search?page=2") },
    { status: 200, body: listing([24], "https://elsewhere.test/search?page=3") },
    { status: 200, body: '<div data-catalog-layout><div data-catalog-paging><a data-catalog-load-more href="/search?page=3">Next</a></div></div>' },
  ])("preserves navigation fallback for failed, stale or inconsistent responses ($status)", async ({ status, body }) => {
    home();
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, set href(value: string) { assign(value); } });
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (status === 0) throw new Error(body);
      return new Response(body, { status });
    }));
    const link = more()!;
    link.click();
    await flush();
    await flush();
    expect(assign).toHaveBeenCalledWith(expect.stringContaining("/search?page=2"));
    expect(links()).toHaveLength(24);
    expect(more()).toBe(link);
    expect(link.hasAttribute("aria-busy")).toBe(false);
    // If navigation has not completed, the original link remains usable for a retry.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(listing([24], null))));
    link.click();
    await flush();
    await flush();
    expect(links()).toHaveLength(25);
    expect(more()).toBeNull();
  });

  it("binds once and suppresses duplicate in-flight clicks without intercepting modified clicks", async () => {
    home();
    setupEndlessGrids();
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>((done) => { resolve = done; }));
    vi.stubGlobal("fetch", fetcher);
    const link = more()!;
    const modified = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true });
    link.dispatchEvent(modified);
    expect(modified.defaultPrevented).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    link.click();
    link.click();
    expect(fetcher).toHaveBeenCalledTimes(1);
    resolve(new Response(listing([24], null)));
    await flush();
    await flush();
    expect(links()).toHaveLength(25);
  });
});
