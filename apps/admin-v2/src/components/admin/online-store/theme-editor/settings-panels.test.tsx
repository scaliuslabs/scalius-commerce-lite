// @vitest-environment happy-dom

/**
 * The editor's settings panels on their own: the product page's information
 * area and modules, the listing pages' toolbar, filters and grid, the theme
 * settings (colours, fonts, product cards) and the product page's app
 * blocks. Each edit must land in the theme document the editor saves.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useState, type AnchorHTMLAttributes, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_STOREFRONT_THEME,
  storeShapeFromFacts,
  storefrontTemplateTheme,
  storefrontThemeDocumentSchema,
  type StorefrontThemeDocument,
} from "@scalius/shared/storefront-theme";
import type { ThemeApp } from "~/lib/api-query-options/online-store";
import { useMediaPreviews } from "../schema-form/resource-fields";
import { appBlocksByKey, productAppBlocksInvalid, resolveThemeForStore, themeDraftInvalid } from "../theme-settings";
import type { SetTheme } from "../theme-fields";
import { EDITOR_PARTS, moduleId, type EditorPage } from "./editor-pages";
import { PartSettings } from "./SelectionPanes";
import { ThemeSettingsPanel } from "./ThemeSettingsPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fonts = vi.hoisted(() => ({ register: vi.fn() }));
vi.mock("../type-preview-fonts", () => ({ registerTypePreviewFonts: fonts.register }));
vi.mock("~/components/admin/media-manager", () => ({
  MediaManager: ({ trigger }: { trigger: ReactNode }) => <span>{trigger}</span>,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, params: _params, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; params?: unknown; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

type Theme = StorefrontThemeDocument;

let root: Root;
let container: HTMLDivElement;
/** The document as the panels last left it. */
let latest: Theme;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const SHAPE = storeShapeFromFacts({
  productCount: 40,
  skuCount: 60,
  topCategoryCount: 5,
  categoryDepth: 2,
  menu: [{}, {}, {}, {}, {}],
  hasCollections: true,
  hasDeliveryMethods: true,
});

function Harness({ initial, children }: {
  initial: Theme;
  children: (props: { theme: Theme; setDraft: SetTheme; resolved: ReturnType<typeof resolveThemeForStore>; media: ReturnType<typeof useMediaPreviews> }) => ReactNode;
}) {
  const [theme, setTheme] = useState(initial);
  latest = theme;
  const media = useMediaPreviews([]);
  return <>{children({ theme, setDraft: setTheme, resolved: resolveThemeForStore(theme, SHAPE), media })}</>;
}

function render(initial: Theme, children: Parameters<typeof Harness>[0]["children"]) {
  latest = initial;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <Harness initial={initial}>{children}</Harness>
      </QueryClientProvider>,
    );
  });
}

/** One part's settings, as the editor's panel shows them on a page. */
function renderPart(initial: Theme, selected: string, page: EditorPage = { kind: "collection" }, apps: readonly ThemeApp[] = []) {
  render(initial, (props) => (
    <PartSettings selected={selected} page={page} apps={apps} cmsPageId={null} onRemoveLanding={() => {}} {...props} />
  ));
}

/** Theme settings with one group open (the panel opens with its groups closed). */
const renderThemeSettings = (initial: Theme, group: string) => {
  render(initial, (props) => <ThemeSettingsPanel {...props} />);
  const toggle = [...container.querySelectorAll<HTMLButtonElement>("h2 > button[aria-expanded]")].find((each) => each.textContent === group);
  expect(toggle, group).toBeDefined();
  act(() => toggle!.click());
};

const field = <Element extends HTMLElement = HTMLInputElement>(id: string) => container.querySelector<Element>(`#${CSS.escape(id)}`)!;
const radioIn = (scope: ParentNode, value: string) => scope.querySelector<HTMLButtonElement>(`[role=radio][value="${value}"]`)!;
const click = (element: HTMLElement) => act(() => element.click());

