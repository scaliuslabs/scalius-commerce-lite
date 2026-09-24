// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api/transport", () => ({ createApiUrl: (path: string) => `/api/v1${path}` }));

import CommandPalette from "./CommandPalette";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
const product = (id: string, slug: string) => ({
  id, name: slug, slug, price: 1200, discountedPrice: 1200, imageUrl: null,
});

function searchResponse(data: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ success: true, data: { products: [], categories: [], pages: [], ...data } }),
  }));
}

const input = () => document.querySelector<HTMLInputElement>("input[role=combobox]")!;

async function type(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
}

async function press(key: string) {
  await act(async () => {
    input().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

beforeEach(async () => {
  window.history.replaceState({}, "", "/");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  window.__scaliusSearchPaletteOpenPending = true;
  await act(async () => root.render(<CommandPalette />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("search palette keyboard (WAI-ARIA combobox)", () => {
  it("submits the typed query on Enter instead of opening the first suggestion", async () => {
    searchResponse({ products: [product("p1", "trail-belt-bag"), product("p2", "tote-bag")] });
    await type("bag");

    expect(document.querySelectorAll("[role=option]")).toHaveLength(2);
    expect(input().hasAttribute("aria-activedescendant")).toBe(false);
    expect(document.querySelector("[aria-selected=true]")).toBeNull();

    await press("Enter");

    expect(window.location.pathname).toBe("/search");
    expect(window.location.search).toBe("?q=bag");
  });

  it("opens a suggestion only after the buyer arrows to it, and wraps back to the input", async () => {
    searchResponse({ products: [product("p1", "trail-belt-bag"), product("p2", "tote-bag")] });
    await type("bag");

    await press("ArrowDown");
    expect(input().getAttribute("aria-activedescendant")).toBe("cmd-item-0");
    await press("ArrowUp");
    expect(input().hasAttribute("aria-activedescendant")).toBe(false);
    await press("ArrowUp");
    expect(input().getAttribute("aria-activedescendant")).toBe("cmd-item-1");

    await press("Enter");
    expect(window.location.pathname).toBe("/products/tote-bag");
  });

  it("says which corrected query the suggestions are for", async () => {
    searchResponse({ products: [product("p1", "copper-kettle")], correctedQuery: "kettle" });
    await type("kettel");

    expect(document.body.textContent).toContain("No results for “kettel”. Showing results for “kettle”.");
  });

  it("shows a calm no-results state with a way to keep browsing", async () => {
    searchResponse({});
    await type("zzzz");

    expect(document.body.textContent).toContain("No results for “zzzz”");
    expect(document.querySelector("[role=alert]")).toBeNull();
    expect(document.querySelector<HTMLAnchorElement>("a[href='/search']")?.textContent).toContain("Browse all products");
  });
});

describe("search palette focus return (R3-MOB-07)", () => {
  const settle = () => act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 120));
  });

  async function openFrom(opener: HTMLElement) {
    opener.focus();
    await act(async () => {
      document.dispatchEvent(new CustomEvent("open-search-palette"));
    });
    await settle();
    expect(document.activeElement).toBe(input());
  }

  it("returns focus to the control that opened search on Esc and on the close button", async () => {
    await press("Escape");
    const opener = document.createElement("button");
    opener.textContent = "Search";
    document.body.append(opener);

    await openFrom(opener);
    await press("Escape");
    expect(input()).toBeNull();
    expect(document.activeElement).toBe(opener);

    await openFrom(opener);
    await act(async () => {
      document.querySelector<HTMLButtonElement>("button[aria-label='Close search']")!.click();
    });
    expect(document.activeElement).toBe(opener);
  });
});
