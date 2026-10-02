// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useImperativeHandle, type AnchorHTMLAttributes, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_STOREFRONT_THEME,
  storeShapeFromFacts,
  storefrontSectionDefault,
  storefrontTemplateTheme,
  storefrontThemeDocumentSchema,
  type StorefrontSection,
  type StorefrontThemeDocument,
} from "@scalius/shared/storefront-theme";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import type { ThemeWorkspaceDocument } from "~/lib/api-query-options/online-store";
import { ThemeEditor } from "./ThemeEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ draft: vi.fn(), publish: vi.fn() }));
const preview = vi.hoisted(() => ({ send: vi.fn(), open: vi.fn(), select: null as null | ((id: string) => void) }));
const files = vi.hoisted(() => ({ next: [] as Array<{ id: string; url: string; altText?: string }> }));
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));

vi.mock("~/lib/api", () => ({ apiData: (call: unknown) => call }));
vi.mock("@scalius/api-client/sdk", () => ({
  postApiV1AdminSettingsThemeDraft: api.draft,
  postApiV1AdminSettingsThemePublish: api.publish,
  getApiV1AdminCategoriesFormOptions: vi.fn(async () => ({
    categories: [{ id: "cat_honey", name: "Honey", status: "published" }, { id: "cat_ghee", name: "Ghee", status: "published" }],
  })),
  getApiV1AdminCollections: vi.fn(async () => ({ collections: [], pagination: { page: 1, totalPages: 1 } })),
  getApiV1AdminCollectionsByIds: vi.fn(async () => ({ collections: [] })),
  getApiV1AdminDiscounts: vi.fn(async () => ({ discounts: [] })),
}));
vi.mock("sonner", () => ({ toast: toasts }));
vi.mock("../type-preview-fonts", () => ({ registerTypePreviewFonts: vi.fn() }));
vi.mock("../ThemePreviewAction", () => ({ useOpenThemePreview: () => preview.open }));
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
// The frame is its own unit (PreviewFrame.test.tsx): here it records what the editor tells it.
vi.mock("./PreviewFrame", () => ({
  PreviewFrame: function FakeFrame(props: { onSelect: (id: string) => void; controller: unknown }) {
    preview.select = props.onSelect;
    useImperativeHandle(props.controller as never, () => ({ send: preview.send }));
    return <div data-fake-preview />;
  },
}));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  let revision = 1;
  api.draft.mockImplementation(async ({ body }: { body: { theme: StorefrontThemeDocument } }) => ({
    theme: body.theme,
    revision: (revision += 1),
    basePublishedRevision: 1,
    updatedAt: null,
  }));
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

const section = (type: StorefrontSection["type"], id: string, settings: Record<string, unknown> = {}) =>
  ({ ...storefrontSectionDefault(type, id), settings: { ...storefrontSectionDefault(type, id).settings, ...settings } }) as StorefrontSection;

function themeWith(home: StorefrontSection[], base: StorefrontThemeDocument = DEFAULT_STOREFRONT_THEME): StorefrontThemeDocument {
  return { ...base, pages: { home, homeMode: { kind: "sections" } } };
}

const HOME = [
  section("hero", "hero", { slides: [{ image: "media_slide", focalPoint: { x: 50, y: 50 }, alt: "Honey jars", link: null }] }),
  section("product-rail", "rail", { title: "New honey" }),
  section("faq", "faq", { heading: "Questions", items: [{ question: "Is it raw?", answer: "Yes." }] }),
];

function render(theme: StorefrontThemeDocument = themeWith(HOME), options: {
  shape?: typeof SHAPE;
  media?: ThemeWorkspaceDocument["media"];
  refetch?: () => Promise<{ data?: ThemeWorkspaceDocument }>;
  published?: StorefrontThemeDocument;
} = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  const workspace = {
    published: { theme: options.published ?? theme, revision: 1 },
    draft: { theme, revision: 1, basePublishedRevision: 1, updatedAt: null },
    storeShape: options.shape ?? SHAPE,
    media: options.media ?? [],
  } as unknown as ThemeWorkspaceDocument;
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <ThemeEditor workspace={workspace} refetch={options.refetch ?? (async () => ({ data: workspace }))} />
      </QueryClientProvider>,
    );
  });
}

