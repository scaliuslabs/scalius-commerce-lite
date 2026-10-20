// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}

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
import { themeWorkspaceQueryOptions, type ThemeWorkspaceDocument } from "~/lib/api-query-options/online-store";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import { PermissionProvider } from "~/contexts/PermissionContext";
import { ThemePage } from "./ThemePage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ draft: vi.fn(), publish: vi.fn(), workspace: vi.fn() }));
const preview = vi.hoisted(() => ({ open: vi.fn() }));
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));

vi.mock("./theme-preview", () => ({ useOpenThemePreview: () => preview.open }));
vi.mock("~/lib/api", () => ({ apiData: (call: unknown) => call }));
vi.mock("@scalius/api-client/sdk", () => ({
  getApiV1AdminSettingsThemeEditor: api.workspace,
  postApiV1AdminSettingsThemeDraft: api.draft,
  postApiV1AdminSettingsThemePublish: api.publish,
}));
vi.mock("sonner", () => ({ toast: toasts }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  api.draft.mockResolvedValue({ revision: 2, basePublishedRevision: 1, updatedAt: null });
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
  categoryDepth: 1,
  menu: [{}, {}, {}, {}, {}],
  hasCollections: true,
  hasDeliveryMethods: true,
});

function workspaceOf(draft: StorefrontThemeDocument, options: { published?: StorefrontThemeDocument; lastPublished?: ThemeWorkspaceDocument["lastPublished"]; apps?: ThemeWorkspaceDocument["apps"] } = {}) {
  const published = options.published ?? draft;
  return {
    published: { theme: published, revision: 1 },
    draft: { theme: draft, revision: 1, basePublishedRevision: 1, updatedAt: null },
    draftDiffersFromLive: JSON.stringify(published) !== JSON.stringify(draft),
    lastPublished: options.lastPublished ?? null,
    storeShape: SHAPE,
    media: [],
    apps: options.apps ?? [],
  } as unknown as ThemeWorkspaceDocument;
}

function render(workspace: ThemeWorkspaceDocument, permissions = ["settings.general.view", "settings.general.edit"]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  queryClient.setQueryData(themeWorkspaceQueryOptions().queryKey, workspace);
  // A refetch after a save reads the same workspace unless a test says otherwise.
  api.workspace.mockResolvedValue(workspace);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <PermissionProvider permissions={permissions}>
          <Suspense fallback={null}>
            <ThemePage />
          </Suspense>
        </PermissionProvider>
      </QueryClientProvider>,
    );
  });
  return queryClient;
}

const radio = (name: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("[role=radio]")].find((item) => item.textContent?.startsWith(name))!;
const button = (name: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((each) => each.textContent === name)!;
const confirm = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("[role=alertdialog] button")].find((each) => each.textContent === name)!;
const current = () => container.querySelector("[data-current-theme]")!;

const SLIDE = { image: "media_slide", focalPoint: { x: 50, y: 50 }, alt: "Honey jars", link: "/collections/eid" };

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
      ...theme.pages,
      homeMode: { kind: "product", productId: "prod_honey" },
      home: theme.pages.home.map((section) =>
        section.type === "hero" ? { ...section, settings: { ...section.settings, slides: [SLIDE] } } : section),
    },
  };
}

