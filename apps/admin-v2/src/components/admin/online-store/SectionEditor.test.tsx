// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { storefrontSectionDefault, type StorefrontSection } from "@scalius/shared/storefront-theme";
import { SectionEditor, newSectionId, sectionErrors } from "./SectionEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("~/lib/api", () => ({ apiData: (call: unknown) => call }));
vi.mock("@scalius/api-client/sdk", () => ({
  getApiV1AdminCollections: vi.fn(async () => ({ collections: [], pagination: { page: 1, totalPages: 1 } })),
  getApiV1AdminCollectionsByIds: vi.fn(async () => ({ collections: [] })),
  getApiV1AdminCategoriesFormOptions: vi.fn(async () => ({ categories: [] })),
  getApiV1AdminDiscounts: vi.fn(async () => ({ discounts: [] })),
}));
vi.mock("~/components/admin/media-manager", () => ({ MediaManager: ({ trigger }: { trigger: ReactNode }) => trigger }));

let root: Root;
let container: HTMLDivElement;
const seen: { sections: StorefrontSection[] } = { sections: [] };

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const section = (type: StorefrontSection["type"], id: string, settings: Record<string, unknown> = {}) =>
  ({ ...storefrontSectionDefault(type, id), settings: { ...storefrontSectionDefault(type, id).settings, ...settings } }) as StorefrontSection;

function render(initial: StorefrontSection[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Page() {
    const [sections, setSections] = useState(initial);
    seen.sections = sections;
    return <SectionEditor sections={sections} notes={{}} media={[]} onChange={setSections} />;
  }
  act(() => root.render(<QueryClientProvider client={queryClient}><Page /></QueryClientProvider>));
}

const button = (label: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  ?? [...document.querySelectorAll<HTMLButtonElement>("button")].find((each) => each.textContent === label)!;
const rows = () => [...container.querySelectorAll("li")].map((row) => row.firstElementChild?.textContent);
const dialog = () => document.querySelector("[role=dialog]");

function choose(select: HTMLSelectElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function type(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("homepage section editor", () => {
  it("flags sections with nothing to show", () => {
    render([section("shop-by", "cards"), section("product-rail", "rail")]);
    expect(rows()).toEqual(["Shop-by cardsHidden until you add its content.", "Product row"]);
  });

  it("adds a section with its settings on Done, under a free id", async () => {
    render([section("product-tabs", "product-tabs")]);
    choose(container.querySelector<HTMLSelectElement>('select[aria-label="Add section"]')!, "product-tabs");
    expect(dialog()?.textContent).toContain("Product tabs");
    expect(seen.sections).toHaveLength(1); // nothing lands before Done
    await act(async () => button("Done").click());
    expect(seen.sections.map((each) => each.id)).toEqual(["product-tabs", "product-tabs-2"]);
  });

  it("adds a data-only section at once", () => {
    render([]);
    choose(container.querySelector<HTMLSelectElement>('select[aria-label="Add section"]')!, "collections");
    expect(seen.sections.map((each) => each.type)).toEqual(["collections"]);
    expect(dialog()).toBeNull();
  });

  it("keeps a card without a name or with a bad link out of the draft and says why", async () => {
    render([section("shop-by", "cards")]);
    act(() => button("Edit Shop-by cards").click());
    act(() => button("Add card").click());
    type(document.querySelector<HTMLInputElement>("#section-cards-card-0-link")!, "sale");
    await act(async () => button("Done").click());
    expect(dialog()?.textContent).toContain("Fix the marked fields first.");
    expect(dialog()?.textContent).toContain("Use a store path like /sale or a full https:// link.");
    expect(dialog()?.textContent).toContain("Fill this in.");
    expect(seen.sections[0]).toEqual(section("shop-by", "cards"));
  });

  it("removes a section", () => {
    render([section("brand-wall", "brands"), section("recently-viewed", "recent")]);
    act(() => button("Remove Brands").click());
    expect(seen.sections.map((each) => each.id)).toEqual(["recent"]);
  });

  it("names new ids after their type and maps errors to their fields", () => {
    expect(newSectionId("shop-by", [section("shop-by", "shop-by"), section("shop-by", "shop-by-2")])).toBe("shop-by-3");
    const errors = sectionErrors(section("banner-mosaic", "m", { tiles: [{ mediaId: "", alt: "", href: "//evil" }] }));
    expect(errors.get("tiles.0.mediaId")?.key).toBe("fieldRequired");
    expect(errors.get("tiles.0.href")?.key).toBe("linkInvalid");
    const tabs = sectionErrors(section("product-tabs", "t", { tabs: [{ label: "", source: { kind: "newest" } }] }));
    expect(tabs.get("tabs")).toEqual({ key: "fieldCount", values: { count: 2 } });
  });
});