const button = (name: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)
  ?? [...document.querySelectorAll<HTMLElement>("button, [role=menuitem]")].find((each) => each.textContent?.trim() === name) as HTMLButtonElement;
const rows = () => [...container.querySelectorAll<HTMLElement>("[data-section-row]")].map((row) => row.dataset.sectionRow);
const rowText = (id: string) => container.querySelector<HTMLElement>(`[data-section-row="${id}"] button:nth-of-type(2)`)?.textContent;
const field = <Element extends HTMLElement = HTMLInputElement>(id: string) => document.querySelector<Element>(`#${CSS.escape(id)}`)!;
const lastSaved = () => api.draft.mock.calls.at(-1)![0].body as { theme: StorefrontThemeDocument; expectedDraftRevision: number };

function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  act(() => {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function openMenu(name: string) {
  act(() => {
    button(name).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}

function choose(trigger: HTMLButtonElement, label: string) {
  act(() => trigger.click());
  const option = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
    .find((item) => item.textContent?.trim().startsWith(label));
  expect(option).toBeDefined();
  act(() => option!.click());
}

/** Waits for the debounced autosave to send a draft. */
const autosaved = (times = 1) => vi.waitFor(() => expect(api.draft).toHaveBeenCalledTimes(times), { timeout: 3000 });
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

/** dnd-kit measures rows: give each one a stacked 48px box. */
function stackRows() {
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const row = this.closest<HTMLElement>("[data-section-row]");
    if (!row) return original.call(this);
    const index = rows().indexOf(row.dataset.sectionRow);
    const top = index * 48;
    return { x: 0, y: top, top, left: 0, right: 320, bottom: top + 48, width: 320, height: 48, toJSON: () => ({}) } as DOMRect;
  });
}

describe("theme editor: sections", () => {
  it("lists the homepage sections with why buyers don't see some", () => {
    const boutique = storefrontTemplateTheme("boutique");
    render({ ...boutique, pages: { ...boutique.pages, home: [...boutique.pages.home, storefrontSectionDefault("newsletter", "signup")] } });
    // The newsletter signup shows on the store as it is (its form needs no content).
    expect(rowText("newsletter")).toBe("Newsletter");
    expect(rowText("signup")).toBe("Newsletter");
    // A hero without slides shows nothing until its slides are added.
    expect(rowText(boutique.pages.home.find((each) => each.type === "hero")!.id)).toBe("BannersHidden until you add its content.");
  });

  it.each([
    ["department-mall", []],
    ["marketplace", ["cat_a"]],
  ] as const)("flags %s category tiles until they have the categories their style needs", (template, categoryIds) => {
    const base = storefrontTemplateTheme(template);
    const home = base.pages.home.map((each) => each.type === "category-tiles" ? { ...each, settings: { ...each.settings, categoryIds: [...categoryIds] } } as StorefrontSection : each);
    render({ ...base, pages: { ...base.pages, home } });
    const tiles = home.find((each) => each.type === "category-tiles")!;
    expect(rowText(tiles.id)).toBe("Featured categoriesHidden until you add its content.");
  });

  it("reorders sections from the keyboard: Space, an arrow, Space; then saves and reloads the preview", async () => {
    render();
    stackRows();
    const handle = button("Reorder New honey");
    act(() => handle.focus());
    act(() => {
      handle.dispatchEvent(new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true }));
    });
    await settle();
    act(() => {
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", code: "ArrowDown", bubbles: true }));
    });
    await settle();
    act(() => {
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true }));
    });
    await settle();
    expect(rows()).toEqual(["hero", "faq", "rail"]);
    await autosaved();
    expect(lastSaved().theme.pages.home.map((each) => each.id)).toEqual(["hero", "faq", "rail"]);
    expect(lastSaved().expectedDraftRevision).toBe(1);
    // Order is structure: the preview loads the page again.
    expect(preview.send).toHaveBeenCalledWith({ type: "reload" });
  });

  it("moves a section from its menu, and duplicates one", async () => {
    render();
    openMenu("Actions for Questions");
    act(() => button("Move up").click());
    expect(rows()).toEqual(["hero", "faq", "rail"]);
    openMenu("Actions for New honey");
    act(() => button("Duplicate").click());
    expect(rows()).toEqual(["hero", "faq", "rail", "product-rail"]);
    // One hero per homepage: it cannot be copied.
    openMenu("Actions for Banners");
    expect(button("Duplicate").getAttribute("aria-disabled") ?? button("Duplicate").getAttribute("data-disabled")).not.toBeNull();
  });

  it("removes a section with an undo in the toast that puts it back in place", async () => {
    render();
    openMenu("Actions for New honey");
    act(() => button("Remove").click());
    expect(rows()).toEqual(["hero", "faq"]);
    const [message, options] = toasts.success.mock.calls.at(-1) as [string, { action: { label: string; onClick: () => void }; duration: number }];
    expect(message).toBe("Section removed");
    expect(options.action.label).toBe("Undo");
    expect(options.duration).toBe(10_000);
    act(() => options.action.onClick());
    expect(rows()).toEqual(["hero", "rail", "faq"]);
  });

  it("adds a section with its availability notes, selects it and saves it", async () => {
    render(themeWith(HOME), { shape: storeShapeFromFacts({ productCount: 3, skuCount: 3, topCategoryCount: 1, categoryDepth: 1, menu: [], hasCollections: false, hasDeliveryMethods: true }) });
    const add = container.querySelector<HTMLButtonElement>("button[aria-label='Add section']")!;
    act(() => add.click());
    const options = [...document.querySelectorAll<HTMLElement>("[role=option]")];
    const tiles = options.find((option) => option.textContent?.startsWith("Featured categories"))!;
    expect(tiles.textContent).toContain("Needs 2 or more categories (you have 1).");
    const hero = options.find((option) => option.textContent?.startsWith("Banners"))!;
    expect(hero.textContent).toContain("A homepage has one.");
    expect((hero as HTMLButtonElement).disabled).toBe(true);
    act(() => options.find((option) => option.textContent?.startsWith("Questions and answers"))!.click());
    // The new section opens for editing.
    expect(container.querySelector("h2")?.textContent).toBe("Questions and answers");
    type(field("theme-section-faq-2-heading"), "Delivery");
    await autosaved();
    expect(lastSaved().theme.pages.home.at(-1)).toEqual({ id: "faq-2", type: "faq", version: 1, settings: { heading: "Delivery", items: [] } });
  });
});