function type(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function chooseOption(trigger: HTMLButtonElement, label: string) {
  click(trigger);
  const option = [...document.querySelectorAll<HTMLElement>("[role=option]")].find((each) => each.textContent?.includes(label));
  expect(option, label).toBeDefined();
  click(option!);
}

describe("listing pages", () => {
  it("sets category and search starting views separately", () => {
    const marketplace = storefrontTemplateTheme("marketplace");
    renderPart(marketplace, EDITOR_PARTS.listing, { kind: "search" });
    const control = container.querySelector("[data-listing-default]")!;
    expect(radioIn(control, "grid").getAttribute("aria-checked")).toBe("true");
    expect(control.querySelector("[data-listing-layout-sketch=list]")).not.toBeNull();
    expect(control.textContent).toContain("Search results start as");
    expect(marketplace.blocks.listing.searchLayout).toBe("list");
    click(radioIn(control, "list"));
    // The search choice only offers its own value names: `same` tells the groups apart.
    const searchGrid = control.querySelector("[role=radio][value=same]")!.closest("[role=radiogroup]")!.querySelector<HTMLButtonElement>("[role=radio][value=grid]")!;
    click(searchGrid);
    expect(latest.blocks.listing.layout).toEqual({ variant: "list", settings: {} });
    expect(latest.blocks.listing.searchLayout).toBe("grid");
    expect(latest.blocks.listing.toolbar).toEqual(marketplace.blocks.listing.toolbar);
    expect(latest.tokens).toEqual(marketplace.tokens);
  });

  it("offers the search layout only on search results", () => {
    renderPart(storefrontTemplateTheme("marketplace"), EDITOR_PARTS.listing, { kind: "category" });
    expect(container.querySelector("[role=radio][value=same]")).toBeNull();
    expect(container.textContent).not.toContain("Search results start as");
  });

  it.each(["shelves", "quick-grid"] as const)("previews search with the %s category layout when search follows it", (layout) => {
    const theme = storefrontTemplateTheme("marketplace");
    theme.blocks.listing.layout = layout === "shelves"
      ? { variant: "shelves", settings: { maxShelves: 8, spacing: "standard" } }
      : { variant: "quick-grid", settings: {} };
    theme.blocks.listing.searchLayout = "same";
    renderPart(theme, EDITOR_PARTS.listing, { kind: "search" });
    expect(container.querySelector(`[role=radio][value=same] [data-listing-layout-sketch=${layout}]`)).not.toBeNull();
  });

  it("chooses one card per row on phones, the paging and the grid density", () => {
    renderPart(storefrontTemplateTheme("marketplace"), EDITOR_PARTS.listing);
    const control = container.querySelector("[data-listing-default]")!;
    expect(radioIn(control, "list-row").getAttribute("aria-checked")).toBe("false");
    click(radioIn(control, "list-row"));
    chooseOption(field<HTMLButtonElement>("theme-listing-paging"), "Load more");
    click(radioIn(control, "dense"));
    expect(latest.blocks.listing).toMatchObject({ phoneLayout: "list-row", paging: "load-more", searchLayout: "list" });
    expect(latest.tokens.density).toBe("dense");
  });

  it("lets heritage stores move from category shelves to a list", () => {
    renderPart(storefrontTemplateTheme("heritage-editorial"), EDITOR_PARTS.listing);
    const control = container.querySelector("[data-listing-default]")!;
    expect(control.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toContain("Category shelves");
    click(radioIn(control, "list"));
    expect(latest.blocks.listing.layout).toEqual({ variant: "list", settings: {} });
  });

  it("turns toolbar pieces on at their registry place and off again", () => {
    renderPart(DEFAULT_STOREFRONT_THEME, EDITOR_PARTS.listingToolbar);
    const toggle = field<HTMLButtonElement>("theme-listing-toolbar-grid-list-toggle");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    click(toggle);
    expect(latest.blocks.listing.toolbar).toContain("grid-list-toggle");
    expect(latest.blocks.listing.toolbar.at(-1)).toBe("grid-list-toggle");
    click(field<HTMLButtonElement>("theme-listing-toolbar-breadcrumb"));
    expect(latest.blocks.listing.toolbar).not.toContain("breadcrumb");
  });

  it("lets a Showcase merchant hide quick filter chips and category tabs", () => {
    renderPart(storefrontTemplateTheme("showcase-landing"), EDITOR_PARTS.listingToolbar);
    const chips = field<HTMLButtonElement>("theme-listing-toolbar-facet-value-chips");
    const tabs = field<HTMLButtonElement>("theme-listing-toolbar-subcategory-pills");
    expect(chips.getAttribute("aria-checked")).toBe("true");
    expect(tabs.getAttribute("aria-checked")).toBe("true");
    click(chips);
    click(tabs);
    expect(latest.blocks.listing.toolbar).not.toContain("facet-value-chips");
    expect(latest.blocks.listing.toolbar).not.toContain("subcategory-pills");
    expect(chips.getAttribute("aria-checked")).toBe("false");
  });

  it("places category, collection and brand descriptions above the products", () => {
    renderPart(DEFAULT_STOREFRONT_THEME, EDITOR_PARTS.listingToolbar);
    expect(field("theme-listing-description-placement").textContent).toContain("Below products");
    chooseOption(field<HTMLButtonElement>("theme-listing-description-placement"), "Above products");
    expect(latest.blocks.listing.descriptionPlacement).toBe("above");
  });

  it("replaces the filter drawer with a compact sidebar, which opens its groups", () => {
    const retail = storefrontTemplateTheme("mass-retail");
    renderPart(retail, EDITOR_PARTS.listingFilters);
    const control = container.querySelector("[data-listing-filter-style]")!;
    expect(radioIn(control, "drawer").getAttribute("aria-checked")).toBe("true");
    expect(control.querySelector("[data-listing-filter-sketch=drawer]")).not.toBeNull();
    click(radioIn(control, "sidebar-dense"));
    expect(latest.blocks.listing.filters).toEqual({ style: "sidebar-dense", openByDefault: true, searchPlacement: "same", ruled: false });
    expect(latest.blocks.listing.layout).toEqual(retail.blocks.listing.layout);
    // Only search results may move a sidebar's filters into a drawer.
    expect(field("theme-listing-search-drawer")).toBeNull();
  });

  it("moves a sidebar's filters into a drawer on search results only", () => {
    const theme = storefrontTemplateTheme("mass-retail");
    theme.blocks.listing.filters = { style: "sidebar-dense", openByDefault: true, searchPlacement: "same", ruled: false };
    renderPart(theme, EDITOR_PARTS.listingFilters, { kind: "search" });
    click(field<HTMLButtonElement>("theme-listing-search-drawer"));
    expect(latest.blocks.listing.filters.searchPlacement).toBe("drawer");
  });

  it("orders the filter groups and can restore the template order", () => {
    renderPart(storefrontTemplateTheme("marketplace"), EDITOR_PARTS.listingFilters);
    const control = container.querySelector("[data-listing-filter-order]")!;
    const groups = () => [...control.querySelectorAll("[data-filter-group]")].map((row) => row.getAttribute("data-filter-group"));
    expect(groups()).toEqual(["availability", "rating", "brand", "other", "price", "category"]);
    click(control.querySelector<HTMLButtonElement>("[aria-label='Move Price up']")!);
    expect(groups()).toEqual(["availability", "rating", "brand", "price", "other", "category"]);
    expect(latest.blocks.listing.filters.order).toEqual(groups());
    click([...control.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Use template order")!);
    expect(groups()).toEqual(["availability", "rating", "brand", "other", "price", "category"]);
    expect(latest.blocks.listing.filters.order).toBeUndefined();
  });
});

describe("product page", () => {
  it("moves phone thumbnails beside the photo", () => {
    renderPart(storefrontTemplateTheme("daily-essentials"), EDITOR_PARTS.productMain, { kind: "product" });
    const side = field<HTMLButtonElement>("theme-blocks-product-gallery-settings-phoneSideThumbnails");
    expect(side.getAttribute("aria-checked")).toBe("false");
    click(side);
    expect(latest.blocks.product.gallery).toEqual({ variant: "thumbs-left", settings: { phoneSideThumbnails: true } });
  });

  it.each(["fashion-value", "heritage-editorial"] as const)("adds a Buy now button to %s's purchase panel", (template) => {
    renderPart(storefrontTemplateTheme(template), EDITOR_PARTS.productMain, { kind: "product" });
    const buyNow = field<HTMLButtonElement>("theme-blocks-product-buyBox-settings-showBuyNow");
    expect(buyNow.getAttribute("aria-checked")).toBe("false");
    click(buyNow);
    const box = latest.blocks.product.buyBox;
    expect(box.variant).toBe(template === "fashion-value" ? "fashion" : "heritage");
    expect((box.settings as { showBuyNow?: boolean }).showBuyNow).toBe(true);
  });

  it("turns the sticky bars on and off", () => {
    renderPart(DEFAULT_STOREFRONT_THEME, EDITOR_PARTS.productMain, { kind: "product" });
    const extras = container.querySelector("[data-product-page-extras]")!;
    click(extras.querySelector<HTMLButtonElement>("#theme-sticky-phone-anchor-bar")!);
    // Department mall keeps its phone buy bar; turning it off saves `none`.
    click(extras.querySelector<HTMLButtonElement>("#theme-sticky-phone-buy-bar")!);
    expect(latest.blocks.product.sticky).toEqual({ phoneTop: "anchor-bar", phoneBottom: "none", desktop: "none" });
  });

  it("shows a module below the product at its registry place, from its own settings", () => {
    renderPart(DEFAULT_STOREFRONT_THEME, moduleId("frequently-bought-together"), { kind: "product" });
    expect(container.textContent).toContain("Show on product pages");
    click(field<HTMLButtonElement>("theme-product-module-frequently-bought-together"));
    expect(latest.blocks.product.below).toEqual(["frequently-bought-together", "description", "reviews", "related"]);
  });
});

describe("theme settings", () => {
  it("lets an essentials merchant restore the compact quick-add card", () => {
    const essentials = storefrontTemplateTheme("daily-essentials");
    renderThemeSettings(essentials, "Product cards");
    expect(essentials.blocks.card).toEqual({ variant: "quick-add", settings: { fullAction: true, showBuyNow: false } });
    const groceryCard = radioIn(container, "quick-add");
    expect(groceryCard.querySelectorAll("[data-card-sketch-full-action]")).toHaveLength(2);
    const quick = field<HTMLButtonElement>("theme-blocks-card-settings-fullAction");
    expect(quick.getAttribute("aria-checked")).toBe("true");
    click(quick);
    expect(groceryCard.querySelectorAll("[data-card-sketch-round-action]")).toHaveLength(2);
    expect(latest.blocks.card).toEqual({ variant: "quick-add", settings: { fullAction: false, showBuyNow: false } });
  });

  it("offers the quick action on the retail card without changing its default", () => {
    const retail = storefrontTemplateTheme("mass-retail");
    renderThemeSettings(retail, "Product cards");
    expect(retail.blocks.card.variant).toBe("retail");
    const quick = field<HTMLButtonElement>("theme-blocks-card-settings-quickAction");
    expect(quick.getAttribute("aria-checked")).toBe("false");
    click(quick);
    expect(latest.blocks.card).toEqual({ variant: "retail", settings: { quickAction: true } });
  });

  it("previews and picks the Showcase card with a centered title and price action", () => {
    renderThemeSettings(DEFAULT_STOREFRONT_THEME, "Product cards");
    const choice = radioIn(container, "showcase");
    expect(choice.textContent).toContain("Showcase");
    expect(choice.querySelectorAll("[data-card-sketch-showcase-action]")).toHaveLength(2);
    expect(choice.querySelectorAll("[data-card-sketch-showcase-title]")).toHaveLength(2);
    click(choice);
    expect(latest.blocks.card.variant).toBe("showcase");
    expect(field("theme-blocks-card-settings-quickAction")).toBeNull();
  });

  it("names unreadable text in plain words, and the draft cannot be saved until it is readable", () => {
    renderThemeSettings(DEFAULT_STOREFRONT_THEME, "Colors");
    const buttonText = field("theme-color-button-text");
    type(buttonText, "#5A5A5A");
    expect(buttonText.value).toBe("#5a5a5a");
    expect(buttonText.getAttribute("aria-invalid")).toBe("true");
    const note = container.querySelector(`#${buttonText.getAttribute("aria-describedby")}`);
    expect(note?.textContent).toMatch(/^Button text is hard to read on the button color \(2\.\d:1, needs 4\.5:1\)\.$/);
    expect(themeDraftInvalid(latest)).toBe(true);
    type(buttonText, "#fafafa");
    expect(buttonText.hasAttribute("aria-invalid")).toBe(false);
    expect(themeDraftInvalid(latest)).toBe(false);
  });

  describe("typography", () => {
    const card = () => {
      let node = [...container.querySelectorAll("h2")].find((heading) => heading.textContent === "Typography")!.parentElement!;
      while (!node.querySelector("[role=radiogroup]")) node = node.parentElement!;
      return node;
    };
    const button = (scope: ParentNode, name: string) =>
      [...scope.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === name);
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
    const choose = (label: string, option: string) =>
      click([...group(label).querySelectorAll<HTMLButtonElement>("[role=radio]")].find((item) => name(item) === option)!);
    const checked = (label: string) => {
      const item = [...group(label).querySelectorAll("[role=radio]")].find((each) => each.getAttribute("aria-checked") === "true");
      return item ? name(item) : undefined;
    };
    const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    it("shows the template's fonts as its default and loads no preview font until the picker opens", async () => {
      renderThemeSettings(DEFAULT_STOREFRONT_THEME, "Typography");
      expect(card().textContent).toContain("CleanTemplate default");
      expect(card().textContent).toContain("Inter · Bangla: Noto Sans Bengali");
      expect(checked("Heading size")).toBe("Medium");
      expect(checked("Heading letters")).toBe("Sentence case");
      expect(button(card(), "Reset to template default")).toBeUndefined();
      await flush();
      expect(fonts.register).not.toHaveBeenCalled();
      click(button(card(), "Change")!);
      await flush();
      expect(fonts.register).toHaveBeenCalledTimes(1);
      expect(dialog()!.textContent).toContain("Choose fonts");
    });

    it("lists every pairing drawn in its own fonts, in Latin and Bangla, with the template's preselected", async () => {
      renderThemeSettings(storefrontTemplateTheme("heritage-editorial"), "Typography");
      expect(card().textContent).toContain("HeritageTemplate default");
      expect(checked("Heading letters")).toBe("All capitals");
      click(button(card(), "Change")!);
      await flush();
      expect(pairings().map((item) => item.value)).toEqual(["retail", "market", "editorial", "fresh", "beauty", "heritage", "tech"]);
      const heritage = pairings().find((item) => item.value === "heritage")!;
      expect(heritage.getAttribute("aria-checked")).toBe("true");
      expect(pairings().filter((item) => item.textContent?.includes("Template default"))).toHaveLength(1);
      const sample = heritage.querySelector<HTMLElement>("[aria-hidden=true]")!;
      expect(sample.style.getPropertyValue("--type-heading")).toMatch(/^"Preview Cormorant Garamond", "Preview Noto Serif Bengali"/);
      expect(sample.querySelector("[lang=bn]")?.textContent).toMatch(/[ঀ-৿]/);
    });

    it("picks a new pairing, and cancel keeps the current one", async () => {
      renderThemeSettings(DEFAULT_STOREFRONT_THEME, "Typography");
      click(button(card(), "Change")!);
      await flush();
      click(pairings().find((item) => item.value === "editorial")!);
      click(button(dialog()!, "Cancel")!);
      expect(latest).toEqual(DEFAULT_STOREFRONT_THEME);
      click(button(card(), "Change")!);
      await flush();
      // Reopening starts from the saved choice, not the cancelled one.
      expect(pairings().find((item) => item.getAttribute("aria-checked") === "true")?.value).toBe("retail");
      click(pairings().find((item) => item.value === "editorial")!);
      click(button(dialog()!, "Select")!);
      expect(card().textContent).toContain("Instrument Serif and Inter · Bangla: Noto Serif Bengali");
      expect(latest).toEqual({ ...DEFAULT_STOREFRONT_THEME, tokens: { ...DEFAULT_STOREFRONT_THEME.tokens, typography: "editorial" } });
    });

    it("sets heading size and letters, and resets them to the template", () => {
      renderThemeSettings(DEFAULT_STOREFRONT_THEME, "Typography");
      choose("Heading size", "Large");
      choose("Heading letters", "All capitals");
      expect(checked("Heading size")).toBe("Large");
      click(button(card(), "Reset to template default")!);
      expect(checked("Heading size")).toBe("Medium");
      expect(checked("Heading letters")).toBe("Sentence case");
      expect(latest.tokens).toEqual(DEFAULT_STOREFRONT_THEME.tokens);
      choose("Heading size", "Small");
      expect(latest.tokens).toEqual({ ...DEFAULT_STOREFRONT_THEME.tokens, typeScale: "flat" });
    });
  });
});

describe("product page app blocks", () => {
  type Field = ThemeApp["productBlocks"][number]["settings"][number];
  const setting = (key: string, label: string, extra: Partial<Field> = {}): Field => ({
    key, label, help: null, type: "text", required: false, options: null, default: null,
    min: null, max: null, integer: false, maxLength: null, ...extra,
  });
  const APPS: ThemeApp[] = [{
    id: "acme.reviews",
    name: "Acme Reviews",
    sections: [],
    productBlocks: [
      {
        key: "acme.reviews/stars", type: "stars", name: "Star rating", placement: "buy-box",
        settings: [
          setting("label", "Label", { maxLength: 40, default: "Rated by buyers" }),
          setting("size", "Size", { type: "select", options: [{ value: "small", label: "Small" }, { value: "large", label: "Large" }], default: "small" }),
        ],
      },
      {
        key: "acme.reviews/list", type: "list", name: "Review list", placement: "below",
        settings: [
          setting("count", "Reviews shown", { type: "number", min: 1, max: 20, integer: true, default: 5 }),
          setting("title", "Title", { required: true, maxLength: 60 }),
        ],
      },
    ],
  }];
  const appBlocks = appBlocksByKey(APPS);
  const card = () => container.querySelector<HTMLElement>("[data-product-app-blocks]");
  const items = () => [...container.querySelectorAll<HTMLElement>("[data-app-block]")].map((item) => item.dataset.appBlock);
  const addBlock = async (label: string) => {
    await act(async () => card()!.querySelector<HTMLButtonElement>("button[aria-label='Add app block']")!.click());
    click([...document.querySelectorAll<HTMLButtonElement>("[role=option]")].find((each) => each.textContent?.startsWith(label))!);
  };
  const named = (name: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
  const withBlocks = (apps: NonNullable<Theme["blocks"]["product"]["apps"]>): Theme => ({
    ...DEFAULT_STOREFRONT_THEME,
    blocks: { ...DEFAULT_STOREFRONT_THEME.blocks, product: { ...DEFAULT_STOREFRONT_THEME.blocks.product, apps } },
  });

  it("adds, edits, orders and removes app blocks in the theme document", async () => {
    renderPart(DEFAULT_STOREFRONT_THEME, EDITOR_PARTS.productApps, { kind: "product" }, APPS);
    await act(async () => card()!.querySelector<HTMLButtonElement>("button[aria-label='Add app block']")!.click());
    expect([...document.querySelectorAll("[role=option]")].map((each) => each.textContent)).toEqual([
      "Star rating · Acme Reviews · In the buy box",
      "Review list · Acme Reviews · Below the product",
    ]);
    click(document.querySelector<HTMLButtonElement>("[role=option]")!);
    expect(items()).toEqual(["app"]);
    expect(field("theme-product-app-app-label").value).toBe("Rated by buyers");

    await addBlock("Review list");
    expect(items()).toEqual(["app", "app-2"]);
    // The list's required title has no default: the draft is invalid until it is written.
    expect(container.querySelector("#theme-product-app-app-2-title-note")?.textContent).toBe("Fill this in.");
    expect(productAppBlocksInvalid(latest, appBlocks)).toBe(true);
    type(field("theme-product-app-app-2-title"), "What buyers say");

    click(named("Move Review list up"));
    expect(items()).toEqual(["app-2", "app"]);
    expect(named("Move Review list up").disabled).toBe(true);
    click(named("Remove Star rating"));
    await addBlock("Star rating");
    expect(items()).toEqual(["app-2", "app"]);

    expect(latest.blocks.product.apps).toEqual([
      { id: "app-2", app: "acme.reviews/list", values: { count: 5, title: "What buyers say" } },
      { id: "app", app: "acme.reviews/stars", values: { label: "Rated by buyers", size: "small" } },
    ]);
    expect(productAppBlocksInvalid(latest, appBlocks)).toBe(false);
    expect(storefrontThemeDocumentSchema.safeParse(latest).success).toBe(true);
  });

  it("keeps a block whose app is not active until it is removed, then drops the block list", () => {
    renderPart(withBlocks([{ id: "badge", app: "acme.gone/badge", values: { text: "Bestseller" } }]), EDITOR_PARTS.productApps, { kind: "product" });
    const badge = container.querySelector("[data-app-block='badge']")!;
    expect(badge.textContent).toContain("acme.gone/badge");
    expect(badge.textContent).toContain("App not active. Hidden on your store.");
    expect(card()!.querySelector("button[aria-label='Add app block']")).toBeNull();
    click(named("Remove acme.gone/badge"));
    expect("apps" in latest.blocks.product).toBe(false);
    expect(storefrontThemeDocumentSchema.safeParse(latest).success).toBe(true);
  });

  it("stops adding at the product page's block limit", () => {
    const ten = Array.from({ length: 10 }, (_, index) => ({ id: `stars-${index}`, app: "acme.reviews/stars", values: {} }));
    renderPart(withBlocks(ten), EDITOR_PARTS.productApps, { kind: "product" }, APPS);
    expect(card()!.querySelector<HTMLButtonElement>("button[aria-label='Add app block']")!.disabled).toBe(true);
    expect(card()!.textContent).toContain("A product page shows up to 10 app blocks.");
  });
});
