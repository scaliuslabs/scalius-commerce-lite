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
  type StorefrontSectionType,
  type StorefrontThemeDocument,
} from "@scalius/shared/storefront-theme";
import { setLocale } from "~/i18n";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import type { ThemeWorkspaceDocument } from "~/lib/api-query-options/online-store";
import { ThemeEditor } from "./ThemeEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ draft: vi.fn(), publish: vi.fn(), restore: vi.fn(), discard: vi.fn(), versions: vi.fn() }));
const preview = vi.hoisted(() => ({ send: vi.fn(), open: vi.fn(), select: null as null | ((id: string) => void), props: {} as { sourceRevision?: number; previewPath?: string; device?: string } }));
const files = vi.hoisted(() => ({ next: [] as Array<{ id: string; url: string; altText?: string }> }));
const blocker = vi.hoisted(() => vi.fn(() => ({ status: "idle" })));
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));

vi.mock("~/lib/api", () => ({ apiData: (call: unknown) => call }));
vi.mock("@scalius/api-client/sdk", () => ({
  postApiV1AdminSettingsThemeDraft: api.draft,
  postApiV1AdminSettingsThemePublish: api.publish,
  postApiV1AdminSettingsThemeRestore: api.restore,
  postApiV1AdminSettingsThemeDiscard: api.discard,
  getApiV1AdminSettingsThemeVersions: api.versions,
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
  useBlocker: blocker,
  Link: ({ to, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));
// The frame is its own unit (PreviewFrame.test.tsx): here it records what the editor tells it.
vi.mock("./PreviewFrame", () => ({
  PreviewFrame: function FakeFrame(props: { sourceRevision?: number; previewPath?: string; device?: string; onSelect: (id: string) => void; controller: unknown }) {
    preview.select = props.onSelect;
    preview.props = props;
    useImperativeHandle(props.controller as never, () => ({ send: preview.send }));
    return <div data-fake-preview />;
  },
}));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  act(() => setLocale("en"));
  api.versions.mockResolvedValue({ versions: [] });
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
  setLocale("en");
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

const section = (type: StorefrontSectionType, id: string, settings: Record<string, unknown> = {}) =>
  ({ ...storefrontSectionDefault(type, id), settings: { ...storefrontSectionDefault(type, id).settings, ...settings } }) as StorefrontSection;

function themeWith(home: StorefrontSection[], base: StorefrontThemeDocument = DEFAULT_STOREFRONT_THEME): StorefrontThemeDocument {
  return { ...base, pages: { ...base.pages, home, homeMode: { kind: "sections" } } };
}

const HOME = [
  section("hero", "hero", { slides: [{ image: "media_slide", focalPoint: { x: 50, y: 50 }, alt: "Honey jars", link: null }] }),
  section("product-rail", "rail", { title: "New honey" }),
  section("faq", "faq", { heading: "Questions", items: [{ question: "Is it raw?", answer: "Yes." }] }),
];

function render(theme: StorefrontThemeDocument = themeWith(HOME), options: {
  shape?: typeof SHAPE;
  media?: ThemeWorkspaceDocument["media"];
  apps?: ThemeWorkspaceDocument["apps"];
  refetch?: () => Promise<{ data?: ThemeWorkspaceDocument }>;
  published?: StorefrontThemeDocument;
  lastPublished?: ThemeWorkspaceDocument["lastPublished"];
} = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  const workspace = {
    published: { theme: options.published ?? theme, revision: 1 },
    lastPublished: options.lastPublished ?? null,
    draft: { theme, revision: 1, basePublishedRevision: 1, updatedAt: null },
    storeShape: options.shape ?? SHAPE,
    media: options.media ?? [],
    apps: options.apps ?? [],
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
    expect(hero.textContent).toContain("A page has one.");
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

  it("keeps the edits on conflict, then explicitly overwrites using the latest revision", async () => {
    const newer = themeWith(HOME.map((each) => each.id === "faq" ? { ...each, settings: { ...each.settings, heading: "Their questions" } } as StorefrontSection : each));
    const refetch = vi.fn(async () => ({
      data: {
        published: { theme: newer, revision: 1 },
        draft: { theme: newer, revision: 5, basePublishedRevision: 1, updatedAt: null },
        storeShape: SHAPE,
        media: [],
        apps: [],
      } as unknown as ThemeWorkspaceDocument,
    }));
    render(themeWith(HOME), { refetch });
    api.draft.mockRejectedValueOnce(new AdminApiResponseError("Draft changed", 409, "CONFLICT"));
    act(() => container.querySelector<HTMLButtonElement>('[data-section-row="rail"] button:nth-of-type(2)')!.click());
    type(field("theme-section-rail-title"), "Mine");
    await autosaved();
    await vi.waitFor(() => expect(container.textContent).toContain("Someone else changed this theme."));
    expect(field("theme-section-rail-title").value).toBe("Mine");
    await act(async () => button("Overwrite with my edits").click());
    expect(refetch).toHaveBeenCalledTimes(1);
    await autosaved(2);
    const saved = lastSaved();
    expect(saved.expectedDraftRevision).toBe(5);
    expect(saved.theme.pages.home.find((each) => each.id === "rail")!.settings).toMatchObject({ title: "Mine" });
    expect(saved.theme.pages.home.find((each) => each.id === "faq")!.settings).toMatchObject({ heading: "Questions" });
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
    expect(preview.open).toHaveBeenCalledWith(1, "/", "full", undefined);
  });
});

describe("theme editor: app sections", () => {
  type App = ThemeWorkspaceDocument["apps"][number];
  type Field = App["sections"][number]["settings"][number];
  const setting = (key: string, label: string, extra: Partial<Field> = {}): Field => ({
    key, label, help: null, type: "text", required: false, options: null, default: null,
    min: null, max: null, integer: false, maxLength: null, ...extra,
  });
  const CAROUSEL = "acme.reviews/carousel";
  const APPS: App[] = [{
    id: "acme.reviews",
    name: "Acme Reviews",
    sections: [{
      key: CAROUSEL,
      type: "carousel",
      name: "Reviews carousel",
      description: "Your best reviews in a row.",
      settings: [
        setting("heading", "Heading", { maxLength: 60, default: "What buyers say" }),
        setting("intro", "Intro", { type: "textarea", required: true, maxLength: 300 }),
        setting("count", "Reviews shown", { type: "number", min: 1, max: 12, integer: true, default: 4 }),
        setting("stars", "Show stars", { type: "boolean", default: true }),
        setting("layout", "Layout", { type: "select", options: [{ value: "grid", label: "Grid" }, { value: "carousel", label: "Carousel" }], default: "grid" }),
        setting("more", "More reviews link", { type: "url", help: "Where “See all” goes." }),
        setting("accent", "Star colour", { type: "color", default: "#1a7f37" }),
      ],
    }],
    productBlocks: [],
  }];
  const appSection = (id: string, values: Record<string, unknown>, app = CAROUSEL) =>
    ({ id, type: "app", version: 1, settings: { app, values } }) as StorefrontSection;
  const openAdd = () => act(() => container.querySelector<HTMLButtonElement>("button[aria-label='Add section']")!.click());
  const option = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("[role=option]")].find((each) => each.textContent?.startsWith(label));
  const groupHeadings = () => [...document.querySelectorAll("[role=presentation]")].map((each) => each.textContent);
  const status = () => container.querySelector("header [role=status]")?.textContent;

  it("adds an app's section from the Apps group at its defaults and saves it once its settings are valid", async () => {
    render(themeWith(HOME), { apps: APPS });
    openAdd();
    expect(groupHeadings()).toEqual(["Sections", "Apps"]);
    expect(option("Reviews carousel")?.textContent).toBe("Reviews carouselYour best reviews in a row. From Acme Reviews");
    act(() => option("Reviews carousel")!.click());
    // The new section opens with the app's own words.
    expect(container.querySelector("h2")?.textContent).toBe("Reviews carousel");
    expect(container.textContent).toContain("Your best reviews in a row. From Acme Reviews");
    expect(field("theme-section-app-values-heading").value).toBe("What buyers say");
    // The app's required intro has no default: nothing saves until it is written.
    expect(document.querySelector("#theme-section-app-values-intro-note")?.textContent).toBe("Fill this in.");
    expect(status()).toBe("Fix the marked settings to save");
    type(field<HTMLTextAreaElement>("theme-section-app-values-intro"), "Loved by 2,000 buyers");
    type(field("theme-section-app-values-more"), "http://reviews.test");
    expect(document.querySelector("#theme-section-app-values-more-note")?.textContent).toBe("Use a full https:// address.");
    expect(field("theme-section-app-values-more").getAttribute("aria-invalid")).toBe("true");
    type(field("theme-section-app-values-more"), "https://reviews.test/all");
    type(field("theme-section-app-values-count"), "6");
    await autosaved();
    const saved = lastSaved().theme;
    expect(saved.pages.home.at(-1)).toEqual({
      id: "app",
      type: "app",
      version: 1,
      settings: {
        app: CAROUSEL,
        values: { heading: "What buyers say", intro: "Loved by 2,000 buyers", count: 6, stars: true, layout: "grid", more: "https://reviews.test/all", accent: "#1a7f37" },
      },
    });
    expect(storefrontThemeDocumentSchema.safeParse(saved).success).toBe(true);
    // A new section is structure: the preview loads the page again.
    expect(preview.send).toHaveBeenCalledWith({ type: "reload" });
    act(() => button("All sections").click());
    expect(rowText("app")).toBe("Reviews carouselFrom Acme Reviews");
  });

  it("edits an app section's values, drops settings the app no longer has, and swaps only that section", async () => {
    render(themeWith([...HOME, appSection("reviews", { heading: "Reviews", intro: "Hi", count: 4, legacy: "old" })]), { apps: APPS });
    expect(rowText("reviews")).toBe("Reviews carouselFrom Acme Reviews");
    act(() => container.querySelector<HTMLButtonElement>('[data-section-row="reviews"] button:nth-of-type(2)')!.click());
    act(() => field<HTMLButtonElement>("theme-section-reviews-values-stars").click());
    choose(field<HTMLButtonElement>("theme-section-reviews-values-layout"), "Carousel");
    type(field("theme-section-reviews-values-accent"), "#B4232A");
    await autosaved();
    expect(lastSaved().theme.pages.home.find((each) => each.id === "reviews")!.settings).toEqual({
      app: CAROUSEL,
      values: { heading: "Reviews", intro: "Hi", count: 4, stars: false, layout: "carousel", accent: "#b4232a" },
    });
    await vi.waitFor(() => expect(preview.send).toHaveBeenCalledWith({ type: "section-updated", sectionIds: ["reviews"] }));
    // Undo puts the colour back.
    act(() => button("Undo").click());
    expect(field("theme-section-reviews-values-accent").value).toBe("#1a7f37");
  });

  it("keeps a section whose app is not active, says so, and lets the merchant remove it", async () => {
    render(themeWith([...HOME, appSection("banner", { text: "Eid sale" }, "acme.gone/banner")]), { apps: APPS });
    expect(rowText("banner")).toBe("acme.gone/bannerApp not active. Hidden on your store.");
    act(() => container.querySelector<HTMLButtonElement>('[data-section-row="banner"] button:nth-of-type(2)')!.click());
    expect(container.querySelector("h2")?.textContent).toBe("acme.gone/banner");
    expect(container.textContent).toContain("This section's app isn't active, so your store doesn't show it.");
    act(() => button("All sections").click());
    openMenu("Actions for acme.gone/banner");
    act(() => button("Remove").click());
    expect(rows()).toEqual(["hero", "rail", "faq"]);
    await autosaved();
    expect(lastSaved().theme.pages.home.map((each) => each.id)).toEqual(["hero", "rail", "faq"]);
  });

  it("marks an app section whose values the app refuses, and stops adding at the homepage's app section limit", () => {
    const eight = Array.from({ length: 8 }, (_, index) => appSection(`app-${index}`, { intro: "Hi", count: index === 0 ? 40 : 4 }));
    render(themeWith(eight), { apps: APPS });
    expect(rowText("app-0")).toBe("Reviews carouselFix its settings to save.");
    expect(rowText("app-1")).toBe("Reviews carouselFrom Acme Reviews");
    openAdd();
    const carousel = option("Reviews carousel")!;
    expect(carousel.disabled).toBe(true);
    expect(carousel.textContent).toBe("Reviews carouselA page shows up to 8 app sections.");
    act(() => container.querySelector<HTMLButtonElement>('[data-section-row="app-0"] button:nth-of-type(2)')!.click());
    expect(document.querySelector("#theme-section-app-0-values-count-note")?.textContent).toBe("Use 12 or less.");
  });

  it("offers no Apps group when no active app has a section", () => {
    render(themeWith(HOME), { apps: [{ ...APPS[0]!, sections: [] }] });
    openAdd();
    expect(groupHeadings()).toEqual([]);
    expect(option("Reviews carousel")).toBeUndefined();
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

const openTab = (name: string) => act(() => [...container.querySelectorAll<HTMLButtonElement>("[role=tab]")].find((tab) => tab.textContent === name)!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
const confirm = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("[role=alertdialog] button")].find((each) => each.textContent === name)!;
const workspaceResult = (draft: StorefrontThemeDocument, live: StorefrontThemeDocument = themeWith(HOME)) => ({
  published: { theme: live, revision: 1 },
  draft: { theme: draft, revision: 2, basePublishedRevision: 1, updatedAt: null },
  lastPublished: null,
});

describe("theme editor: history and safeguards", () => {
  it("returns to the current draft preview as soon as the merchant edits it", async () => {
    api.versions.mockResolvedValue({ versions: [{ revision: 8, theme: themeWith(HOME), changes: [], summary: [], note: "Earlier campaign", publishedByName: null, createdAt: null }] });
    render();
    openTab("History");
    await vi.waitFor(() => expect(container.textContent).toContain("Earlier campaign"));
    act(() => button("Preview version").click());
    expect(preview.props.sourceRevision).toBe(8);
    openTab("Sections");
    act(() => container.querySelector<HTMLButtonElement>('[data-section-row="rail"] button:nth-of-type(2)')!.click());
    type(field("theme-section-rail-title"), "Fresh campaign");
    expect(preview.props.sourceRevision).toBeUndefined();
  });

  it("previews immutable history, compares it with the draft and restores only after confirmation", async () => {
    const old = themeWith(HOME.map((each) => each.id === "rail" ? { ...each, settings: { ...each.settings, title: "Old honey" } } as StorefrontSection : each));
    api.versions.mockResolvedValue({ versions: [{ revision: 8, theme: old, changes: [{ kind: "settings", page: "home", sectionId: "rail" }], summary: [], note: "Eid campaign", publishedByName: "Rahima", createdAt: "2026-10-03T10:30:00Z" }] });
    api.restore.mockResolvedValue(workspaceResult(old));
    render();
    expect(api.versions).not.toHaveBeenCalled();
    openTab("History");
    await vi.waitFor(() => expect(container.textContent).toContain("Eid campaign"));
    expect(container.textContent).toContain("Published by Rahima at");
    act(() => button("Preview version").click());
    expect(preview.props.sourceRevision).toBe(8);
    act(() => button("Compare with draft").click());
    expect(container.querySelector('ul[aria-label="Compare with draft"]')?.textContent).toContain("Homepage: changed Old honey");
    act(() => button("Restore to draft").click());
    expect(api.restore).not.toHaveBeenCalled();
    expect(document.querySelector("[role=alertdialog]")?.textContent).toContain("Your live store changes only when you publish.");
    await act(async () => confirm("Restore to draft").click());
    expect(api.restore).toHaveBeenCalledWith({ body: { sourceRevision: 8, expectedDraftRevision: 1, basePublishedRevision: 1 } });
    expect(api.publish).not.toHaveBeenCalled();
    expect(preview.props.sourceRevision).toBeUndefined();
    expect(container.textContent).toContain("Not published");
    openTab("Sections");
    expect(rowText("rail")).toBe("Old honey");
  });

  it("discards the shared draft with confirmation and keeps the live revision", async () => {
    const live = storefrontTemplateTheme("boutique");
    api.discard.mockResolvedValue(workspaceResult(live, live));
    render(themeWith(HOME), { published: live });
    openTab("History");
    act(() => button("Discard draft").click());
    expect(api.discard).not.toHaveBeenCalled();
    await act(async () => confirm("Discard draft").click());
    expect(api.discard).toHaveBeenCalledWith({ body: { expectedDraftRevision: 1, basePublishedRevision: 1 } });
    expect(api.publish).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Live");
    expect(button("Undo").disabled).toBe(true);
  });

  it("reloads a conflict explicitly without silently retaining an overlapping local value", async () => {
    const newer = themeWith(HOME.map((each) => each.id === "rail" ? { ...each, settings: { ...each.settings, title: "Their honey" } } as StorefrontSection : each));
    const refetch = vi.fn(async () => ({ data: workspaceResult(newer) as unknown as ThemeWorkspaceDocument }));
    api.draft.mockRejectedValueOnce(new AdminApiResponseError("Draft changed", 409, "CONFLICT"));
    render(themeWith(HOME), { refetch });
    act(() => container.querySelector<HTMLButtonElement>('[data-section-row="rail"] button:nth-of-type(2)')!.click());
    type(field("theme-section-rail-title"), "Mine");
    await autosaved();
    await vi.waitFor(() => expect(button("Reload draft")).toBeDefined());
    await act(async () => button("Reload draft").click());
    expect(field("theme-section-rail-title").value).toBe("Their honey");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(api.draft).toHaveBeenCalledTimes(1);
  });

  it("guards unsaved edits, sends a merchant publish note and shows the last author", async () => {
    render(themeWith(HOME), { published: storefrontTemplateTheme("boutique"), lastPublished: { revision: 1, publishedBy: "staff_1", publishedByName: "Rahima", createdAt: "2026-10-03T10:30:00Z" } });
    expect(container.textContent).toContain("Last published by Rahima at");
    act(() => container.querySelector<HTMLButtonElement>('[data-section-row="rail"] button:nth-of-type(2)')!.click());
    type(field("theme-section-rail-title"), "Fresh");
    expect((blocker.mock.calls.at(-1) as unknown as [{ enableBeforeUnload: boolean }])[0].enableBeforeUnload).toBe(true);
    await autosaved();
    await vi.waitFor(() => expect((blocker.mock.calls.at(-1) as unknown as [{ enableBeforeUnload: boolean }])[0].enableBeforeUnload).toBe(false));
    api.publish.mockResolvedValue(workspaceResult(lastSaved().theme));
    act(() => button("Publish").click());
    type(field<HTMLTextAreaElement>("theme-publish-note"), "Eid launch");
    await act(async () => confirm("Publish theme").click());
    expect(api.publish.mock.calls[0]![0].body.note).toBe("Eid launch");
  });

  it("lets the add picker move focus with arrow keys and search without matches", () => {
    render();
    act(() => button("Add section").click());
    const options = [...document.querySelectorAll<HTMLButtonElement>("[role=option]:not(:disabled)")];
    act(() => options[0]!.focus());
    act(() => options[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(document.activeElement).toBe(options[1]);
    const search = document.querySelector<HTMLInputElement>('input[aria-label="Search…"]')!;
    type(search, "no-such-section");
    expect(document.querySelector('[role=listbox]')?.textContent).toBe("No matches.");
  });

  it("hides and shows sections with undo and includes local layout thumbnails in the add picker", async () => {
    render();
    openMenu("Actions for New honey");
    act(() => button("Hide").click());
    expect(rowText("rail")).toBe("New honeyHidden on your store");
    await autosaved();
    expect(lastSaved().theme.pages.home[1]!.hidden).toBe(true);
    expect(preview.send).toHaveBeenCalledWith({ type: "reload" });
    act(() => button("Undo").click());
    expect(rowText("rail")).toBe("New honey");
    act(() => button("Redo").click());
    openMenu("Actions for New honey");
    act(() => button("Show").click());
    expect(rowText("rail")).toBe("New honey");
    act(() => button("Add section").click());
    expect(document.querySelectorAll("[data-section-thumbnail]").length).toBeGreaterThan(10);
    expect(document.querySelector('[role=option]')?.textContent).toContain("A page has one.");
    expect([...document.querySelectorAll('[role=option]')].find((option) => option.textContent?.startsWith("Questions and answers"))?.textContent).toContain("Answer common questions.");
  });
});

describe("theme editor: page templates", () => {
  it("creates a landing page, edits it with the same section form and previews its path", async () => {
    render();
    act(() => button("Add landing page").click());
    type(field("new-landing-title"), "Eid offers");
    type(field("new-landing-slug"), "eid-offers");
    act(() => button("Create page").click());
    expect(preview.props.previewPath).toBe("/pages/eid-offers");
    act(() => button("Add section").click());
    act(() => [...document.querySelectorAll<HTMLButtonElement>("[role=option]")].find((option) => option.textContent?.startsWith("Questions and answers"))!.click());
    type(field("theme-section-faq-heading"), "Eid delivery");
    await autosaved();
    const page = lastSaved().theme.pages.landing["eid-offers"]!;
    expect(page.title).toBe("Eid offers");
    expect(page.sections[0]).toMatchObject({ id: "faq", type: "faq", settings: { heading: "Eid delivery" } });
    expect(storefrontThemeDocumentSchema.safeParse(lastSaved().theme).success).toBe(true);
    act(() => button("All sections").click());
    act(() => field<HTMLButtonElement>("landing-override").click());
    await autosaved(2);
    expect(lastSaved().theme.pages.landing["eid-offers"]!.overrideCms).toBe(true);
  });

  it("returns to the homepage when undo removes a newly created landing page", () => {
    render();
    act(() => button("Add landing page").click());
    type(field("new-landing-title"), "Sale"); type(field("new-landing-slug"), "sale");
    act(() => button("Create page").click());
    expect(preview.props.previewPath).toBe("/pages/sale");
    act(() => button("Undo").click());
    expect(preview.props.previewPath).toBe("/");
    expect(rows()).toEqual(["hero", "rail", "faq"]);
  });

  it("rejects reserved or duplicate landing handles before creating a page", () => {
    const theme = themeWith(HOME);
    theme.pages.landing = { sale: { title: "Sale", sections: [], overrideCms: false } };
    render(theme);
    act(() => button("Add landing page").click());
    type(field("new-landing-title"), "Another sale");
    for (const slug of ["sale", "checkout", "Sale now", "pages"]) {
      type(field("new-landing-slug"), slug);
      expect(button("Create page").disabled).toBe(true);
    }
  });

  it("previews only a valid URL for the selected fixed template, and waits until blur", () => {
    render();
    choose(field<HTMLButtonElement>("theme-editor-page"), "Product");
    expect(button("Preview").disabled).toBe(true);
    type(field("template-preview-path"), "/products/honey");
    expect(button("Preview").disabled).toBe(true);
    act(() => { field("template-preview-path").focus(); field("template-preview-path").blur(); });
    expect(preview.props.previewPath).toBe("/products/honey");
    expect(button("Preview").disabled).toBe(false);
    choose(field<HTMLButtonElement>("theme-editor-page"), "Collection and category");
    expect(button("Preview").disabled).toBe(true);
    type(field("template-preview-path"), "//attacker.example/");
    act(() => { field("template-preview-path").focus(); field("template-preview-path").blur(); });
    expect(button("Preview").disabled).toBe(true);
    expect(field("template-preview-path").getAttribute("aria-invalid")).toBe("true");
    type(field("template-preview-path"), "/categories/honey");
    act(() => { field("template-preview-path").focus(); field("template-preview-path").blur(); });
    expect(preview.props.previewPath).toBe("/categories/honey");
    choose(field<HTMLButtonElement>("theme-editor-page"), "Product");
    expect(preview.props.previewPath).toBe("/products/honey");
  });

  it("reorders and hides fixed product blocks with undo, and saves collection grid density", async () => {
    render();
    choose(field<HTMLButtonElement>("theme-editor-page"), "Product");
    const blocks = () => [...container.querySelectorAll<HTMLElement>("[data-template-block]")].map((each) => each.dataset.templateBlock);
    act(() => button("Move down: Gallery").click());
    expect(blocks().slice(0, 2)).toEqual(["title-price", "gallery"]);
    act(() => button("Hide: Gallery").click());
    await autosaved();
    expect(lastSaved().theme.pages.product.blocks[1]).toEqual({ id: "gallery", hidden: true });
    act(() => button("Undo").click());
    expect(button("Hide: Gallery")).toBeDefined();
    act(() => button("Undo").click());
    expect(blocks()[0]).toBe("gallery");
    choose(field<HTMLButtonElement>("theme-editor-page"), "Collection and category");
    choose(field<HTMLButtonElement>("template-grid-density"), "Dense");
    await autosaved(2);
    expect(lastSaved().theme.tokens.density).toBe("dense");
    choose(field<HTMLButtonElement>("theme-editor-page"), "Search");
    expect(preview.props.previewPath).toBe("/search");
    act(() => button("Phone").click());
    expect(preview.props.device).toBe("phone");
  });
});


describe("theme editor: Bangla", () => {
  it("uses Bangla for history changes, landing controls and template block actions", async () => {
    act(() => setLocale("bn"));
    api.versions.mockResolvedValue({ versions: [{ revision: 8, theme: themeWith(HOME), changes: [{ kind: "reordered", page: "home" }], summary: ["home: sections reordered"], note: null, publishedByName: "রহিমা", createdAt: "2026-10-03T10:30:00Z" }] });
    render();
    expect(container.textContent).toContain("ল্যান্ডিং পেজ যোগ করুন");
    openTab("ইতিহাস");
    await vi.waitFor(() => expect(container.textContent).toContain("হোমপেজ: সেকশন বা ব্লকের ক্রম বদলেছে"));
    expect(container.textContent).not.toContain("home: sections reordered");
    openTab("সেকশন");
    choose(field<HTMLButtonElement>("theme-editor-page"), "পণ্য");
    expect(button("লুকান: গ্যালারি")).toBeDefined();
    expect(container.textContent).toContain("কেনার বোতাম");
  });
});
