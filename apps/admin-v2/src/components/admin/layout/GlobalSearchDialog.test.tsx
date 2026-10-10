// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "~/i18n";

const navigate = vi.fn();
const searchGlobal = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("@scalius/api-client/sdk", () => ({ getApiV1AdminSearchGlobal: (options: unknown) => searchGlobal(options) }));
vi.mock("~/lib/api", () => ({ apiData: async (value: unknown) => value }));
vi.mock("./ThemeProvider", () => ({ useTheme: () => ({ theme: "light", toggleTheme: vi.fn() }) }));
vi.mock("~/hooks/use-debounce", () => ({ useDebounce: (value: unknown) => value }));

const { GlobalSearchDialog } = await import("./GlobalSearchDialog");
const { readListSearch } = await import("~/lib/list-search");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const EMPTY = { query: "", orders: [], customers: [], products: [], discounts: [], collections: [], categories: [], pages: [] };

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setLocale("en");
});

async function type(text: string) {
  const input = document.querySelector<HTMLInputElement>("[cmdk-input]")!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

describe("global search (⌘K)", () => {
  it("names the command list in Bangla instead of cmdk's English default", async () => {
    setLocale("bn");
    searchGlobal.mockResolvedValue(EMPTY);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(
      <QueryClientProvider client={client}>
        <GlobalSearchDialog nav={[]} canOpen={() => true} goKeys={new Map()} open setOpen={() => undefined} />
      </QueryClientProvider>,
    ));
    expect(document.querySelector('[role="listbox"]')?.getAttribute("aria-label")).toBe("অপশন");
  });

  it("groups records by kind from one request and ends each group with a searched list link", async () => {
    searchGlobal.mockResolvedValue({
      ...EMPTY,
      query: "rahim",
      orders: [{ id: "ord_1", orderNumber: 1001, customerName: "Rahim Uddin", status: "pending" }],
      products: [{ id: "p_1", name: "Rahim's panjabi", isActive: false, matchedSku: null }],
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(
      <QueryClientProvider client={client}>
        <GlobalSearchDialog nav={[]} canOpen={() => true} goKeys={new Map()} open setOpen={() => undefined} />
      </QueryClientProvider>,
    ));
    await type("rahim");

    expect(searchGlobal).toHaveBeenCalledTimes(1);
    expect(searchGlobal).toHaveBeenCalledWith({ query: { q: "rahim" } });
    const headings = [...document.querySelectorAll("[cmdk-group-heading]")].map((node) => node.textContent);
    expect(headings).toEqual(expect.arrayContaining(["Orders", "Products"]));
    expect(document.body.textContent).toContain("#1001");
    expect(document.body.textContent).toContain("Draft");

    const seeAll = [...document.querySelectorAll<HTMLElement>("[cmdk-item]")].find((item) => item.textContent?.includes("Search all orders"))!;
    expect(seeAll.textContent).toContain("Search all orders for “rahim”");
    await act(async () => seeAll.click());
    expect(readListSearch("orders")).toBe("rahim");
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ to: "/admin/orders" }));
  });
});
