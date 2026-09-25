// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CATALOG_VIEW_STORAGE_KEY,
  catalogProgressLabel,
  setupCatalogPaging,
  setupCatalogViewToggle,
} from "./catalog-paging";

const card = (id: string, eager = false) =>
  `<div data-theme-component="product-card"><img src="/${id}.jpg" ${eager ? 'loading="eager" fetchpriority="high"' : 'loading="lazy"'}><a href="/products/${id}">${id}</a></div>`;

function listing({ mode, page, next, from, to, total, cards }: {
  mode: "load-more" | "infinite";
  page: number;
  next: string | null;
  from: number;
  to: number;
  total: number;
  cards: string[];
}): string {
  return `
    <div class="product-grid-frame" data-catalog-results="grid"><div class="product-grid">${cards.join("")}</div></div>
    <div data-catalog-paging="${mode}">
      ${mode === "infinite" ? `<nav aria-label="Pagination"><a href="?page=${page + 1}">${page + 1}</a></nav>` : ""}
      <div data-catalog-load-more-block ${mode === "infinite" ? "hidden" : ""}>
        <p data-catalog-progress data-from="${from}" data-to="${to}" data-total="${total}">${catalogProgressLabel(from, to, total)}</p>
        ${next ? `<a href="${next}" data-catalog-load-more>Load more</a>` : ""}
      </div>
    </div>`;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("catalog paging", () => {
  beforeEach(() => {
    history.replaceState({}, "", "/categories/sarees");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("labels progress with Indian digit grouping", () => {
    expect(catalogProgressLabel(1, 20, 12_500)).toBe("Showing 1–20 of 12,500 products");
    expect(catalogProgressLabel(1, 1, 1)).toBe("Showing 1–1 of 1 product");
  });

  it("appends the next page's cards, follows its URL and moves focus to the first new product", async () => {
    document.body.innerHTML = listing({ mode: "load-more", page: 1, next: "/categories/sarees?page=2", from: 1, to: 2, total: 5, cards: [card("a"), card("b")] });
    const pageTwo = `<html><body>${listing({ mode: "load-more", page: 2, next: "/categories/sarees?page=3", from: 3, to: 4, total: 5, cards: [card("c", true), card("d")] })}</body></html>`;
    const fetcher = vi.fn(async () => new Response(pageTwo, { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    setupCatalogPaging();

    document.querySelector<HTMLAnchorElement>("a[data-catalog-load-more]")!.click();
    await flush();
    await flush();

    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining("/categories/sarees?page=2"), expect.objectContaining({ credentials: "same-origin" }));
    const cards = [...document.querySelectorAll(".product-grid > [data-theme-component]")];
    expect(cards.map((item) => item.textContent)).toEqual(["a", "b", "c", "d"]);
    // Appended photos never compete with the first screen.
    const appended = cards[2]!.querySelector("img")!;
    expect(appended.getAttribute("loading")).toBe("lazy");
    expect(appended.hasAttribute("fetchpriority")).toBe(false);
    expect(document.querySelector("[data-catalog-progress]")!.textContent).toBe("Showing 1–4 of 5 products");
    expect(location.pathname + location.search).toBe("/categories/sarees?page=2");
    expect(document.querySelector<HTMLAnchorElement>("a[data-catalog-load-more]")!.getAttribute("href")).toContain("page=3");
    expect(document.activeElement).toBe(cards[2]!.querySelector("a"));
  });

  it("removes the button after the last page and follows the link when the page cannot be read", async () => {
    document.body.innerHTML = listing({ mode: "load-more", page: 1, next: "/categories/sarees?page=2", from: 1, to: 1, total: 2, cards: [card("a")] });
    const last = `<html><body>${listing({ mode: "load-more", page: 2, next: null, from: 2, to: 2, total: 2, cards: [card("b")] })}</body></html>`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(last)));
    setupCatalogPaging();
    document.querySelector<HTMLAnchorElement>("a[data-catalog-load-more]")!.click();
    await flush();
    await flush();
    expect(document.querySelector("a[data-catalog-load-more]")).toBeNull();
    expect(document.querySelector("[data-catalog-progress]")!.textContent).toBe("Showing 1–2 of 2 products");

    document.body.innerHTML = listing({ mode: "load-more", page: 1, next: "/categories/sarees?page=2", from: 1, to: 1, total: 2, cards: [card("a")] });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })));
    const assign = vi.fn();
    const locationStub = { ...window.location, set href(value: string) { assign(value); } };
    vi.stubGlobal("location", locationStub);
    setupCatalogPaging();
    document.querySelector<HTMLAnchorElement>("a[data-catalog-load-more]")!.click();
    await flush();
    await flush();
    expect(assign).toHaveBeenCalledWith(expect.stringContaining("/categories/sarees?page=2"));
  });

  it("turns numbered pages into the automatic loader when infinite scroll runs", () => {
    const observed: Element[] = [];
    vi.stubGlobal("IntersectionObserver", class {
      observe(element: Element) { observed.push(element); }
      disconnect() {}
    });
    document.body.innerHTML = listing({ mode: "infinite", page: 1, next: "/categories/sarees?page=2", from: 1, to: 1, total: 3, cards: [card("a")] });
    setupCatalogPaging();
    expect(document.querySelector("nav[aria-label='Pagination']")!.hasAttribute("hidden")).toBe(true);
    const loader = document.querySelector<HTMLElement>("[data-catalog-load-more-block]")!;
    expect(loader.hidden).toBe(false);
    expect(observed).toEqual([loader]);
  });
});

describe("grid/list toggle", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
  });

  it("switches the results and remembers the choice", () => {
    document.body.innerHTML = `
      <div data-catalog-view-toggle>
        <button data-view="grid" aria-pressed="true"></button><button data-view="list" aria-pressed="false"></button>
      </div>
      <div class="product-grid-frame" data-catalog-results="grid"></div>`;
    setupCatalogViewToggle();
    const toggle = document.querySelector<HTMLElement>("[data-catalog-view-toggle]")!;
    toggle.querySelector<HTMLButtonElement>("[data-view='list']")!.click();
    expect(document.querySelector<HTMLElement>("[data-catalog-results]")!.dataset.catalogResults).toBe("list");
    expect(localStorage.getItem(CATALOG_VIEW_STORAGE_KEY)).toBe("list");
    expect(toggle.querySelector("[data-view='list']")!.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.querySelector("[data-view='grid']")!.getAttribute("aria-pressed")).toBe("false");
  });
});
