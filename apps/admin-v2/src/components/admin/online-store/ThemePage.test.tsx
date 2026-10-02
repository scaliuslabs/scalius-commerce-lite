// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, Suspense } from "react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_STOREFRONT_THEME,
  storeShapeFromFacts,
  storefrontSectionDefault,
  storefrontTemplateTheme,
  storefrontThemeDocumentSchema,
  type StorefrontThemeDocument,
} from "@scalius/shared/storefront-theme";
import {
  themeWorkspaceQueryOptions,
  type ThemeWorkspaceDocument,
} from "~/lib/api-query-options/online-store";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import { ThemePage } from "./ThemePage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ draft: vi.fn(), publish: vi.fn() }));
/** Endpoints the Theme page must never call: its one Save writes the theme draft only. */
const others = vi.hoisted(() => ({
  header: vi.fn(),
  footer: vi.fn(),
  homepagePresentation: vi.fn(),
  heroSliders: vi.fn(),
  heroSlider: vi.fn(),
  business: vi.fn(),
}));
const fonts = vi.hoisted(() => ({ register: vi.fn() }));
/** The files the next pick from Files returns (several for a multi-select picker). */
const files = vi.hoisted(() => ({ next: [] as Array<{ id: string; url: string; altText?: string }> }));

vi.mock("./type-preview-fonts", () => ({ registerTypePreviewFonts: fonts.register }));
vi.mock("./ThemePreviewAction", () => ({ ThemePreviewAction: ({ draftRevision }: { draftRevision: number }) => <section data-draft-revision={draftRevision}><h2>Storefront preview</h2></section> }));

