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
import { DEFAULT_HOMEPAGE_PRESENTATION } from "@scalius/shared/homepage-presentation";
import {
  footerQueryOptions,
  headerQueryOptions,
  homepageSectionsQueryOptions,
  themeQueryOptions,
  themeWorkspaceQueryOptions,
  type ThemeWorkspaceDocument,
} from "~/lib/api-query-options/online-store";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import { ThemePage } from "./ThemePage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ draft: vi.fn(), publish: vi.fn(), rebase: vi.fn(), header: vi.fn(), footer: vi.fn() }));
const fonts = vi.hoisted(() => ({ register: vi.fn() }));

vi.mock("./type-preview-fonts", () => ({ registerTypePreviewFonts: fonts.register }));
vi.mock("./ThemePreviewAction", () => ({ ThemePreviewAction: ({ draftRevision }: { draftRevision: number }) => <section data-draft-revision={draftRevision}><h2>Storefront preview</h2></section> }));

vi.mock("~/lib/api", () => ({ apiData: (call: unknown) => call }));
vi.mock("@scalius/api-client/sdk", () => ({
  getApiV1AdminSettingsTheme: vi.fn(),
  getApiV1AdminSettingsThemeWorkspace: vi.fn(),
  getApiV1AdminSettingsHeader: vi.fn(),
  getApiV1AdminSettingsFooter: vi.fn(),
  postApiV1AdminSettingsThemeDraft: api.draft,
  postApiV1AdminSettingsThemeDraftRebase: api.rebase,
  postApiV1AdminSettingsThemePublish: api.publish,
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

function render(
  theme: StorefrontThemeDocument,
  storeShape = SHAPE,
  categoryRail = DEFAULT_HOMEPAGE_PRESENTATION.categoryRail,
  workspace: ThemeWorkspaceDocument = {
    published: { theme, revision: 1 },
    draft: { theme, revision: 1, basePublishedRevision: 1 },
  },
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  queryClient.setQueryData(themeQueryOptions().queryKey, { theme, revision: 1, storeShape, sectionMedia: [] } as never);
  queryClient.setQueryData(themeWorkspaceQueryOptions().queryKey, workspace);
  queryClient.setQueryData(homepageSectionsQueryOptions().queryKey, {
    config: { ...DEFAULT_HOMEPAGE_PRESENTATION, categoryRail }, revision: 1,
  } as never);
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

  it("requires an explicit draft rebase when the live theme changed", async () => {
    const published = storefrontTemplateTheme("boutique");
    const draft = storefrontTemplateTheme("marketplace");
    render(published, SHAPE, DEFAULT_HOMEPAGE_PRESENTATION.categoryRail, {
      published: { theme: published, revision: 2 },
      draft: { theme: draft, revision: 4, basePublishedRevision: 1 },
    });
    const publishButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Publish theme")!;
    expect(publishButton.disabled).toBe(true);
    expect(container.textContent).toContain("The live theme changed since this draft started.");
    api.rebase.mockResolvedValue({ theme: draft, revision: 5, basePublishedRevision: 2 });
    act(() => [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Use current live version")!.click());
    await act(async () => {
      [...document.querySelectorAll<HTMLButtonElement>("[role=alertdialog] button")]
        .find((button) => button.textContent === "Use current live version")!.click();
    });
    expect(api.rebase.mock.calls[0]![0].body).toEqual({
      theme: draft, expectedDraftRevision: 4, basePublishedRevision: 2,
    });
    expect(api.publish).not.toHaveBeenCalled();
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
      ? { variant: "shelves", settings: { maxShelves: 8 } }
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

  it("shows quick filter chip settings only for Showcase", () => {
    render(storefrontTemplateTheme("marketplace"));
    expect(container.querySelector("#theme-listing-facet-chips")).toBeNull();
    expect(container.querySelector("#theme-listing-category-tabs")).toBeNull();
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
    expect(saved.blocks.listing.filters).toEqual({ style: "sidebar-dense", openByDefault: true });
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
    render(storefrontTemplateTheme("boutique"), big);
    expect(radio("Inline menu").getAttribute("aria-checked")).toBe("true");
    expect(container.textContent).not.toContain("Your store shows Departments instead.");
    // Sections that wait for their data (a subscriber list) say so; the
    // homepage section library renders the rest.
    const rows = [...container.querySelectorAll("li")].map((row) => row.textContent);
    expect(rows).toContain("NewsletterNot on your store yet.");
    expect(rows).toContain("Product grid");
    expect(rows).toContain("Banners");
  });

  it.each([
    ["department-mall", false, ["cat_a"], "Turn on Featured categories"],
    ["department-mall", true, [], "Select published categories under Home content (1 needed)"],
    ["marketplace", true, ["cat_a"], "Select published categories under Home content (2 needed)"],
  ] as const)("explains when %s category tiles are hidden by Home content", (template, enabled, categoryIds, reason) => {
    render(storefrontTemplateTheme(template), SHAPE, { enabled, title: "Categories", categoryIds: [...categoryIds] });
    const row = [...container.querySelectorAll("li")].find((item) => item.textContent?.startsWith("Featured categories"));
    expect(row?.textContent).toContain(`Hidden on your store. ${reason}`);
    expect(container.querySelector('a[href="/admin/online-store/banners"]')?.textContent).toBe("Featured categories");
  });

  it("does not mark configured category tiles hidden", () => {
    render(storefrontTemplateTheme("marketplace"), SHAPE, { enabled: true, title: "Categories", categoryIds: ["cat_a", "cat_b"] });
    const row = [...container.querySelectorAll("li")].find((item) => item.textContent?.startsWith("Featured categories"));
    expect(row?.textContent).toBe("Featured categories");
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
