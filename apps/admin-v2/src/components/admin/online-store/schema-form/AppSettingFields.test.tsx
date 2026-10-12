// @vitest-environment happy-dom

/**
 * The settings an app's storefront components declare, as the editor draws
 * them: an image from Files, one product, where products come from, a store
 * link and a list of items. Each edit must land in the values the theme
 * saves, in the shape the plugin settings schema accepts.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThemeAppSettingField } from "~/lib/api-query-options/online-store";
import type { AppSettingValues } from "./app-settings";
import { AppSettingFields } from "./AppSettingFields";
import { useMediaPreviews } from "./resource-fields";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("~/lib/api", () => ({ apiData: (call: unknown) => call }));
vi.mock("@scalius/api-client/sdk", () => ({
  getApiV1AdminCollections: vi.fn(async () => ({ collections: [{ id: "col_eid", name: "Eid picks" }], pagination: { page: 1, totalPages: 1 } })),
  getApiV1AdminCollectionsByIds: vi.fn(async () => ({ collections: [{ id: "col_eid", name: "Eid picks" }] })),
  getApiV1AdminCategoriesFormOptions: vi.fn(async () => ({ categories: [] })),
  getApiV1AdminProductsByIds: vi.fn(async () => ({ products: [{ id: "prod_honey", name: "Sundarban honey", primaryImage: "https://cdn.test/honey.jpg" }] })),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => <a href={to} {...props}>{children}</a>,
}));
vi.mock("~/components/admin/media-manager", () => ({
  MediaManager: ({ trigger, onSelect }: { trigger: ReactNode; onSelect?: (file: unknown) => void }) => (
    <span onClickCapture={() => onSelect?.({ id: "media_eid", url: "https://cdn.test/eid.jpg", altText: "Eid" })}>{trigger}</span>
  ),
}));

let root: Root;
let container: HTMLDivElement;
let latest: AppSettingValues = {};

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const field = (key: string, type: ThemeAppSettingField["type"], extra: Partial<ThemeAppSettingField> = {}): ThemeAppSettingField => ({
  key, label: key[0]!.toUpperCase() + key.slice(1), help: null, type, required: false, options: null, default: null,
  min: null, max: null, integer: false, maxLength: null, ...extra,
});

function Harness({ fields, initial }: { fields: ThemeAppSettingField[]; initial: AppSettingValues }) {
  const [values, setValues] = useState(initial);
  latest = values;
  const media = useMediaPreviews([]);
  return <AppSettingFields idPrefix="app" fields={fields} values={values} media={media} onChange={setValues} />;
}

function render(fields: ThemeAppSettingField[], initial: AppSettingValues = {}) {
  latest = initial;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root.render(<QueryClientProvider client={queryClient}><Harness fields={fields} initial={initial} /></QueryClientProvider>));
}

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const byId = <Element extends HTMLElement = HTMLInputElement>(id: string) => container.querySelector<Element>(`#${CSS.escape(id)}`)!;
const click = (element: HTMLElement) => act(() => element.click());
const named = (name: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
const buttonText = (text: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((each) => each.textContent === text)!;

function type(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function choose(trigger: HTMLElement, label: string) {
  click(trigger);
  const option = [...document.querySelectorAll<HTMLElement>("[role=option]")].find((each) => each.textContent?.includes(label));
  expect(option, label).toBeDefined();
  click(option!);
}

describe("app component settings", () => {
  it("picks an image from Files and shows it, and removes an optional one", () => {
    render([field("photo", "image")]);
    expect(container.textContent).toContain("Photo (optional)");
    click(buttonText("Select image"));
    expect(latest).toEqual({ photo: "media_eid" });
    expect(container.querySelector<HTMLImageElement>("#app-photo img")?.src).toContain("eid.jpg");
    click(buttonText("Remove"));
    expect(latest).toEqual({ photo: null });
  });

  it("chooses where products come from, asking for the collection a collection source needs", () => {
    render([field("shelf", "products", { required: true, limit: 6, default: "newest" })]);
    expect(byId("app-shelf-note").textContent).toBe("Shows up to 6 products.");
    choose(byId<HTMLButtonElement>("app-shelf"), "A collection");
    expect(latest).toEqual({ shelf: "collection:" });
    expect(byId("app-shelf-collection-note").textContent).toBe("Choose a collection.");
    choose(byId<HTMLButtonElement>("app-shelf"), "Best sellers");
    expect(latest).toEqual({ shelf: "popular" });
    expect(container.querySelector("#app-shelf-collection")).toBeNull();
  });

  it("shows the chosen product's name and photo", async () => {
    render([field("featured", "product")], { featured: "prod_honey" });
    await flush();
    expect(byId<HTMLButtonElement>("app-featured").textContent).toContain("Sundarban honey");
    expect(container.querySelector<HTMLImageElement>("img")?.src).toContain("honey.jpg");
  });

  it("takes a store path or an https link and says what else it refuses", () => {
    render([field("cta", "link")]);
    type(byId("app-cta"), "/collections/eid");
    expect(latest).toEqual({ cta: "/collections/eid" });
    type(byId("app-cta"), "http://shop.test");
    expect(byId("app-cta-note").textContent).toBe("Use a store path like /collections/new or a full https:// address.");
    type(byId("app-cta"), "");
    expect(latest).toEqual({ cta: null });
  });

  describe("lists", () => {
    const slides = () => field("slides", "list", {
      itemLabel: "Slide",
      min: 1,
      max: 3,
      fields: [
        { ...field("title", "text", { maxLength: 40, required: true }) },
        { ...field("dark", "boolean", { default: true }) },
      ],
    });
    const titles = () => [...container.querySelectorAll<HTMLButtonElement>("[data-app-list-item] button[aria-expanded]")].map((each) => each.textContent);

    it("adds items at their defaults, titles them by their first text and keeps within the app's bounds", () => {
      render([slides()]);
      expect(container.textContent).toContain("Nothing added yet.");
      click(buttonText("Add Slide"));
      expect(latest).toEqual({ slides: [{ dark: true }] });
      // A new item opens, says what it needs, and cannot go below the minimum.
      expect(titles()).toEqual(["Slide 1Needs a fix"]);
      expect(byId("app-slides-0-title-note").textContent).toBe("Fill this in.");
      expect(named("Remove Slide 1").disabled).toBe(true);
      type(byId("app-slides-0-title"), "Eid sale");
      expect(titles()).toEqual(["Eid sale"]);
      click(buttonText("Add Slide"));
      click(buttonText("Add Slide"));
      expect(buttonText("Add Slide").disabled).toBe(true);
      expect(container.textContent).toContain("Holds up to 3.");
      expect(latest.slides).toEqual([{ title: "Eid sale", dark: true }, { dark: true }, { dark: true }]);
    });

    it("moves items with buttons and Alt+arrow keys, collapses them and keeps focus on the moved item", async () => {
      render([slides()], { slides: [{ title: "First" }, { title: "Second" }, { title: "Third" }] });
      expect(titles()).toEqual(["First", "Second", "Third"]);
      // Items start folded.
      expect(container.querySelector("#app-slides-0-title")).toBeNull();
      click(named("Move First down"));
      expect(latest.slides).toEqual([{ title: "Second" }, { title: "First" }, { title: "Third" }]);
      const third = [...container.querySelectorAll<HTMLButtonElement>("[data-app-list-item] button[aria-expanded]")][2]!;
      act(() => {
        third.focus();
        third.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", altKey: true, bubbles: true }));
      });
      await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(null))); });
      expect(titles()).toEqual(["Second", "Third", "First"]);
      expect(document.activeElement?.textContent).toBe("Third");
      click(third);
      expect(third.getAttribute("aria-expanded")).toBe("true");
      expect(byId("app-slides-1-title").value).toBe("Third");
      click(named("Remove Second"));
      expect(latest.slides).toEqual([{ title: "Third" }, { title: "First" }]);
    });
  });
});