describe("theme editor: settings and saving", () => {
  it("saves a section's setting by itself and re-renders only that section", async () => {
    render();
    act(() => container.querySelector<HTMLButtonElement>('[data-section-row="rail"] button:nth-of-type(2)')!.click());
    expect(container.querySelector("h2")?.textContent).toBe("Product row");
    type(field("theme-section-rail-title"), "Fresh honey");
    expect(container.textContent).toContain("Unsaved changes");
    await autosaved();
    expect(lastSaved().theme.pages.home[1]!.settings).toMatchObject({ title: "Fresh honey" });
    await vi.waitFor(() => expect(preview.send).toHaveBeenCalledWith({ type: "section-updated", sectionIds: ["rail"] }));
    expect(container.textContent).toContain("Draft saved");
  });

  it("selects the section a click in the preview names", () => {
    render();
    act(() => preview.select!("faq"));
    expect(container.querySelector("h2")?.textContent).toBe("Questions and answers");
    act(() => button("All sections").click());
    expect(rows()).toEqual(["hero", "rail", "faq"]);
  });

  it("will not save settings the schema rejects, and says where", async () => {
    render();
    act(() => container.querySelector<HTMLButtonElement>('[data-section-row="faq"] button:nth-of-type(2)')!.click());
    type(field("theme-section-faq-items-0-question"), "");
    expect(document.querySelector("#theme-section-faq-items-0-question-note")?.textContent).toBe("Fill this in.");
    expect(container.textContent).toContain("Fix the marked settings to save");
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(api.draft).not.toHaveBeenCalled();
  });

  it("undoes and redoes draft edits, and saves the result", async () => {
    render();
    act(() => container.querySelector<HTMLButtonElement>('[data-section-row="rail"] button:nth-of-type(2)')!.click());
    // Typing in one field is one undo step.
    type(field("theme-section-rail-title"), "N");
    type(field("theme-section-rail-title"), "Ne");
    type(field("theme-section-rail-title"), "New");
    act(() => button("Undo").click());
    expect(field("theme-section-rail-title").value).toBe("New honey");
    expect(button("Undo").disabled).toBe(true);
    act(() => button("Redo").click());
    expect(field("theme-section-rail-title").value).toBe("New");
    act(() => button("Undo").click());
    // Back where it started: nothing to save.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(api.draft).not.toHaveBeenCalled();
    // ⌘Z outside a field undoes too; inside a field it is the field's own.
    act(() => button("Redo").click());
    act(() => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true })));
    expect(field("theme-section-rail-title").value).toBe("New honey");
  });

  it("keeps the edits when another session saved first, then merges and saves again", async () => {
    const newer = themeWith(HOME.map((each) => each.id === "faq" ? { ...each, settings: { ...each.settings, heading: "Their questions" } } as StorefrontSection : each));
    const refetch = vi.fn(async () => ({
      data: {
        published: { theme: newer, revision: 1 },
        draft: { theme: newer, revision: 5, basePublishedRevision: 1, updatedAt: null },
        storeShape: SHAPE,
        media: [],
      } as unknown as ThemeWorkspaceDocument,
    }));
    render(themeWith(HOME), { refetch });
    api.draft.mockRejectedValueOnce(new AdminApiResponseError("Draft changed", 409, "CONFLICT"));
    act(() => container.querySelector<HTMLButtonElement>('[data-section-row="rail"] button:nth-of-type(2)')!.click());
    type(field("theme-section-rail-title"), "Mine");
    await autosaved();
    await vi.waitFor(() => expect(container.textContent).toContain("Someone else changed this theme."));
    expect(field("theme-section-rail-title").value).toBe("Mine");
    await act(async () => button("Load changes").click());
    expect(refetch).toHaveBeenCalledTimes(1);
    await autosaved(2);
    const saved = lastSaved();
    expect(saved.expectedDraftRevision).toBe(5);
    expect(saved.theme.pages.home.find((each) => each.id === "rail")!.settings).toMatchObject({ title: "Mine" });
    expect(saved.theme.pages.home.find((each) => each.id === "faq")!.settings).toMatchObject({ heading: "Their questions" });
  });

  it("marks a rejected image on its section row and in its settings", async () => {
    render();
    const message = "That image is not in Files any more. Choose another image.";
    api.draft.mockRejectedValueOnce(new AdminApiResponseError(message, 400, "VALIDATION_ERROR", [
      { path: "theme.pages.home.0.settings.slides.0.image", message },
    ]));
    act(() => container.querySelector<HTMLButtonElement>('[data-section-row="rail"] button:nth-of-type(2)')!.click());
    type(field("theme-section-rail-title"), "Fresh");
    await autosaved();
    await vi.waitFor(() => expect(container.textContent).toContain(message));
    act(() => button("All sections").click());
    expect(rowText("hero")).toBe(`Banners${message}`);
    act(() => container.querySelector<HTMLButtonElement>('[data-section-row="hero"] button:nth-of-type(2)')!.click());
    expect(document.querySelector("#theme-section-hero-slides-0-image-note")?.textContent).toBe(message);
  });

  it("publishes the saved draft after confirmation", async () => {
    const published = storefrontTemplateTheme("boutique");
    render(themeWith(HOME), { published });
    api.publish.mockResolvedValue({
      published: { theme: themeWith(HOME), revision: 2 },
      draft: { theme: themeWith(HOME), revision: 1, basePublishedRevision: 2, updatedAt: null },
    });
    expect(container.textContent).toContain("Not published");
    act(() => button("Publish").click());
    await act(async () => {
      [...document.querySelectorAll<HTMLButtonElement>("[role=alertdialog] button")]
        .find((each) => each.textContent === "Publish theme")!.click();
    });
    expect(api.publish.mock.calls[0]![0].body).toEqual({ expectedPublishedRevision: 1, expectedDraftRevision: 1 });
    expect(container.textContent).toContain("Live");
  });

  it("opens the saved draft in a new tab", () => {
    render();
    act(() => button("Preview").click());
    expect(preview.open).toHaveBeenCalledWith(1, "/");
  });
});