vi.mock("~/lib/api", () => ({ apiData: (call: unknown) => call }));
vi.mock("@scalius/api-client/sdk", () => ({
  getApiV1AdminSettingsThemeWorkspace: vi.fn(),
  postApiV1AdminSettingsThemeDraft: api.draft,
  postApiV1AdminSettingsThemePublish: api.publish,
  getApiV1AdminCategoriesFormOptions: vi.fn(async () => ({
    categories: [{ id: "cat_honey", name: "Honey", status: "published" }, { id: "cat_ghee", name: "Ghee", status: "published" }],
  })),
  getApiV1AdminCollections: vi.fn(async () => ({ collections: [], pagination: { page: 1, totalPages: 1 } })),
  getApiV1AdminCollectionsByIds: vi.fn(async () => ({ collections: [] })),
  getApiV1AdminDiscounts: vi.fn(async () => ({ discounts: [] })),
  getApiV1AdminProducts: vi.fn(async () => ({
    products: [{ id: "prod_honey", name: "Sundarban honey" }, { id: "prod_ghee", name: "Cow ghee" }],
    pagination: { page: 1, totalPages: 1 },
  })),
  getApiV1AdminProductsByIds: vi.fn(async ({ query }: { query: { ids: string } }) => ({
    products: [{ id: "prod_honey", name: "Sundarban honey" }].filter((product) => query.ids.split(",").includes(product.id)),
  })),
  postApiV1AdminSettingsHeader: others.header,
  postApiV1AdminSettingsFooter: others.footer,
  postApiV1AdminSettingsHomepagePresentation: others.homepagePresentation,
  postApiV1AdminSettingsHeroSliders: others.heroSliders,
  putApiV1AdminSettingsHeroSlidersById: others.heroSlider,
  postApiV1AdminSettingsBusiness: others.business,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("~/components/admin/shared/UnsavedChangesGuard", () => ({ UnsavedChangesGuard: () => null }));
vi.mock("~/components/admin/media-manager", () => ({
  MediaManager: ({ trigger, onSelect, onSelectMultiple }: {
    trigger: ReactNode;
    onSelect?: (file: unknown) => void;
    onSelectMultiple?: (files: unknown[]) => void;
  }) => (
    <span onClickCapture={() => (onSelectMultiple ? onSelectMultiple(files.next) : onSelect?.(files.next[0]))}>{trigger}</span>
  ),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  api.draft.mockImplementation(async ({ body }: { body: { theme: StorefrontThemeDocument } }) => ({
    theme: body.theme,
    revision: 2,
    basePublishedRevision: 1,
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

type WorkspaceRecords = Pick<ThemeWorkspaceDocument, "published" | "draft">;

type WorkspaceMedia = Array<{ id: string; url: string; alt: string; width: number | null; height: number | null }>;

function render(
  theme: StorefrontThemeDocument,
  storeShape = SHAPE,
  workspace: WorkspaceRecords = {
    published: { theme, revision: 1 },
    draft: { theme, revision: 1, basePublishedRevision: 1 },
  },
  media: WorkspaceMedia = [],
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  queryClient.setQueryData(themeWorkspaceQueryOptions().queryKey, { ...workspace, storeShape, media } as unknown as ThemeWorkspaceDocument);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <Suspense fallback={null}>
          <ThemePage />
        </Suspense>
      </QueryClientProvider>,
    );
  });
  return queryClient;
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

function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  act(() => {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Types into a field, then leaves it (links settle into their canonical form on leaving). */
function typeAndLeave(input: HTMLInputElement, value: string) {
  act(() => input.focus());
  type(input, value);
  act(() => input.blur());
}

const field = <Element extends HTMLElement = HTMLInputElement>(id: string) => document.querySelector<Element>(`#${CSS.escape(id)}`)!;
const buttonIn = (id: string, name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>(`#${CSS.escape(id)} button`)].find((button) => button.textContent === name)!;
const buttonNamed = (name: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)
  ?? [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === name)!;

function choose(trigger: HTMLButtonElement, label: string) {
  act(() => trigger.click());
  const option = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
    .find((item) => item.textContent?.trim().startsWith(label));
  expect(option).toBeDefined();
  act(() => option!.click());
}

/** Picks an option a select loads from the server or a query. */
async function chooseLoaded(trigger: HTMLButtonElement, label: string) {
  await act(async () => trigger.click());
  const option = await vi.waitFor(() => {
    const found = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
      .find((item) => item.textContent?.trim() === label);
    expect(found).toBeDefined();
    return found!;
  });
  await act(async () => option.click());
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const homeModeRadio = (value: "sections" | "product") =>
  container.querySelector<HTMLButtonElement>(`[role=radiogroup][aria-label="Homepage"] [role=radio][value="${value}"]`)!;

const SLIDE = { image: "media_slide", focalPoint: { x: 50, y: 50 }, alt: "Honey jars", link: "/collections/eid" };

/** The theme with its category tiles naming these categories. */
function withCategoryTiles(theme: StorefrontThemeDocument, categoryIds: string[]): StorefrontThemeDocument {
  return {
    ...theme,
    pages: {
      ...theme.pages,
      home: theme.pages.home.map((section) =>
        section.type === "category-tiles" ? { ...section, settings: { ...section.settings, categoryIds } } : section),
    },
  };
}

/** The theme with the merchant's content: a logo, the bar's and footer's words, a slide and a one-product homepage. */
function withContent(theme: StorefrontThemeDocument): StorefrontThemeDocument {
  return {
    ...theme,
    brand: { ...theme.brand, logo: "media_logo" },
    blocks: {
      ...theme.blocks,
      topBar: { variant: "utility", settings: { text: "Eid sale", link: "/collections/eid" } },
      footer: { ...theme.blocks.footer, settings: { ...theme.blocks.footer.settings, tagline: "Pure honey" } },
    } as StorefrontThemeDocument["blocks"],
    pages: {
      homeMode: { kind: "product", productId: "prod_honey" },
      home: theme.pages.home.map((section) =>
        section.type === "hero" ? { ...section, settings: { ...section.settings, slides: [SLIDE] } } : section),
    },
  };
}

describe("theme page", () => {
  it("shows one card per choice, with the saved template selected", () => {
    render(DEFAULT_STOREFRONT_THEME);
    expect(headings()).toEqual([
      "Storefront preview",
      "Template",
      "Logo",
      "Colors",
      "Typography",
      "Header",
      "Navigation",
      "Footer",
      "Product cards",
      "Listing default",
      "Filters on computers",
      "Density",
      "Product page",
      "Purchase panel",
      "More on the product page",
      "Homepage",
      "Homepage sections",
    ]);
    expect(radio("Department mall").getAttribute("aria-checked")).toBe("true");
    expect(radio("Fashion value").getAttribute("aria-checked")).toBe("false");
    // Previews are decorative; the radio's text names the choice.
    expect(radio("Fashion value").querySelector("[aria-hidden=true]")).not.toBeNull();
    // All ten templates are offered.
    const templates = container.querySelector("[role=radiogroup]")!;
    expect(templates.querySelectorAll("[role=radio]")).toHaveLength(10);
    expect(radio("Department tiles").getAttribute("aria-checked")).toBe("true");
    expect(saveBar()).toBeNull();
  });

  it("previews Marketplace category grids and search rows in its own colors", () => {
    render(DEFAULT_STOREFRONT_THEME);
    const marketplace = radio("Marketplace").querySelector<HTMLElement>("[data-marketplace-preview]")!;
    expect(marketplace.style.getPropertyValue("--sk-purchase"))
      .toBe(storefrontTemplateTheme("marketplace").tokens.colors.accent);
    expect(marketplace.querySelector("[data-marketplace-header]")!.className).toContain("bg-(--sk-ink)");
    expect(marketplace.querySelector("[data-marketplace-category-grid]")?.children).toHaveLength(4);
    expect(marketplace.querySelector("[data-marketplace-search-list]")).not.toBeNull();
    expect(marketplace.querySelectorAll("[data-marketplace-result-row]")).toHaveLength(2);
    expect(radio("Marketplace").textContent).toContain("Category and deal cards start in a grid; search starts in a list.");
    expect(radio("Department mall").querySelector("[data-marketplace-preview]")).toBeNull();
    expect(radio("Department mall").querySelectorAll(".max-w-11")).toHaveLength(3);
  });

  it("saves the header link source in the private draft used by preview", async () => {
    const saved = storefrontTemplateTheme("marketplace");
    const queryClient = render(saved);
    const source = container.querySelector<HTMLButtonElement>("#theme-navigation-source")!;
    expect(source.textContent).toContain("Categories and custom links");
    act(() => source.click());
    const choices = [...document.querySelectorAll<HTMLElement>("[role=option]")];
    expect(choices.map((choice) => choice.textContent?.split(" · ")[0])).toEqual([
      "Custom menu", "Published categories", "Categories and custom links",
    ]);
    act(() => choices[1]!.click());
    expect(source.textContent).toContain("Published categories");
    await pressSave();
    expect(api.draft.mock.calls[0]![0].body.theme.blocks.navigation.source).toBe("category-tree");
    expect(queryClient.getQueryData<ThemeWorkspaceDocument>(themeWorkspaceQueryOptions().queryKey)?.draft.theme.blocks.navigation.source)
      .toBe("category-tree");
    expect(container.querySelector("[data-draft-revision]")?.getAttribute("data-draft-revision")).toBe("2");
  });

  it("saves a chosen grocery template with its merchant defaults", async () => {
    render(DEFAULT_STOREFRONT_THEME);
    act(() => radio("Daily essentials").click());
    await pressSave();
    const saved = api.draft.mock.calls[0]![0].body.theme as StorefrontThemeDocument;
    expect(saved.template).toBe("daily-essentials");
    expect(saved.blocks.card).toEqual({ variant: "quick-add", settings: { fullAction: true, showBuyNow: false } });
  });

  it("saves privately, then publishes only the saved revision after confirmation", async () => {
    const queryClient = render(DEFAULT_STOREFRONT_THEME);
    const fashion = storefrontTemplateTheme("fashion-value");
    const publishButton = () => [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Publish theme")!;
    expect(publishButton().disabled).toBe(true);

    act(() => radio("Fashion value").click());
    expect(publishButton().disabled).toBe(true);
    await pressSave();
    expect(api.draft.mock.calls[0]![0].body).toEqual({
      theme: fashion, expectedDraftRevision: 1, basePublishedRevision: 1,
    });
    expect(api.publish).not.toHaveBeenCalled();
    expect(queryClient.getQueryData<ThemeWorkspaceDocument>(themeWorkspaceQueryOptions().queryKey)?.published.theme)
      .toEqual(DEFAULT_STOREFRONT_THEME);
    expect(container.textContent).toContain("Draft saved. Your storefront still shows the live theme.");

    api.publish.mockResolvedValue({
      published: { theme: fashion, revision: 2 },
      draft: { theme: fashion, revision: 3, basePublishedRevision: 2 },
    });
    act(() => publishButton().click());
    expect(document.querySelector("[role=alertdialog]")?.textContent).toContain("Publish this saved theme?");
    await act(async () => {
      [...document.querySelectorAll<HTMLButtonElement>("[role=alertdialog] button")]
        .find((button) => button.textContent === "Publish theme")!.click();
    });
    expect(api.publish.mock.calls[0]![0].body).toEqual({ expectedPublishedRevision: 1, expectedDraftRevision: 2 });
    expect(queryClient.getQueryData<ThemeWorkspaceDocument>(themeWorkspaceQueryOptions().queryKey)?.published.theme)
      .toEqual(fashion);
  });

  it("keeps unsaved edits after another session changes the draft", async () => {
    render(DEFAULT_STOREFRONT_THEME);
    act(() => radio("Fashion value").click());
    api.draft.mockRejectedValueOnce(new AdminApiResponseError("Draft changed", 409, "CONFLICT"));
    await pressSave();
    expect(radio("Fashion value").getAttribute("aria-checked")).toBe("true");
    expect(saveBar()).not.toBeNull();
    expect(api.publish).not.toHaveBeenCalled();
  });

  it("offers publishing as the only workflow action: a draft is always based on the live theme", () => {
    const published = storefrontTemplateTheme("boutique");
    const draft = storefrontTemplateTheme("marketplace");
    render(published, SHAPE, {
      published: { theme: published, revision: 2 },
      draft: { theme: draft, revision: 4, basePublishedRevision: 2 },
    });
    const actions = [...container.querySelectorAll<HTMLButtonElement>("button")].map((button) => button.textContent);
    expect(actions).toContain("Publish theme");
    expect(actions).not.toContain("Use current live version");
    expect(container.textContent).toContain("Draft saved. Your storefront still shows the live theme.");
    expect(container.textContent).not.toContain("The live theme changed since this draft started.");
  });

  it("says Draft saved after every save: logo and words are part of the draft too", async () => {
    const { toast } = await import("sonner");
    render(DEFAULT_STOREFRONT_THEME);
    act(() => radio("Fashion value").click());
    await pressSave();
    expect(toast.success).toHaveBeenLastCalledWith("Draft saved");

    type(field("theme-footer-tagline"), "Pure honey");
    await pressSave();
    expect(api.draft).toHaveBeenCalledTimes(2);
    expect(toast.success).toHaveBeenLastCalledWith("Draft saved");
    expect(container.textContent).not.toContain("save live");
  });

  it("keeps the store shape and section images from the workspace after publishing", async () => {
    const queryClient = render(DEFAULT_STOREFRONT_THEME);
    const fashion = storefrontTemplateTheme("fashion-value");
    act(() => radio("Fashion value").click());
    await pressSave();
    api.publish.mockResolvedValue({
      published: { theme: fashion, revision: 2 },
      draft: { theme: fashion, revision: 3, basePublishedRevision: 2 },
    });
    act(() => [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Publish theme")!.click());
    await act(async () => {
      [...document.querySelectorAll<HTMLButtonElement>("[role=alertdialog] button")]
        .find((button) => button.textContent === "Publish theme")!.click();
    });
    expect(queryClient.getQueryData<ThemeWorkspaceDocument>(themeWorkspaceQueryOptions().queryKey)).toMatchObject({
      published: { theme: fashion, revision: 2 },
      draft: { revision: 3, basePublishedRevision: 2 },
      storeShape: SHAPE,
      media: [],
    });
  });

  it("previews the images the saved draft's sections name", () => {
    const draft: StorefrontThemeDocument = {
      ...DEFAULT_STOREFRONT_THEME,
      pages: {
        home: [{
          id: "story",
          type: "editorial",
          version: 1,
          settings: { layout: "image-with-text", heading: "Our story", body: "", mediaId: "media_draft", imageSide: "start" },
        }],
        homeMode: { kind: "sections" },
      },
    } as StorefrontThemeDocument;
    render(DEFAULT_STOREFRONT_THEME, SHAPE, {
      published: { theme: DEFAULT_STOREFRONT_THEME, revision: 1 },
      draft: { theme: draft, revision: 2, basePublishedRevision: 1 },
    }, [{ id: "media_draft", url: "https://cdn.example.com/story.jpg", alt: "", width: 1200, height: 800 }]);
    act(() => container.querySelector<HTMLButtonElement>("[aria-label='Edit Our story']")!.click());
    expect(document.querySelector<HTMLImageElement>("[role=dialog] img")?.getAttribute("src"))
      .toContain("story.jpg");
  });

  it("lets a Marketplace merchant set category and search starting views separately", async () => {
    const marketplace = storefrontTemplateTheme("marketplace");
    render(marketplace);
    const control = container.querySelector("[data-listing-default]")!;
    const grid = [...control.querySelectorAll<HTMLButtonElement>("[role=radio]")].find((item) => item.textContent?.startsWith("Grid"))!;
    const list = [...control.querySelectorAll<HTMLButtonElement>("[role=radio]")].find((item) => item.textContent?.startsWith("List"))!;

    expect(marketplace.blocks.listing.layout.variant).toBe("grid");
    expect(grid.getAttribute("aria-checked")).toBe("true");
    expect(list.getAttribute("aria-checked")).toBe("false");
    expect(control.querySelector("[data-listing-layout-sketch=grid]")).not.toBeNull();
    expect(control.querySelector("[data-listing-layout-sketch=list]")).not.toBeNull();
    expect(control.textContent).toContain("Search results start as");
    expect(marketplace.blocks.listing.searchLayout).toBe("list");

    act(() => list.click());
    const searchGrid = control.querySelectorAll("[role=radiogroup]")[1]!.querySelector<HTMLButtonElement>('[role=radio][value="grid"]')!;
    act(() => searchGrid.click());
    expect(list.getAttribute("aria-checked")).toBe("true");
    await pressSave();
    const saved = api.draft.mock.calls[0]![0].body.theme as StorefrontThemeDocument;
    expect(saved.blocks.listing.layout).toEqual({ variant: "list", settings: {} });
    expect(saved.blocks.listing.searchLayout).toBe("grid");
    expect(saved.blocks.listing.toolbar).toEqual(marketplace.blocks.listing.toolbar);
    expect(saved.tokens).toEqual(marketplace.tokens);
  });

  it.each(["shelves", "quick-grid"] as const)("previews search using the selected %s category layout", (layout) => {
    const theme = storefrontTemplateTheme("marketplace");
    theme.blocks.listing.layout = layout === "shelves"
      ? { variant: "shelves", settings: { maxShelves: 8, spacing: "standard" } }
      : { variant: "quick-grid", settings: {} };
    theme.blocks.listing.searchLayout = "same";
    render(theme);
    const searchChoices = container.querySelector("[data-listing-default]")?.querySelectorAll("[role=radiogroup]")[1];
    expect(searchChoices?.querySelector(`[role=radio][value=same] [data-listing-layout-sketch=${layout}]`)).not.toBeNull();
  });

  it("lets a Department mall merchant offer grid and list views to shoppers", async () => {
    render(DEFAULT_STOREFRONT_THEME);
    const control = container.querySelector("[data-listing-default]")!;
    expect(control.querySelector("#theme-listing-view-toggle")?.getAttribute("aria-checked")).toBe("false");
    act(() => (control.querySelector("#theme-listing-view-toggle") as HTMLButtonElement).click());
    await pressSave();
    const saved = api.draft.mock.calls[0]![0].body.theme as StorefrontThemeDocument;
    expect(saved.blocks.listing.layout.variant).toBe("grid");
    expect(saved.blocks.listing.toolbar).toContain("grid-list-toggle");
  });

  it("lets a Showcase merchant hide quick filter chips in the saved draft", async () => {
    render(storefrontTemplateTheme("showcase-landing"));
    const chips = container.querySelector<HTMLButtonElement>("#theme-listing-facet-chips")!;
    expect(chips.getAttribute("aria-checked")).toBe("true");
    act(() => chips.click());
    await pressSave();
    const saved = api.draft.mock.calls[0]![0].body.theme as StorefrontThemeDocument;
    expect(saved.blocks.listing.toolbar).not.toContain("facet-value-chips");
    expect(container.querySelector("#theme-listing-facet-chips")?.getAttribute("aria-checked")).toBe("false");
  });

  it("lets a Showcase merchant hide category tabs in the saved draft", async () => {
    render(storefrontTemplateTheme("showcase-landing"));
    const tabs = container.querySelector<HTMLButtonElement>("#theme-listing-category-tabs")!;
    expect(tabs.getAttribute("aria-checked")).toBe("true");
    act(() => tabs.click());
    await pressSave();
    const saved = api.draft.mock.calls[0]![0].body.theme as StorefrontThemeDocument;
    expect(saved.blocks.listing.toolbar).not.toContain("subcategory-pills");
  });

  it("shows quick filter chip settings only with the tab strip (Showcase's link style)", () => {
    render(storefrontTemplateTheme("marketplace"));
    expect(container.querySelector("#theme-listing-facet-chips")).toBeNull();
    expect(container.querySelector("#theme-listing-category-tabs")).toBeNull();
  });

  it("shows the tab strip's settings on any theme that uses the tab strip", () => {
    // The controls follow the document's setting, not the template it is based on.
    const tabbed = storefrontTemplateTheme("marketplace");
    tabbed.blocks.listing.links = "tabs";
    render(tabbed);
    expect(container.querySelector("#theme-listing-category-tabs")).not.toBeNull();
  });

  it("turns product page extras and sticky bars on in the saved draft", async () => {
    render(DEFAULT_STOREFRONT_THEME);
    const extras = container.querySelector("[data-product-page-extras]")!;
    const bundle = extras.querySelector<HTMLButtonElement>("#theme-product-module-frequently-bought-together")!;
    expect(bundle.getAttribute("aria-checked")).toBe("false");
    act(() => bundle.click());
    act(() => extras.querySelector<HTMLButtonElement>("#theme-product-module-policies")!.click());
    act(() => extras.querySelector<HTMLButtonElement>("#theme-sticky-phone-anchor-bar")!.click());
    // Department mall keeps its phone buy bar; turning it off saves `none`.
    act(() => extras.querySelector<HTMLButtonElement>("#theme-sticky-phone-buy-bar")!.click());
    await pressSave();
    const saved = api.draft.mock.calls[0]![0].body.theme as StorefrontThemeDocument;
    expect(saved.blocks.product.below).toEqual(["frequently-bought-together", "description", "reviews", "policies", "related"]);
    expect(saved.blocks.product.sticky).toEqual({ phoneTop: "anchor-bar", phoneBottom: "none", desktop: "none" });
  });

  it("lets a merchant choose one card per row on phones", async () => {
    render(storefrontTemplateTheme("marketplace"));
    const control = container.querySelector("[data-listing-default]")!;
    const phoneRows = control.querySelector<HTMLButtonElement>('[role=radio][value="list-row"]')!;
    expect(phoneRows.getAttribute("aria-checked")).toBe("false");
    act(() => phoneRows.click());
    await pressSave();
    const saved = api.draft.mock.calls[0]![0].body.theme as StorefrontThemeDocument;
    expect(saved.blocks.listing.phoneLayout).toBe("list-row");
    expect(saved.blocks.listing.searchLayout).toBe("list");
  });

  it("saves description placement for category, collection and brand pages", async () => {
    render(DEFAULT_STOREFRONT_THEME);
    const placement = container.querySelector<HTMLButtonElement>("#theme-listing-description-placement")!;
    expect(placement.textContent).toContain("Below products");
    act(() => placement.click());
    const above = [...document.querySelectorAll<HTMLElement>("[role=option]")]
      .find((option) => option.textContent?.includes("Above products"))!;
    act(() => above.click());
    await pressSave();
    expect(api.draft.mock.calls[0]![0].body.theme.blocks.listing.descriptionPlacement).toBe("above");
  });

  it.each([
    ["heritage-editorial", "Category shelves"],
  ] as const)("lets %s stores choose card or list layouts", async (template, selected) => {
    render(storefrontTemplateTheme(template));
    const control = container.querySelector("[data-listing-default]")!;
    expect(control.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toContain(selected);
    expect(control.querySelector("#theme-listing-view-toggle")).not.toBeNull();
    const list = [...control.querySelectorAll<HTMLButtonElement>("[role=radio]")].find((item) => item.textContent?.startsWith("List"))!;
    act(() => list.click());
    await pressSave();
    const saved = api.draft.mock.calls[0]![0].body.theme as StorefrontThemeDocument;
    expect(saved.blocks.listing.layout).toEqual({ variant: "list", settings: {} });
  });

  it("lets an essentials merchant restore the compact quick-add card", async () => {
    const essentials = storefrontTemplateTheme("daily-essentials");
    render(essentials);
    expect(essentials.blocks.listing.layout.variant).toBe("grid");
    expect(essentials.blocks.card).toEqual({ variant: "quick-add", settings: { fullAction: true, showBuyNow: false } });
    expect(radio("Daily essentials").querySelectorAll("[data-card-sketch-full-action]")).toHaveLength(3);
    const groceryCard = container.querySelector<HTMLButtonElement>('[role="radio"][value="quick-add"]')!;
    expect(groceryCard.querySelectorAll("[data-card-sketch-full-action]")).toHaveLength(2);
    const quick = container.querySelector<HTMLButtonElement>("#theme-essentials-full-action")!;
    expect(quick.getAttribute("aria-checked")).toBe("true");
    act(() => quick.click());
    expect(groceryCard.querySelectorAll("[data-card-sketch-round-action]")).toHaveLength(2);
    await pressSave();
    const saved = api.draft.mock.calls[0]![0].body.theme as StorefrontThemeDocument;
    expect(saved.blocks.card).toEqual({ variant: "quick-add", settings: { fullAction: false, showBuyNow: false } });
  });

  it("lets an essentials merchant move phone thumbnails beside the photo", async () => {
    render(storefrontTemplateTheme("daily-essentials"));
    const side = container.querySelector<HTMLButtonElement>("#theme-gallery-phone-side")!;
    expect(side.getAttribute("aria-checked")).toBe("false");
    act(() => side.click());
    await pressSave();
    const saved = api.draft.mock.calls[0]![0].body.theme as StorefrontThemeDocument;
    expect(saved.blocks.product.gallery).toEqual({ variant: "thumbs-left", settings: { phoneSideThumbnails: true } });
  });

  it.each(["fashion-value", "heritage-editorial"] as const)("lets %s merchants add a Buy now button to the product page", async (template) => {
    render(storefrontTemplateTheme(template));
    const buyNow = container.querySelector<HTMLButtonElement>("#theme-product-buy-now")!;
    expect(buyNow.getAttribute("aria-checked")).toBe("false");
    act(() => buyNow.click());
    await pressSave();
    const saved = api.draft.mock.calls[0]![0].body.theme as StorefrontThemeDocument;
    const box = saved.blocks.product.buyBox;
    expect(box.variant).toBe(template === "fashion-value" ? "fashion" : "heritage");
    if (box.variant !== "fashion" && box.variant !== "heritage") throw new Error("wrong purchase panel");
    expect(box.settings.showBuyNow).toBe(true);
  });

  it.each(["shelves", "quick-grid"] as const)("keeps the shopper grid/list switch for search when choosing %s", async (layout) => {
    render(storefrontTemplateTheme("marketplace"));
    const control = container.querySelector("[data-listing-default]")!;
    const choice = control.querySelector<HTMLButtonElement>(`[role=radio][value="${layout}"]`)!;
    act(() => choice.click());
    expect(control.querySelector("#theme-listing-view-toggle")?.getAttribute("aria-checked")).toBe("true");
    await pressSave();
    const saved = api.draft.mock.calls[0]![0].body.theme as StorefrontThemeDocument;
    expect(saved.blocks.listing.layout.variant).toBe(layout);
    expect(saved.blocks.listing.toolbar).toContain("grid-list-toggle");
  });

  it("lets a mass-retail merchant replace the filter drawer with a category sidebar", async () => {
    const retail = storefrontTemplateTheme("mass-retail");
    render(retail);
    const control = container.querySelector("[data-listing-filter-style]")!;
    const drawer = [...control.querySelectorAll<HTMLButtonElement>("[role=radio]")].find((item) => item.textContent?.startsWith("Filter drawer"))!;
    const sidebar = [...control.querySelectorAll<HTMLButtonElement>("[role=radio]")].find((item) => item.textContent?.startsWith("Compact sidebar"))!;
    expect(drawer.getAttribute("aria-checked")).toBe("true");
    expect(control.querySelector("[data-listing-filter-sketch=drawer]")).not.toBeNull();
    act(() => sidebar.click());
    await pressSave();
    const saved = api.draft.mock.calls[0]![0].body.theme as StorefrontThemeDocument;
    expect(saved.blocks.listing.filters).toEqual({ style: "sidebar-dense", openByDefault: true, searchPlacement: "same", ruled: false });
    expect(saved.blocks.listing.layout).toEqual(retail.blocks.listing.layout);
  });

  it("saves a merchant filter order in the theme draft and can restore the template order", async () => {
    render(storefrontTemplateTheme("marketplace"));
    const control = container.querySelector("[data-listing-filter-order]")!;
    const groups = () => [...control.querySelectorAll("[data-filter-group]")].map((row) => row.getAttribute("data-filter-group"));
    expect(groups()).toEqual(["availability", "rating", "brand", "other", "price", "category"]);
    act(() => control.querySelector<HTMLButtonElement>("[aria-label='Move Price up']")!.click());
    expect(groups()).toEqual(["availability", "rating", "brand", "price", "other", "category"]);
    await pressSave();
    const saved = api.draft.mock.calls[0]![0].body.theme as StorefrontThemeDocument;
    expect(saved.blocks.listing.filters.order).toEqual(groups());
    act(() => [...control.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Use template order")!.click());
    expect(groups()).toEqual(["availability", "rating", "brand", "other", "price", "category"]);
    await pressSave();
    expect((api.draft.mock.calls[1]![0].body.theme as StorefrontThemeDocument).blocks.listing.filters.order).toBeUndefined();
  });

  it("offers the quick action on the retail card without changing its default", async () => {
    const retail = storefrontTemplateTheme("mass-retail");
    render(retail);
    expect(retail.blocks.card.variant).toBe("retail");
    const quick = container.querySelector<HTMLButtonElement>("#theme-retail-quick-action")!;
    expect(quick.getAttribute("aria-checked")).toBe("false");
    act(() => quick.click());
    await pressSave();
    const saved = api.draft.mock.calls[0]![0].body.theme as StorefrontThemeDocument;
    expect(saved.blocks.card).toEqual({ variant: "retail", settings: { quickAction: true } });
  });

  it("previews and saves the Showcase card with a centered title and price action", async () => {
    render(DEFAULT_STOREFRONT_THEME);
    const choice = container.querySelector<HTMLButtonElement>('[role="radio"][value="showcase"]')!;
    expect(choice.textContent).toContain("Showcase");
    expect(choice.querySelectorAll("[data-card-sketch-showcase-action]")).toHaveLength(2);
    expect(choice.querySelectorAll("[data-card-sketch-showcase-title]")).toHaveLength(2);
    act(() => choice.click());
    await pressSave();
    expect((api.draft.mock.calls[0]![0].body.theme as StorefrontThemeDocument).blocks.card.variant).toBe("showcase");
  });

  it("starts Showcase with its dedicated product card", () => {
    render(storefrontTemplateTheme("showcase-landing"));
    expect(container.querySelector('[role="radio"][value="showcase"]')?.getAttribute("aria-checked")).toBe("true");
    expect(container.querySelector("#theme-boutique-quick-action")).toBeNull();
  });

  it("selecting a template sets and saves the whole document", async () => {
    render(DEFAULT_STOREFRONT_THEME);
    act(() => radio("Fashion value").click());
    expect(radio("Fashion value").getAttribute("aria-checked")).toBe("true");

    await pressSave();
    expect(api.draft).toHaveBeenCalledTimes(1);
    expect(api.draft.mock.calls[0]![0].body).toEqual({
      expectedDraftRevision: 1,
      basePublishedRevision: 1,
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
    // Layout choices are replaced; the merchant's content stays.
    expect(dialog?.textContent).toContain("Your logo, words, banner slides and chosen categories and collections stay.");
    // Cancelling keeps the changed theme.
    act(() => [...dialog!.querySelectorAll("button")].find((button) => button.textContent === "Cancel")!.click());
    expect(container.textContent).toContain("Changed (based on Fashion value)");

    act(() => radio("Department mall").click());
    act(() => [...document.querySelectorAll("[role=alertdialog] button")]
      .find((button) => button.textContent === "Replace")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(radio("Department mall").getAttribute("aria-checked")).toBe("true");
  });

  it("keeps the boutique header on a large store while explaining hidden sections", () => {
    const big = storeShapeFromFacts({
      productCount: 900,
      skuCount: 4000,
      topCategoryCount: 14,
      categoryDepth: 1,
      menu: [{}, {}],
      hasCollections: true,
      hasDeliveryMethods: true,
    });
    // A merchant who adds the newsletter (it waits for a subscriber list) is
    // told so; no template ships it until then.
    const boutique = storefrontTemplateTheme("boutique");
    expect(boutique.pages.home.map((section) => section.type)).not.toContain("newsletter");
    boutique.pages.home = [...boutique.pages.home, storefrontSectionDefault("newsletter", "newsletter")];
    render(boutique, big);
    expect(radio("Inline menu").getAttribute("aria-checked")).toBe("true");
    expect(container.textContent).not.toContain("Your store shows Departments instead.");
    // Sections that wait for their data (a subscriber list) say so; the
    // homepage section library renders the rest.
    const rows = [...container.querySelectorAll("li")].map((row) => row.textContent);
    expect(rows).toContain("NewsletterNot on your store yet.");
    expect(rows).toContain("Product grid");
    // A hero without slides shows nothing until its slides are added.
    expect(rows).toContain("BannersHidden until you add its content.");
  });

  it.each([
    ["department-mall", []],
    ["marketplace", ["cat_a"]],
  ] as const)("flags %s category tiles until they have the categories their style needs", (template, categoryIds) => {
    render(withCategoryTiles(storefrontTemplateTheme(template), [...categoryIds]));
    const row = [...container.querySelectorAll("li")].find((item) => item.textContent?.startsWith("Featured categories"));
    expect(row?.textContent).toBe("Featured categoriesHidden until you add its content.");
    expect(container.querySelector('a[href="/admin/online-store/banners"]')).toBeNull();
  });

  it("does not mark category tiles with their categories hidden", () => {
    render(withCategoryTiles(storefrontTemplateTheme("marketplace"), ["cat_a", "cat_b"]));
    const row = [...container.querySelectorAll("li")].find((item) => item.textContent?.startsWith("Featured categories"));
    expect(row?.textContent).toBe("Featured categories");
  });

  it("saves the logo, top bar, footer words, a slide, categories and the home product in one theme draft, and nothing else", async () => {
    render(DEFAULT_STOREFRONT_THEME);
    files.next = [{ id: "media_logo", url: "https://cdn.test/logo.png", altText: "Mou Ghor" }];
    expect(field("theme-logo-width")).toBeNull();
    act(() => buttonIn("theme-brand-logo", "Select image").click());
    expect(document.querySelector("#theme-brand-logo img")?.getAttribute("src")).toContain("logo.png");
    expect(field("theme-logo-width")).not.toBeNull();

    type(field("theme-announcement-text"), "Free delivery in Dhaka");
    typeAndLeave(field("theme-announcement-link"), "collections/sale");
    expect(field("theme-announcement-link").value).toBe("/collections/sale");

    type(field("theme-footer-tagline"), "Pure honey");
    type(field<HTMLTextAreaElement>("theme-footer-about"), "From the Sundarbans.\n\nPacked in Dhaka.");
    type(field("theme-footer-copyright"), "Mou Ghor Ltd");

    act(() => homeModeRadio("product").click());
    await chooseLoaded(field<HTMLButtonElement>("theme-home-product"), "Sundarban honey");

    act(() => buttonNamed("Edit Banners").click());
    files.next = [{ id: "media_slide", url: "https://cdn.test/slide.jpg", altText: "Honey jars" }];
    act(() => buttonNamed("Add slides").click());
    await act(async () => buttonNamed("Done").click());
    await settle();

    act(() => buttonNamed("Edit Featured categories").click());
    await chooseLoaded(field<HTMLButtonElement>("section-categories-categories"), "Honey");
    await act(async () => buttonNamed("Done").click());

    // Content never makes the template custom.
    expect(radio("Department mall").getAttribute("aria-checked")).toBe("true");
    await pressSave();

    expect(api.draft).toHaveBeenCalledTimes(1);
    const saved = api.draft.mock.calls[0]![0].body.theme as StorefrontThemeDocument;
    expect(saved.brand).toEqual({ logo: "media_logo", logoWidth: 180, footerLogo: null, favicon: null });
    expect(saved.blocks.topBar).toEqual({ variant: "utility", settings: { text: "Free delivery in Dhaka", link: "/collections/sale" } });
    expect(saved.blocks.footer.settings).toMatchObject({
      tagline: "Pure honey",
      about: "From the Sundarbans.\n\nPacked in Dhaka.",
      copyright: "Mou Ghor Ltd",
    });
    expect(saved.pages.homeMode).toEqual({ kind: "product", productId: "prod_honey" });
    expect(saved.pages.home.find((section) => section.type === "hero")?.settings).toMatchObject({
      slides: [{ image: "media_slide", focalPoint: { x: 50, y: 50 }, alt: "Honey jars", link: null }],
    });
    expect(saved.pages.home.find((section) => section.type === "category-tiles")?.settings).toMatchObject({ categoryIds: ["cat_honey"] });
    expect(storefrontThemeDocumentSchema.safeParse(saved).success).toBe(true);
    for (const call of Object.values(others)) expect(call).not.toHaveBeenCalled();
    expect(api.publish).not.toHaveBeenCalled();
  });

  it("keeps the logo, words, slides and home product when another template is chosen", async () => {
    const theme = withContent(DEFAULT_STOREFRONT_THEME);
    render(theme, SHAPE, undefined, [{ id: "media_logo", url: "https://cdn.test/logo.png", alt: "", width: 400, height: 120 }]);
    expect(radio("Department mall").getAttribute("aria-checked")).toBe("true");
    act(() => radio("Fashion value").click());
    expect(radio("Fashion value").getAttribute("aria-checked")).toBe("true");
    await pressSave();
    const saved = api.draft.mock.calls[0]![0].body.theme as StorefrontThemeDocument;
    const fashion = storefrontTemplateTheme("fashion-value");
    expect(saved.template).toBe("fashion-value");
    expect(saved.blocks.header).toEqual(fashion.blocks.header);
    expect(saved.tokens).toEqual(fashion.tokens);
    expect(saved.brand).toEqual(theme.brand);
    expect(saved.pages.homeMode).toEqual({ kind: "product", productId: "prod_honey" });
    expect(saved.blocks.footer.settings).toMatchObject({ tagline: "Pure honey" });
    expect(saved.blocks.topBar.settings).toEqual({ text: "Eid sale", link: "/collections/eid" });
    expect(saved.pages.home.find((section) => section.type === "hero")?.settings).toMatchObject({ slides: [SLIDE] });
  });

  it("will not save a one-product homepage until its product is chosen", async () => {
    render(DEFAULT_STOREFRONT_THEME);
    act(() => homeModeRadio("product").click());
    await pressSave();
    expect(api.draft).not.toHaveBeenCalled();
    expect(document.querySelector("#theme-home-product-note")?.textContent).toBe("Choose a product");
    act(() => homeModeRadio("sections").click());
    expect(field("theme-home-product")).toBeNull();
  });

  it("offers None as the top bar's only off switch and keeps the words when switching bars", async () => {
    render(DEFAULT_STOREFRONT_THEME);
    type(field("theme-announcement-text"), "Eid sale");
    choose(field<HTMLButtonElement>("theme-top-bar"), "Phone banner");
    expect(field("theme-announcement-text").value).toBe("Eid sale");

    typeAndLeave(field("theme-announcement-link"), "sale page");
    expect(document.querySelector("#theme-announcement-link-note")?.textContent).toBe("Use a store path like /sale or a full https:// link.");
    await pressSave();
    expect(api.draft).not.toHaveBeenCalled();

    choose(field<HTMLButtonElement>("theme-top-bar"), "None");
    expect(field("theme-announcement-text")).toBeNull();
    await pressSave();
    expect((api.draft.mock.calls[0]![0].body.theme as StorefrontThemeDocument).blocks.topBar).toEqual({ variant: "none", settings: {} });
  });

  it("marks a missing logo on its field and a missing slide image on its section", async () => {
    const theme = withContent(DEFAULT_STOREFRONT_THEME);
    render(theme);
    type(field("theme-footer-tagline"), "Raw honey");
    const message = "That image is not in Files any more. Choose another image.";
    const hero = theme.pages.home.findIndex((section) => section.type === "hero");
    api.draft.mockRejectedValueOnce(new AdminApiResponseError(message, 400, "VALIDATION_ERROR", [
      { path: "brand.logo", message },
      { path: `pages.home.${hero}.settings.slides.0.image`, message },
    ]));
    await pressSave();
    expect(document.querySelector("#theme-brand-logo-note")?.textContent).toBe(message);
    expect(document.querySelector("#theme-section-hero")?.textContent).toBe(message);
    expect(saveBar()).not.toBeNull();
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
    expect(api.draft).not.toHaveBeenCalled();

    // A readable colour clears the error and saves.
    type(buttonText, "#fafafa");
    expect(buttonText.hasAttribute("aria-invalid")).toBe(false);
    await pressSave();
    expect(api.draft).toHaveBeenCalledTimes(1);
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
      expect(api.draft).toHaveBeenCalledTimes(1);
      expect(api.draft.mock.calls[0]![0].body).toEqual({
        expectedDraftRevision: 1,
        basePublishedRevision: 1,
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
      expect(api.draft.mock.calls[0]![0].body.theme.tokens).toEqual({ ...DEFAULT_STOREFRONT_THEME.tokens, typeScale: "flat" });
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
    expect(api.draft).toHaveBeenCalledTimes(1);
    expect(api.draft.mock.calls[0]![0].body).toEqual({
      expectedDraftRevision: 1,
      basePublishedRevision: 1,
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