describe("themes page", () => {
  it("shows the current theme with its state and who published it, and opens the editor to customize it", () => {
    render(workspaceOf(DEFAULT_STOREFRONT_THEME, {
      lastPublished: { revision: 1, publishedBy: "staff_1", publishedByName: "Rahima", createdAt: "2026-10-03T10:30:00Z" } as never,
    }));
    expect([...container.querySelectorAll("h2")].map((heading) => heading.textContent)).toEqual(["Current theme", "Templates"]);
    expect(current().textContent).toContain("Department");
    expect(current().textContent).toContain("Live");
    expect(current().textContent).toContain("Published by Rahima,");
    expect(current().querySelector('a[href="/admin/online-store/theme/editor"]')?.textContent).toBe("Customize");
    // Nothing to publish while the draft is the live theme.
    expect(button("Publish theme")).toBeUndefined();
  });

  it("offers every template drawn in its own colours, with the current one selected", () => {
    render(workspaceOf(DEFAULT_STOREFRONT_THEME));
    const templates = container.querySelectorAll("[role=radiogroup]")[0]!;
    expect(templates.querySelectorAll("[role=radio]")).toHaveLength(5);
    expect(radio("Department").getAttribute("aria-checked")).toBe("true");
    expect(radio("Boutique").getAttribute("aria-checked")).toBe("false");
    // Previews are decorative; the radio's text names the choice.
    expect(radio("Boutique").querySelector("[aria-hidden=true]")).not.toBeNull();
    const marketplace = radio("Marketplace").querySelector<HTMLElement>("[data-marketplace-preview]")!;
    expect(marketplace.style.getPropertyValue("--sk-purchase")).toBe(storefrontTemplateTheme("marketplace").tokens.colors.accent);
    expect(marketplace.querySelector("[data-marketplace-category-grid]")?.children).toHaveLength(4);
    expect(marketplace.querySelectorAll("[data-marketplace-result-row]")).toHaveLength(2);
    expect(radio("Department").querySelector("[data-marketplace-preview]")).toBeNull();
  });

  it("applies a template to the draft only after confirmation, keeping the merchant's content", async () => {
    const theme = withContent(DEFAULT_STOREFRONT_THEME);
    render(workspaceOf(theme));
    act(() => radio("Boutique").click());
    const dialog = document.querySelector("[role=alertdialog]")!;
    expect(dialog.textContent).toContain("Replace your changes with Boutique?");
    act(() => confirm("Cancel").click());
    expect(api.draft).not.toHaveBeenCalled();

    act(() => radio("Boutique").click());
    await act(async () => confirm("Replace").click());
    expect(api.draft).toHaveBeenCalledTimes(1);
    const body = api.draft.mock.calls[0]![0].body as { theme: StorefrontThemeDocument; expectedDraftRevision: number; basePublishedRevision: number };
    expect(body).toMatchObject({ expectedDraftRevision: 1, basePublishedRevision: 1 });
    const boutique = storefrontTemplateTheme("boutique");
    expect(body.theme.template).toBe("boutique");
    expect(body.theme.blocks.header).toEqual(boutique.blocks.header);
    expect(body.theme.tokens).toEqual(boutique.tokens);
    expect(body.theme.brand).toEqual(theme.brand);
    expect(body.theme.pages.homeMode).toEqual({ kind: "product", productId: "prod_honey" });
    expect(body.theme.blocks.footer.settings).toMatchObject({ tagline: "Pure honey" });
    expect(body.theme.blocks.topBar.settings).toEqual({ text: "Eid sale", link: "/collections/eid" });
    expect(body.theme.pages.home.find((section) => section.type === "hero")?.settings).toMatchObject({ slides: [SLIDE] });
    expect(api.publish).not.toHaveBeenCalled();
    expect(api.workspace).toHaveBeenCalled();
    expect(toasts.success).toHaveBeenCalledWith("Template applied");
  });

  it("saves a chosen grocery template with its merchant defaults", async () => {
    render(workspaceOf(DEFAULT_STOREFRONT_THEME));
    act(() => radio("Essentials").click());
    await act(async () => confirm("Replace").click());
    const saved = api.draft.mock.calls[0]![0].body.theme as StorefrontThemeDocument;
    expect(saved.template).toBe("daily-essentials");
    expect(saved.blocks.card).toEqual({ variant: "standard", settings: { facts: "none", action: "quick-add", hoverImage: false } });
  });

  it("names the template a changed theme is based on", () => {
    const tuned = storefrontTemplateTheme("boutique");
    tuned.blocks = { ...tuned.blocks, header: { variant: "search-first", settings: { search: "field", rowTone: "header", cartTotal: false } } };
    render(workspaceOf(tuned));
    expect(radio("Boutique").getAttribute("aria-checked")).toBe("false");
    expect(current().textContent).toContain("Changed (based on Boutique)");
  });

  it("publishes an unpublished draft from the page after confirmation", async () => {
    const live = storefrontTemplateTheme("boutique");
    render(workspaceOf(DEFAULT_STOREFRONT_THEME, { published: live }));
    expect(current().textContent).toContain("Unpublished changes");
    api.publish.mockResolvedValue({ published: { revision: 2 }, draft: { revision: 2, basePublishedRevision: 2, updatedAt: null }, draftDiffersFromLive: false, lastPublished: null });
    act(() => button("Publish theme").click());
    expect(api.publish).not.toHaveBeenCalled();
    await act(async () => confirm("Publish theme").click());
    expect(api.publish.mock.calls[0]![0].body).toEqual({ expectedPublishedRevision: 1, expectedDraftRevision: 1 });
    expect(api.workspace).toHaveBeenCalled();
  });

  it("reloads and says so when another session changed the draft", async () => {
    render(workspaceOf(DEFAULT_STOREFRONT_THEME));
    api.draft.mockRejectedValueOnce(new AdminApiResponseError("Draft changed", 409, "CONFLICT"));
    act(() => radio("Boutique").click());
    await act(async () => confirm("Replace").click());
    expect(toasts.error).toHaveBeenCalledTimes(1);
    expect(api.workspace).toHaveBeenCalled();
  });

  it("lets staff who may only view settings see and preview the theme, not publish or restyle it", () => {
    render(workspaceOf(DEFAULT_STOREFRONT_THEME, { published: storefrontTemplateTheme("boutique") }), ["settings.general.view"]);
    expect(current().textContent).toContain("Unpublished changes");
    expect(button("Publish theme")).toBeUndefined();
    expect(button("Preview")).toBeDefined();
    act(() => radio("Boutique").click());
    expect(document.querySelector("[role=alertdialog]")).toBeNull();
    expect(container.textContent).toContain("You can view this theme but not change it.");
  });

  describe("app templates", () => {
    const bold = storefrontTemplateTheme("boutique");
    const STUDIO: ThemeWorkspaceDocument["apps"] = [{
      id: "acme.studio",
      name: "Acme Studio",
      sections: [],
      skins: [],
      components: [],
      pagePresets: [],
      templates: [
        { key: "acme.studio/bold", id: "bold", name: "Studio Bold", description: "Big type, quiet colours.",
          theme: { tokens: bold.tokens, apps: { skins: { header: { app: "acme.studio/header", values: { tagline: "Hi" } } } } } },
        // A template this document version cannot read is never offered.
        { key: "acme.studio/future", id: "future", name: "Studio Future", description: null, theme: { tokens: { unknown: true } } },
      ],
    }];

    it("lists an app's templates beside the built-in ones with an App badge and the app's name", () => {
      render(workspaceOf(DEFAULT_STOREFRONT_THEME, { apps: STUDIO }));
      const templates = container.querySelectorAll("[role=radiogroup]")[0]!;
      expect(templates.querySelectorAll("[role=radio]")).toHaveLength(6);
      expect(radio("Studio Bold").textContent).toBe("Studio BoldAppBig type, quiet colours. From Acme Studio");
      expect(radio("Studio Bold").getAttribute("aria-checked")).toBe("false");
      expect(radio("Department").getAttribute("aria-checked")).toBe("true");
    });

    it("applies an app template to the draft after confirmation, keeping the merchant's content", async () => {
      const theme = withContent(DEFAULT_STOREFRONT_THEME);
      render(workspaceOf(theme, { apps: STUDIO }));
      act(() => radio("Studio Bold").click());
      const dialog = document.querySelector("[role=alertdialog]")!;
      expect(dialog.textContent).toContain("Replace your changes with Studio Bold?");
      expect(dialog.textContent).toContain("the homepage sections it brings replace yours");
      await act(async () => confirm("Replace").click());
      const saved = api.draft.mock.calls[0]![0].body.theme as StorefrontThemeDocument;
      expect(saved.tokens).toEqual(bold.tokens);
      expect(saved.apps).toEqual({ skins: { header: { app: "acme.studio/header", values: { tagline: "Hi" } } }, template: "acme.studio/bold" });
      expect(saved.brand).toEqual(theme.brand);
      expect(saved.pages).toEqual(theme.pages);
      expect(toasts.success).toHaveBeenCalledWith("Template applied");
    });

    it("shows the app template the draft was applied from as the current one", () => {
      const applied = { ...DEFAULT_STOREFRONT_THEME, tokens: bold.tokens, apps: { template: "acme.studio/bold" } };
      render(workspaceOf(applied, { apps: STUDIO }));
      expect(radio("Studio Bold").getAttribute("aria-checked")).toBe("true");
      expect(radio("Department").getAttribute("aria-checked")).toBe("false");
      expect(current().textContent).toContain("Studio Bold");
    });
  });

  it("previews the saved draft's homepage in a new tab", async () => {
    preview.open.mockResolvedValue("opened");
    render(workspaceOf(DEFAULT_STOREFRONT_THEME));
    await act(async () => button("Preview").click());
    expect(preview.open).toHaveBeenCalledWith(1, "/");
    expect(toasts.error).not.toHaveBeenCalled();
  });
});