describe("theme editor: theme settings", () => {
  const openTheme = () => act(() => [...container.querySelectorAll<HTMLButtonElement>("[role=tab]")].find((tab) => tab.textContent === "Theme settings")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));

  it("saves the logo, top bar and footer words with generated fields", async () => {
    render();
    openTheme();
    files.next = [{ id: "media_logo", url: "https://cdn.test/logo.png", altText: "Mou Ghor" }];
    act(() => [...document.querySelectorAll<HTMLButtonElement>("#theme-brand-logo button")].find((each) => each.textContent === "Select image")!.click());
    choose(field<HTMLButtonElement>("theme-top-bar"), "Announcement");
    type(field("theme-blocks-topBar-settings-text"), "Free delivery in Dhaka");
    act(() => field("theme-blocks-topBar-settings-link").focus());
    type(field("theme-blocks-topBar-settings-link"), "collections/sale");
    act(() => field("theme-blocks-topBar-settings-link").blur());
    expect(field("theme-blocks-topBar-settings-link").value).toBe("/collections/sale");
    type(field("theme-blocks-footer-settings-tagline"), "Pure honey");
    await autosaved();
    const saved = lastSaved().theme;
    expect(saved.brand.logo).toBe("media_logo");
    expect(saved.blocks.topBar).toEqual({ variant: "announcement", settings: { text: "Free delivery in Dhaka", link: "/collections/sale" } });
    expect(saved.blocks.footer.settings).toMatchObject({ tagline: "Pure honey" });
    expect(storefrontThemeDocumentSchema.safeParse(saved).success).toBe(true);
    // Brand, blocks and look are page-wide: the preview loads again.
    expect(preview.send).toHaveBeenCalledWith({ type: "reload" });
  });

  it("chooses menu styles and their generated settings, saying what does not fit the store", async () => {
    const marketplace = storefrontTemplateTheme("marketplace");
    render({ ...marketplace, pages: { ...marketplace.pages, homeMode: { kind: "sections" } } });
    openTheme();
    const radio = (value: string) => container.querySelector<HTMLButtonElement>(`[role=radio][value="${value}"]`)!;
    act(() => radio("mega-panel").click());
    expect(container.textContent).toContain("Your store shows Dropdown instead. Needs 2 or more navigation groups with two or more links (you have 0).");
    // The mega panel's own setting is generated from its schema.
    act(() => field<HTMLButtonElement>("theme-blocks-desktopNav-settings-promoImages").click());
    await autosaved();
    expect(lastSaved().theme.blocks.desktopNav).toEqual({ variant: "mega-panel", settings: { promoImages: true } });
  });
});
