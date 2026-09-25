// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, Suspense } from "react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_STOREFRONT_THEME,
  storeShapeFromFacts,
  storefrontTemplateTheme,
  type StorefrontThemeDocument,
} from "@scalius/shared/storefront-theme";
import {
  footerQueryOptions,
  headerQueryOptions,
  themeQueryOptions,
} from "~/lib/api-query-options/online-store";
import { ThemePage } from "./ThemePage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ theme: vi.fn(), header: vi.fn(), footer: vi.fn() }));
const fonts = vi.hoisted(() => ({ register: vi.fn() }));

vi.mock("./type-preview-fonts", () => ({ registerTypePreviewFonts: fonts.register }));

vi.mock("~/lib/api", () => ({ apiData: (call: unknown) => call }));
vi.mock("@scalius/api-client/sdk", () => ({
  getApiV1AdminSettingsTheme: vi.fn(),
  getApiV1AdminSettingsHeader: vi.fn(),
  getApiV1AdminSettingsFooter: vi.fn(),
  postApiV1AdminSettingsTheme: api.theme,
  postApiV1AdminSettingsHeader: api.header,
  postApiV1AdminSettingsFooter: api.footer,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("~/components/admin/shared/UnsavedChangesGuard", () => ({ UnsavedChangesGuard: () => null }));
vi.mock("~/components/admin/media-manager", () => ({ MediaManager: ({ trigger }: { trigger: ReactNode }) => trigger }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  api.theme.mockImplementation(async ({ body }: { body: { theme: StorefrontThemeDocument } }) => ({
    theme: body.theme,
    revision: 2,
  }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** A small store: every choice fits except where a test says otherwise. */
const SHAPE = storeShapeFromFacts({
  productCount: 40,
  skuCount: 60,
  topCategoryCount: 5,
  categoryDepth: 1,
  menu: [{}, {}, {}, {}, {}],
  hasCollections: true,
  hasDeliveryMethods: true,
});

function render(theme: StorefrontThemeDocument, storeShape = SHAPE) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  queryClient.setQueryData(themeQueryOptions().queryKey, { theme, revision: 1, storeShape } as never);
  queryClient.setQueryData(headerQueryOptions().queryKey, {
    config: { logo: { src: "", alt: "" }, favicon: { src: "", alt: "" }, topBar: { isEnabled: false } },
    revision: 1,
  } as never);
  queryClient.setQueryData(footerQueryOptions().queryKey, { config: { logo: { src: "", alt: "" } }, revision: 1 } as never);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <Suspense fallback={null}>
          <ThemePage />
        </Suspense>
      </QueryClientProvider>,
    );
  });
}

const headings = () => [...container.querySelectorAll("h2")].map((heading) => heading.textContent);
const radio = (name: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("[role=radio]")].find((item) => item.textContent?.startsWith(name))!;
const saveBar = () => document.querySelector("[data-save-bar]");
const pressSave = () =>
  act(async () => {
    [...document.querySelectorAll<HTMLButtonElement>("[data-save-bar] button")]
      .find((button) => button.textContent === "Save")!
      .click();
  });

function type(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("theme page", () => {
  it("shows one card per choice, with the saved template selected", () => {
    render(DEFAULT_STOREFRONT_THEME);
    expect(headings()).toEqual([
      "Template",
      "Logo",
      "Colors",
      "Typography",
      "Header",
      "Navigation",
      "Footer",
      "Product cards",
      "Density",
      "Product page",
      "Homepage sections",
    ]);
    expect(radio("Department mall").getAttribute("aria-checked")).toBe("true");
    expect(radio("Fashion value").getAttribute("aria-checked")).toBe("false");
    // Previews are decorative; the radio's text names the choice.
    expect(radio("Fashion value").querySelector("[aria-hidden=true]")).not.toBeNull();
    // All ten templates are offered.
    const templates = container.querySelector("[role=radiogroup]")!;
    expect(templates.querySelectorAll("[role=radio]")).toHaveLength(10);
    expect(saveBar()).toBeNull();
  });

  it("selecting a template sets and saves the whole document", async () => {
    render(DEFAULT_STOREFRONT_THEME);
    act(() => radio("Fashion value").click());
    expect(radio("Fashion value").getAttribute("aria-checked")).toBe("true");

    await pressSave();
    expect(api.theme).toHaveBeenCalledTimes(1);
    expect(api.theme.mock.calls[0]![0].body).toEqual({
      expectedRevision: 1,
      theme: storefrontTemplateTheme("fashion-value"),
    });
  });

  it("names the template a changed theme is based on and confirms before replacing it", () => {
    const tuned = storefrontTemplateTheme("fashion-value");
    tuned.blocks = { ...tuned.blocks, header: { variant: "spec-two-row", settings: {} } };
    render(tuned);
    // No template matches exactly, so none is checked, and the page says which one it is based on.
    expect(radio("Fashion value").getAttribute("aria-checked")).toBe("false");
    expect(container.textContent).toContain("Changed (based on Fashion value)");

    act(() => radio("Department mall").click());
    const dialog = document.querySelector("[role=alertdialog]");
    expect(dialog?.textContent).toContain("Replace your changes with Department mall?");
    // Cancelling keeps the changed theme.
    act(() => [...dialog!.querySelectorAll("button")].find((button) => button.textContent === "Cancel")!.click());
    expect(container.textContent).toContain("Changed (based on Fashion value)");

    act(() => radio("Department mall").click());
    act(() => [...document.querySelectorAll("[role=alertdialog] button")]
      .find((button) => button.textContent === "Replace")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(radio("Department mall").getAttribute("aria-checked")).toBe("true");
  });

  it("says what buyers see when a choice does not fit the store, and why", () => {
    const big = storeShapeFromFacts({
      productCount: 900,
      skuCount: 4000,
      topCategoryCount: 14,
      categoryDepth: 1,
      menu: [{}, {}],
      hasCollections: true,
      hasDeliveryMethods: true,
    });
    render(storefrontTemplateTheme("boutique"), big);
    expect(container.textContent).toContain(
      "Your store shows Departments instead. Needs 500 or fewer products and options (you have 1,000).",
    );
    // Sections that wait for their data (a subscriber list) say so; the
    // homepage section library renders the rest.
    const rows = [...container.querySelectorAll("li")].map((row) => row.textContent);
    expect(rows).toContain("NewsletterNot on your store yet.");
    expect(rows).toContain("Product grid");
    expect(rows).toContain("Banners");
  });

  it("names unreadable text in plain words and will not save it", async () => {
    render(DEFAULT_STOREFRONT_THEME);
    const buttonText = container.querySelector<HTMLInputElement>("#theme-color-button-text")!;
    type(buttonText, "#5A5A5A");

    expect(buttonText.value).toBe("#5a5a5a");
    expect(buttonText.getAttribute("aria-invalid")).toBe("true");
    const note = container.querySelector(`#${buttonText.getAttribute("aria-describedby")}`);
    expect(note?.textContent).toMatch(/^Button text is hard to read on the button color \(2\.\d:1, needs 4\.5:1\)\.$/);
    // The template no longer matches: nothing is selected.
    expect(radio("Department mall").getAttribute("aria-checked")).toBe("false");

    await pressSave();
    expect(api.theme).not.toHaveBeenCalled();

    // A readable colour clears the error and saves.
    type(buttonText, "#fafafa");
    expect(buttonText.hasAttribute("aria-invalid")).toBe(false);
    await pressSave();
    expect(api.theme).toHaveBeenCalledTimes(1);
  });

  describe("typography", () => {
    const card = () => {
      let node = [...container.querySelectorAll("h2")].find((heading) => heading.textContent === "Typography")!.parentElement!;
      while (!node.querySelector("[role=radiogroup]")) node = node.parentElement!;
      return node;
    };
    const button = (root: ParentNode, name: string) =>
      [...root.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === name);
    const dialog = () => document.querySelector<HTMLElement>("[role=dialog]");
    const pairings = () => [...dialog()!.querySelectorAll<HTMLButtonElement>("[role=radio]")];
    const group = (label: string) => [...card().querySelectorAll<HTMLElement>("[role=radiogroup]")].find((each) =>
      container.querySelector(`#${CSS.escape(each.getAttribute("aria-labelledby")!)}`)?.textContent === label)!;
    // An option's accessible text: its sketch is decorative.
    const name = (item: Element) => {
      const copy = item.cloneNode(true) as Element;
      copy.querySelectorAll("[aria-hidden=true]").forEach((hidden) => hidden.remove());
      return copy.textContent;
    };
    const choose = (label: string, option: string) => act(() =>
      [...group(label).querySelectorAll<HTMLButtonElement>("[role=radio]")].find((item) => name(item) === option)!.click());
    const checked = (label: string) => {
      const item = [...group(label).querySelectorAll("[role=radio]")].find((each) => each.getAttribute("aria-checked") === "true");
      return item ? name(item) : undefined;
    };
    const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    it("shows the template's fonts as its default and loads no preview font until the picker opens", async () => {
      render(DEFAULT_STOREFRONT_THEME);
      expect(card().textContent).toContain("CleanTemplate default");
      expect(card().textContent).toContain("Inter · Bangla: Noto Sans Bengali");
      expect(checked("Heading size")).toBe("Medium");
      expect(checked("Heading letters")).toBe("Sentence case");
      // Nothing to reset while the template's type is in place.
      expect(button(card(), "Reset to template default")).toBeUndefined();
      await flush();
      expect(fonts.register).not.toHaveBeenCalled();
      expect(dialog()).toBeNull();

      act(() => button(card(), "Change")!.click());
      await flush();
      expect(fonts.register).toHaveBeenCalledTimes(1);
      expect(dialog()!.textContent).toContain("Choose fonts");
    });

    it("lists every pairing drawn in its own fonts, in Latin and Bangla, with the template's preselected", async () => {
      render(storefrontTemplateTheme("heritage-editorial"));
      expect(card().textContent).toContain("HeritageTemplate default");
      expect(card().textContent).toContain("Cormorant Garamond and Inter · Bangla: Noto Serif Bengali");
      expect(checked("Heading letters")).toBe("All capitals");
      act(() => button(card(), "Change")!.click());
      await flush();

      expect(pairings().map((item) => item.value)).toEqual(["retail", "market", "editorial", "fresh", "beauty", "heritage", "tech"]);
      const heritage = pairings().find((item) => item.value === "heritage")!;
      expect(heritage.getAttribute("aria-checked")).toBe("true");
      expect(heritage.textContent).toContain("Template default");
      expect(pairings().filter((item) => item.textContent?.includes("Template default"))).toHaveLength(1);
      // The sample is decorative and draws with the storefront's stacks under preview names.
      const sample = heritage.querySelector<HTMLElement>("[aria-hidden=true]")!;
      expect(sample.style.getPropertyValue("--type-heading")).toMatch(/^"Preview Cormorant Garamond", "Preview Noto Serif Bengali"/);
      expect(sample.style.getPropertyValue("--type-body")).toMatch(/^"Preview Inter", "Preview Noto Serif Bengali"/);
      expect(sample.style.getPropertyValue("--type-heading-weight")).toBe("600");
      expect(sample.querySelector("[lang=bn]")?.textContent).toMatch(/[ঀ-৿]/);
    });

    it("saves a new pairing through the theme save, and cancel keeps the current one", async () => {
      render(DEFAULT_STOREFRONT_THEME);
      act(() => button(card(), "Change")!.click());
      await flush();
      act(() => pairings().find((item) => item.value === "editorial")!.click());
      act(() => button(dialog()!, "Cancel")!.click());
      expect(card().textContent).toContain("Clean");
      expect(saveBar()).toBeNull();

      act(() => button(card(), "Change")!.click());
      await flush();
      // Reopening starts from the saved choice, not the cancelled one.
      expect(pairings().find((item) => item.getAttribute("aria-checked") === "true")?.value).toBe("retail");
      act(() => pairings().find((item) => item.value === "editorial")!.click());
      act(() => button(dialog()!, "Select")!.click());
      expect(card().textContent).toContain("Editorial");
      expect(card().textContent).toContain("Instrument Serif and Inter · Bangla: Noto Serif Bengali");
      expect(card().textContent).not.toContain("Template default");
      expect(container.textContent).toContain("Changed (based on Department mall)");

      await pressSave();
      expect(api.theme).toHaveBeenCalledTimes(1);
      expect(api.theme.mock.calls[0]![0].body).toEqual({
        expectedRevision: 1,
        theme: { ...DEFAULT_STOREFRONT_THEME, tokens: { ...DEFAULT_STOREFRONT_THEME.tokens, typography: "editorial" } },
      });
    });

    it("sets heading size and letters, and resets all three to the template", async () => {
      render(DEFAULT_STOREFRONT_THEME);
      choose("Heading size", "Large");
      choose("Heading letters", "All capitals");
      expect(checked("Heading size")).toBe("Large");
      expect(checked("Heading letters")).toBe("All capitals");
      expect(saveBar()).not.toBeNull();

      act(() => button(card(), "Reset to template default")!.click());
      expect(checked("Heading size")).toBe("Medium");
      expect(checked("Heading letters")).toBe("Sentence case");
      expect(button(card(), "Reset to template default")).toBeUndefined();
      expect(radio("Department mall").getAttribute("aria-checked")).toBe("true");

      choose("Heading size", "Small");
      await pressSave();
      expect(api.theme.mock.calls[0]![0].body.theme.tokens).toEqual({ ...DEFAULT_STOREFRONT_THEME.tokens, typeScale: "flat" });
    });
  });

  it("the Navigation card shows both menu choices with the saved values and saves a new one", async () => {
    const saved = storefrontTemplateTheme("marketplace");
    render(saved);
    let card = [...container.querySelectorAll("h2")]
      .find((heading) => heading.textContent === "Navigation")!.parentElement!;
    while (!card.querySelector("[role=radiogroup]")) card = card.parentElement!;
    const groups = [...card.querySelectorAll<HTMLElement>("[role=radiogroup]")];
    const labelOf = (group: HTMLElement) =>
      container.querySelector(`#${CSS.escape(group.getAttribute("aria-labelledby")!)}`)?.textContent;
    expect(groups.map(labelOf)).toEqual(["On computers", "On phones"]);
    const options = (group: HTMLElement) => [...group.querySelectorAll<HTMLButtonElement>("[role=radio]")];
    const checked = (group: HTMLElement) =>
      options(group).filter((item) => item.getAttribute("aria-checked") === "true").map((item) => item.value);
    expect(options(groups[0]!).map((item) => item.value)).toEqual([
      "dropdown", "cascading", "mega-panel", "drill-in-drawer", "departments-rail", "sticky-category-bar",
    ]);
    expect(options(groups[1]!).map((item) => item.value)).toEqual(["accordion-drawer", "drill-in-drawer", "bottom-tabs"]);
    expect(checked(groups[0]!)).toEqual(["drill-in-drawer"]);
    expect(checked(groups[1]!)).toEqual(["drill-in-drawer"]);
    // The help points to where the menu links are edited; sketches are decorative.
    expect(card.querySelector("a")?.getAttribute("href")).toBe("/admin/online-store/navigation");
    expect(options(groups[0]!).every((item) => item.querySelector("[aria-hidden=true]"))).toBe(true);

    act(() => options(groups[0]!).find((item) => item.value === "mega-panel")!.click());
    act(() => options(groups[1]!).find((item) => item.value === "bottom-tabs")!.click());
    expect(checked(groups[0]!)).toEqual(["mega-panel"]);
    expect(checked(groups[1]!)).toEqual(["bottom-tabs"]);
    // Five flat menu links have no groups for a mega panel: the page says so.
    expect(card.textContent).toContain("Your store shows Dropdown instead. Needs 2 or more navigation groups with two or more links (you have 0).");

    await pressSave();
    expect(api.theme).toHaveBeenCalledTimes(1);
    expect(api.theme.mock.calls[0]![0].body).toEqual({
      expectedRevision: 1,
      theme: {
        ...saved,
        blocks: {
          ...saved.blocks,
          desktopNav: { variant: "mega-panel", settings: { promoImages: false } },
          mobileNav: { variant: "bottom-tabs", settings: { tabs: ["home", "categories", "search", "cart", "account"], drawer: "accordion" } },
        },
      },
    });
  });
});
