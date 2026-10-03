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
import { PermissionProvider } from "~/contexts/PermissionContext";
import { setLocale } from "~/i18n";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import type { ThemeWorkspaceDocument } from "~/lib/api-query-options/online-store";
import { ThemeEditor } from "./ThemeEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  draft: vi.fn(), publish: vi.fn(), restore: vi.fn(), discard: vi.fn(), versions: vi.fn(), document: vi.fn(), resources: vi.fn(),
}));
const preview = vi.hoisted(() => ({ send: vi.fn(), open: vi.fn(), select: null as null | ((id: string) => void), props: {} as { sourceRevision?: number; previewPath?: string; device?: string; names?: Record<string, string> } }));
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
  getApiV1AdminSettingsThemeDocument: api.document,
  getApiV1AdminNavigationResources: api.resources,
  getApiV1AdminCategoriesFormOptions: vi.fn(async () => ({
    categories: [{ id: "cat_honey", name: "Honey", status: "published" }, { id: "cat_ghee", name: "Ghee", status: "published" }],
  })),
  getApiV1AdminCollections: vi.fn(async () => ({ collections: [], pagination: { page: 1, totalPages: 1 } })),
  getApiV1AdminCollectionsByIds: vi.fn(async () => ({ collections: [] })),
  getApiV1AdminDiscounts: vi.fn(async () => ({ discounts: [] })),
  getApiV1AdminProducts: vi.fn(async () => ({ products: [], pagination: { page: 1, totalPages: 1 } })),
  getApiV1AdminProductsByIds: vi.fn(async () => ({ products: [] })),
}));
vi.mock("sonner", () => ({ toast: toasts }));
vi.mock("../type-preview-fonts", () => ({ registerTypePreviewFonts: vi.fn() }));
vi.mock("../theme-preview", () => ({ useOpenThemePreview: () => preview.open }));
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
  Link: ({ to, children, params: _params, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; params?: unknown; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));
// The frame is its own unit (PreviewFrame.test.tsx): here it records what the editor tells it.
vi.mock("./PreviewFrame", () => ({
  PreviewFrame: function FakeFrame(props: { sourceRevision?: number; previewPath?: string; device?: string; names?: Record<string, string>; onSelect: (id: string) => void; controller: unknown }) {
    preview.select = props.onSelect;
    preview.props = props;
    useImperativeHandle(props.controller as never, () => ({ send: preview.send }));
    return <div data-fake-preview />;
  },
}));

let root: Root;
let container: HTMLDivElement;

const RESOURCES = {
  product: { id: "prod_honey", name: "Sundarbans honey", type: "product", url: "/products/sundarbans-honey", available: true },
  collection: { id: "col_eid", name: "Eid picks", type: "collection", url: "/collections/col_eid", available: true },
  category: { id: "cat_honey", name: "Honey", type: "category", url: "/categories/honey", available: true },
  page: { id: "page_about", name: "About us", type: "page", url: "/about-us", available: true },
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  act(() => setLocale("en"));
  api.versions.mockResolvedValue({ versions: [], nextBeforeRevision: null, retained: 20 });
  api.resources.mockImplementation(async ({ query }: { query: { type: keyof typeof RESOURCES } }) => ({ items: [RESOURCES[query.type]], selected: null, nextCursor: null }));
  let revision = 1;
  // Saves answer a revision receipt: the editor keeps its own document.
  api.draft.mockImplementation(async () => ({ revision: (revision += 1), basePublishedRevision: 1, updatedAt: null }));
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

function workspaceOf(draft: StorefrontThemeDocument, options: {
  published?: StorefrontThemeDocument;
  draftRevision?: number;
  apps?: ThemeWorkspaceDocument["apps"];
  shape?: typeof SHAPE;
  lastPublished?: ThemeWorkspaceDocument["lastPublished"];
} = {}): ThemeWorkspaceDocument {
  const published = options.published ?? draft;
  return {
    published: { theme: published, revision: 1 },
    draft: { theme: draft, revision: options.draftRevision ?? 1, basePublishedRevision: 1, updatedAt: null },
    draftDiffersFromLive: JSON.stringify(published) !== JSON.stringify(draft),
    lastPublished: options.lastPublished ?? null,
    storeShape: options.shape ?? SHAPE,
    media: [],
    apps: options.apps ?? [],
  } as unknown as ThemeWorkspaceDocument;
}

function render(theme: StorefrontThemeDocument = themeWith(HOME), options: Parameters<typeof workspaceOf>[1] & {
  refetch?: () => Promise<{ data?: ThemeWorkspaceDocument }>;
  /** Staff permissions; editing needs settings.general.edit. */
  permissions?: string[];
} = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  const workspace = workspaceOf(theme, options);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <PermissionProvider permissions={options.permissions ?? ["settings.general.view", "settings.general.edit"]}>
          <ThemeEditor workspace={workspace} refetch={options.refetch ?? (async () => ({ data: workspace }))} />
        </PermissionProvider>
      </QueryClientProvider>,
    );
  });
}

const button = (name: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)
  ?? [...document.querySelectorAll<HTMLElement>("button, [role=menuitem]")].find((each) => each.textContent?.trim() === name) as HTMLButtonElement;
const rows = () => [...container.querySelectorAll<HTMLElement>("[data-section-row]")].map((row) => row.dataset.sectionRow);
const selectButton = (id: string) => container.querySelector<HTMLButtonElement>(`[data-section-row="${id}"] button:not([aria-label])`)!;
const rowText = (id: string) => selectButton(id)?.textContent;
const part = (id: string) => container.querySelector<HTMLButtonElement>(`[data-part-row="${id}"]`)!;
const panelTitle = () => container.querySelector("[data-settings-panel] h2")?.textContent;
const field = <Element extends HTMLElement = HTMLInputElement>(id: string) => document.querySelector<Element>(`#${CSS.escape(id)}`)!;
const lastSaved = () => api.draft.mock.calls.at(-1)![0].body as { theme: StorefrontThemeDocument; expectedDraftRevision: number };
/** A button on one version in the Versions sheet. */
const versionButton = (revision: number, name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>(`[data-theme-version="${revision}"] button`)].find((each) => each.textContent?.trim() === name)!;
const status = () => container.querySelector("header [role=status]")?.textContent;

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

function menuItem(name: string) {
  return [...document.querySelectorAll<HTMLElement>("[role=menuitem]")].find((each) => each.textContent?.trim() === name)!;
}

function choose(trigger: HTMLButtonElement, label: string) {
  act(() => trigger.click());
  const option = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
    .find((item) => item.textContent?.trim().startsWith(label));
  expect(option).toBeDefined();
  act(() => option!.click());
}

/** The page picker: open it and choose a page by its name. */
async function goTo(name: string) {
  act(() => container.querySelector<HTMLButtonElement>("[data-page-picker]")!.click());
  const item = [...document.querySelectorAll<HTMLElement>("[cmdk-item]")].find((each) => each.textContent?.trim().startsWith(name));
  expect(item, name).toBeDefined();
  await act(async () => item!.click());
  await settle();
}

/** Waits for the debounced autosave to send a draft. */
const autosaved = (times = 1) => vi.waitFor(() => expect(api.draft).toHaveBeenCalledTimes(times), { timeout: 3000 });
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const confirm = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("[role=alertdialog] button")].find((each) => each.textContent === name)!;
const openTab = (name: string) => act(() => [...container.querySelectorAll<HTMLButtonElement>("[role=tab]")].find((tab) => tab.textContent === name)!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));

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

describe("theme editor: the page tree", () => {
  it("shows the header group, the homepage's sections and the footer group, saying why buyers don't see some", () => {
    const boutique = storefrontTemplateTheme("boutique");
    render({ ...boutique, pages: { ...boutique.pages, home: [...boutique.pages.home, storefrontSectionDefault("newsletter", "signup")] } });
    expect([...container.querySelectorAll("[data-part-row]")].map((row) => row.getAttribute("data-part-row")))
      .toEqual(["announcement", "header", "page-settings", "footer"]);
    expect(rowText("signup")).toBe("Newsletter");
    // A hero without slides shows nothing until its slides are added.
    expect(rowText(boutique.pages.home.find((each) => each.type === "hero")!.id)).toBe("BannersHidden until you add its content.");
    expect(preview.props.previewPath).toBe("/");
  });

  it("reorders sections from the keyboard: Space, an arrow, Space; then saves and reloads the preview", async () => {
    render();
    stackRows();
    const handle = button("Reorder New honey");
    act(() => handle.focus());
    act(() => { handle.dispatchEvent(new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true })); });
    await settle();
    act(() => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", code: "ArrowDown", bubbles: true })); });
    await settle();
    act(() => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true })); });
    await settle();
    expect(rows()).toEqual(["hero", "faq", "rail"]);
    await autosaved();
    expect(lastSaved().theme.pages.home.map((each) => each.id)).toEqual(["hero", "faq", "rail"]);
    expect(lastSaved().expectedDraftRevision).toBe(1);
    expect(preview.send).toHaveBeenCalledWith({ type: "reload" });
  });

  it("moves, duplicates, hides and removes a section from its row, with an undo in the toast", async () => {
    render();
    openMenu("Actions for Questions");
    act(() => menuItem("Move up").click());
    expect(rows()).toEqual(["hero", "faq", "rail"]);
    openMenu("Actions for New honey");
    act(() => menuItem("Duplicate").click());
    expect(rows()).toEqual(["hero", "faq", "rail", "product-rail"]);
    // One hero per page: it cannot be copied.
    openMenu("Actions for Banners");
    expect(menuItem("Duplicate").getAttribute("aria-disabled") ?? menuItem("Duplicate").getAttribute("data-disabled")).not.toBeNull();
    act(() => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    // The eye hides a section in place.
    act(() => button("Hide New honey").click());
    expect(rowText("rail")).toBe("New honeyHidden");
    act(() => button("Show New honey").click());
    expect(rowText("rail")).toBe("New honey");
    openMenu("Actions for New honey");
    act(() => menuItem("Remove").click());
    expect(rows()).toEqual(["hero", "faq", "product-rail"]);
    const [message, options] = toasts.success.mock.calls.at(-1) as [string, { action: { label: string; onClick: () => void }; duration: number }];
    expect(message).toBe("Section removed");
    expect(options.duration).toBe(10_000);
    act(() => options.action.onClick());
    expect(rows()).toEqual(["hero", "faq", "rail", "product-rail"]);
  });

  it("adds a section from the illustrated picker with its availability notes, then opens and saves it", async () => {
    render(themeWith(HOME), { shape: storeShapeFromFacts({ productCount: 3, skuCount: 3, topCategoryCount: 1, categoryDepth: 1, menu: [], hasCollections: false, hasDeliveryMethods: true }) });
    act(() => button("Add section").click());
    expect(document.querySelectorAll("[data-section-thumbnail]").length).toBeGreaterThan(10);
    const options = [...document.querySelectorAll<HTMLElement>("[role=option]")];
    expect(options.find((option) => option.textContent?.startsWith("Featured categories"))!.textContent).toContain("Needs 2 or more categories (you have 1).");
    const hero = options.find((option) => option.textContent?.startsWith("Banners"))!;
    expect(hero.textContent).toContain("A page has one.");
    expect((hero as HTMLButtonElement).disabled).toBe(true);
    act(() => options.find((option) => option.textContent?.startsWith("Questions and answers"))!.click());
    expect(panelTitle()).toBe("Questions and answers");
    type(field("theme-section-faq-2-heading"), "Delivery");
    await autosaved();
    expect(lastSaved().theme.pages.home.at(-1)).toEqual({ id: "faq-2", type: "faq", version: 1, settings: { heading: "Delivery", items: [] } });
  });
});

describe("theme editor: settings and saving", () => {
  it("saves a section's setting by itself and re-renders only that section", async () => {
    render();
    act(() => selectButton("rail").click());
    expect(panelTitle()).toBe("Product row");
    type(field("theme-section-rail-title"), "Fresh honey");
    expect(status()).toContain("Unsaved changes");
    await autosaved();
    expect(lastSaved().theme.pages.home[1]!.settings).toMatchObject({ title: "Fresh honey" });
    await vi.waitFor(() => expect(preview.send).toHaveBeenCalledWith({ type: "section-updated", sectionIds: ["rail"] }));
    expect(status()).toContain("Draft saved");
  });

  it("selects what a click in the preview names, and goes back to the page's tree", () => {
    render();
    // The preview names every page's header, announcement bar and footer, and the page's sections.
    expect(Object.keys(preview.props.names!)).toEqual(["announcement", "header", "footer", "hero", "rail", "faq"]);
    act(() => preview.select!("faq"));
    expect(panelTitle()).toBe("Questions and answers");
    act(() => preview.select!("header"));
    expect(panelTitle()).toBe("Header");
    act(() => preview.select!("footer"));
    expect(panelTitle()).toBe("Footer");
    act(() => button("Back to the page").click());
    expect(rows()).toEqual(["hero", "rail", "faq"]);
  });

  it("will not save settings the schema rejects, and says where", async () => {
    render();
    act(() => selectButton("faq").click());
    type(field("theme-section-faq-items-0-question"), "");
    expect(document.querySelector("#theme-section-faq-items-0-question-note")?.textContent).toBe("Fill this in.");
    expect(status()).toContain("Fix the marked settings to save");
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(api.draft).not.toHaveBeenCalled();
  });

  it("undoes and redoes edits, typing in one field as one step", async () => {
    render();
    act(() => selectButton("rail").click());
    type(field("theme-section-rail-title"), "N");
    type(field("theme-section-rail-title"), "Ne");
    type(field("theme-section-rail-title"), "New");
    act(() => button("Undo").click());
    expect(field("theme-section-rail-title").value).toBe("New honey");
    expect(button("Undo").disabled).toBe(true);
    act(() => button("Redo").click());
    expect(field("theme-section-rail-title").value).toBe("New");
    act(() => button("Undo").click());
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(api.draft).not.toHaveBeenCalled();
    // ⌘Z outside a field undoes too; inside a field it is the field's own.
    act(() => button("Redo").click());
    act(() => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true })));
    expect(field("theme-section-rail-title").value).toBe("New honey");
  });

  it("keeps the edits on a conflict, then explicitly overwrites using the latest revision", async () => {
    const newer = themeWith(HOME.map((each) => each.id === "faq" ? { ...each, settings: { ...each.settings, heading: "Their questions" } } as StorefrontSection : each));
    const refetch = vi.fn(async () => ({ data: workspaceOf(newer, { draftRevision: 5 }) }));
    render(themeWith(HOME), { refetch });
    api.draft.mockRejectedValueOnce(new AdminApiResponseError("Draft changed", 409, "CONFLICT"));
    act(() => selectButton("rail").click());
    type(field("theme-section-rail-title"), "Mine");
    await autosaved();
    await vi.waitFor(() => expect(container.textContent).toContain("Someone else changed this theme."));
    expect(field("theme-section-rail-title").value).toBe("Mine");
    await act(async () => button("Overwrite with my edits").click());
    expect(refetch).toHaveBeenCalledTimes(1);
    await autosaved(2);
    expect(lastSaved().expectedDraftRevision).toBe(5);
    expect(lastSaved().theme.pages.home.find((each) => each.id === "rail")!.settings).toMatchObject({ title: "Mine" });
  });

  it("reloads a conflict explicitly without silently keeping the overlapping local value", async () => {
    const newer = themeWith(HOME.map((each) => each.id === "rail" ? { ...each, settings: { ...each.settings, title: "Their honey" } } as StorefrontSection : each));
    const refetch = vi.fn(async () => ({ data: workspaceOf(newer, { draftRevision: 2 }) }));
    api.draft.mockRejectedValueOnce(new AdminApiResponseError("Draft changed", 409, "CONFLICT"));
    render(themeWith(HOME), { refetch });
    act(() => selectButton("rail").click());
    type(field("theme-section-rail-title"), "Mine");
    await autosaved();
    await vi.waitFor(() => expect(button("Reload draft")).toBeDefined());
    await act(async () => button("Reload draft").click());
    expect(field("theme-section-rail-title").value).toBe("Their honey");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(api.draft).toHaveBeenCalledTimes(1);
  });

  it("marks a rejected image on its section row and in its settings", async () => {
    render();
    const message = "That image is not in Files any more. Choose another image.";
    api.draft.mockRejectedValueOnce(new AdminApiResponseError(message, 400, "VALIDATION_ERROR", [
      { path: "theme.pages.home.0.settings.slides.0.image", message },
    ]));
    act(() => selectButton("rail").click());
    type(field("theme-section-rail-title"), "Fresh");
    await autosaved();
    await vi.waitFor(() => expect(container.textContent).toContain(message));
    act(() => button("Back to the page").click());
    expect(rowText("hero")).toBe(`Banners${message}`);
    act(() => selectButton("hero").click());
    expect(document.querySelector("#theme-section-hero-slides-0-image-note")?.textContent).toBe(message);
  });

  it("guards unsaved edits, publishes with a note after confirmation and shows who published", async () => {
    render(themeWith(HOME), { published: storefrontTemplateTheme("boutique"), lastPublished: { revision: 1, publishedBy: "staff_1", publishedByName: "Rahima", createdAt: "2026-10-03T10:30:00Z" } as never });
    expect(status()).toContain("Published by Rahima,");
    expect(container.textContent).toContain("Unpublished changes");
    act(() => selectButton("rail").click());
    type(field("theme-section-rail-title"), "Fresh");
    expect((blocker.mock.calls.at(-1) as unknown as [{ enableBeforeUnload: boolean }])[0].enableBeforeUnload).toBe(true);
    await autosaved();
    await vi.waitFor(() => expect((blocker.mock.calls.at(-1) as unknown as [{ enableBeforeUnload: boolean }])[0].enableBeforeUnload).toBe(false));
    api.publish.mockResolvedValue({
      published: { revision: 2 }, draft: { revision: 3, basePublishedRevision: 2, updatedAt: null }, draftDiffersFromLive: false,
      lastPublished: { revision: 2, publishedBy: "staff_2", publishedByName: "Karim", createdAt: "2026-10-03T11:00:00Z" },
    });
    act(() => button("Publish").click());
    type(field<HTMLTextAreaElement>("theme-publish-note"), "Eid launch");
    await act(async () => confirm("Publish theme").click());
    expect(api.publish.mock.calls[0]![0].body).toEqual({ expectedPublishedRevision: 1, expectedDraftRevision: 2, note: "Eid launch" });
    expect(container.textContent).toContain("Live");
    expect(status()).toContain("Published by Karim,");
  });

  it("opens the saved draft of the page being edited in a new tab", async () => {
    render();
    openMenu("More actions");
    act(() => menuItem("Preview").click());
    expect(preview.open).toHaveBeenCalledWith(1, "/", "full", undefined);
  });

  it("lets staff who may only view settings browse the theme without changing it", async () => {
    render(themeWith(HOME), { permissions: ["settings.general.view"] });
    expect(status()).toBe("You can view this theme but not change it.");
    expect(button("Publish")).toBeUndefined();
    expect(button("Add section")).toBeUndefined();
    expect(container.querySelector('button[aria-label="Reorder New honey"]')).toBeNull();
    act(() => selectButton("rail").click());
    expect(container.querySelector<HTMLFieldSetElement>("[data-settings-panel] fieldset")?.disabled).toBe(true);
    type(field("theme-section-rail-title"), "Mine");
    // The settings stay as saved: nothing is sent.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(api.draft).not.toHaveBeenCalled();
  });

  it("switches the preview to a 390px phone", () => {
    render();
    act(() => button("Phone").click());
    expect(preview.props.device).toBe("phone");
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
      ],
    }],
    productBlocks: [{ key: "acme.reviews/stars", type: "stars", name: "Star rating", placement: "buy-box", settings: [] }],
  }];
  const appSection = (id: string, values: Record<string, unknown>, app = CAROUSEL) =>
    ({ id, type: "app", version: 1, settings: { app, values } }) as StorefrontSection;
  const option = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("[role=option]")].find((each) => each.textContent?.startsWith(label));

  it("adds an app's section at its defaults and saves it once its settings are valid", async () => {
    render(themeWith(HOME), { apps: APPS });
    act(() => button("Add section").click());
    expect([...document.querySelectorAll("[role=presentation]")].map((each) => each.textContent)).toEqual(["Sections", "Apps"]);
    act(() => option("Reviews carousel")!.click());
    expect(panelTitle()).toBe("Reviews carousel");
    expect(field("theme-section-app-values-heading").value).toBe("What buyers say");
    expect(status()).toContain("Fix the marked settings to save");
    type(field<HTMLTextAreaElement>("theme-section-app-values-intro"), "Loved by 2,000 buyers");
    await autosaved();
    expect(lastSaved().theme.pages.home.at(-1)).toEqual({
      id: "app", type: "app", version: 1,
      settings: { app: CAROUSEL, values: { heading: "What buyers say", intro: "Loved by 2,000 buyers", count: 4 } },
    });
    expect(storefrontThemeDocumentSchema.safeParse(lastSaved().theme).success).toBe(true);
    act(() => button("Back to the page").click());
    expect(rowText("app")).toBe("Reviews carouselFrom Acme Reviews");
  });

  it("keeps a section whose app is not active, says so, and marks values its app refuses", () => {
    render(themeWith([...HOME, appSection("banner", { text: "Eid sale" }, "acme.gone/banner"), appSection("bad", { intro: "Hi", count: 40 })]), { apps: APPS });
    expect(rowText("banner")).toBe("acme.gone/bannerApp not active. Hidden on your store.");
    expect(rowText("bad")).toBe("Reviews carouselFix its settings to save.");
    act(() => selectButton("banner").click());
    expect(container.textContent).toContain("This section's app isn't active, so your store doesn't show it.");
  });
});

describe("theme editor: header, footer and theme settings", () => {
  it("edits the logo in Theme settings, and the announcement bar and footer from their rows", async () => {
    render();
    openTab("Theme settings");
    files.next = [{ id: "media_logo", url: "https://cdn.test/logo.png", altText: "Mou Ghor" }];
    act(() => [...document.querySelectorAll<HTMLButtonElement>("#theme-brand-logo button")].find((each) => each.textContent === "Select image")!.click());
    openTab("Sections");
    act(() => part("announcement").click());
    expect(panelTitle()).toBe("Announcement bar");
    choose(field<HTMLButtonElement>("theme-top-bar"), "Announcement");
    type(field("theme-blocks-topBar-settings-text"), "Free delivery in Dhaka");
    act(() => button("Back to the page").click());
    act(() => part("footer").click());
    type(field("theme-blocks-footer-settings-tagline"), "Pure honey");
    await autosaved();
    const saved = lastSaved().theme;
    expect(saved.brand.logo).toBe("media_logo");
    expect(saved.blocks.topBar).toMatchObject({ variant: "announcement", settings: { text: "Free delivery in Dhaka" } });
    expect(saved.blocks.footer.settings).toMatchObject({ tagline: "Pure honey" });
    expect(preview.send).toHaveBeenCalledWith({ type: "reload" });
  });

  it("chooses menu styles under Header, saying what does not fit the store", async () => {
    const marketplace = storefrontTemplateTheme("marketplace");
    render({ ...marketplace, pages: { ...marketplace.pages, homeMode: { kind: "sections" } } });
    act(() => part("header").click());
    act(() => container.querySelector<HTMLButtonElement>('[role=radio][value="mega-panel"]')!.click());
    expect(container.textContent).toContain("Your store shows Dropdown instead.");
    act(() => field<HTMLButtonElement>("theme-blocks-desktopNav-settings-promoImages").click());
    await autosaved();
    expect(lastSaved().theme.blocks.desktopNav).toEqual({ variant: "mega-panel", settings: { promoImages: true } });
  });

  it("sets what the home page shows in its settings, and will not save a one-product homepage without its product", async () => {
    render();
    act(() => part("page-settings").click());
    expect(panelTitle()).toBe("Home page settings");
    expect(container.textContent).toContain("What shoppers see first at your store's address.");
    act(() => container.querySelector<HTMLButtonElement>('[role=radio][value="product"]')!.click());
    expect(status()).toContain("Fix the marked settings to save");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(api.draft).not.toHaveBeenCalled();
  });
});

describe("theme editor: product, collection, category, search and CMS pages", () => {
  it("previews the store's first product and edits the product page's information and modules", async () => {
    render();
    await goTo("Products");
    await vi.waitFor(() => expect(preview.props.previewPath).toBe("/products/sundarbans-honey"));
    expect(container.querySelector("[data-preview-resource=product]")?.textContent).toContain("Sundarbans honey");
    expect(part("product-main")).toBeDefined();
    // Shown modules first, in page order; the others hidden after them.
    const below = DEFAULT_STOREFRONT_THEME.blocks.product.below;
    expect(rows().slice(0, below.length)).toEqual(below.map((module) => `module-${module}`));
    expect(rowText("module-policies")).toBe("Store policies");
    act(() => button("Show Store policies").click());
    await autosaved();
    expect(lastSaved().theme.blocks.product.below).toContain("policies");
    act(() => button(`Hide ${below[0] === "description" ? "Description" : "Reviews"}`).click());
    await autosaved(2);
    expect(lastSaved().theme.blocks.product.below).not.toContain(below[0]);
    act(() => button("Undo").click());
    expect(rows()[0]).toBe(`module-${below[0]}`);
    // The preview names and selects the product page's marked parts.
    expect(preview.props.names).toMatchObject({ "product-main": "Product information" });
    act(() => preview.select!("product-main"));
    expect(panelTitle()).toBe("Product information");
    act(() => container.querySelector<HTMLButtonElement>('[role=radio][value="stacked"]')!.click());
    act(() => field<HTMLButtonElement>("theme-sticky-phone-buy-bar").click());
    await vi.waitFor(() => expect(lastSaved().theme.blocks.product.gallery.variant).toBe("stacked"));
  });

  it("edits collection and category pages' toolbar, filters and grid, and search's own layout", async () => {
    render();
    await goTo("Collections");
    await vi.waitFor(() => expect(preview.props.previewPath).toBe("/collections/col_eid"));
    act(() => part("listing-toolbar").click());
    act(() => field<HTMLButtonElement>("theme-listing-toolbar-breadcrumb").click());
    act(() => button("Back to the page").click());
    act(() => part("listing").click());
    act(() => container.querySelector<HTMLButtonElement>('[role=radio][value="dense"]')!.click());
    await autosaved();
    expect(lastSaved().theme.blocks.listing.toolbar).not.toContain("breadcrumb");
    expect(lastSaved().theme.tokens.density).toBe("dense");
    await goTo("Categories");
    await vi.waitFor(() => expect(preview.props.previewPath).toBe("/categories/honey"));
    await goTo("Search results");
    expect(preview.props.previewPath).toBe("/search");
    act(() => part("listing").click());
    expect(container.textContent).toContain("Search results start as");
  });

  it("previews a CMS page and points to where its words are edited", async () => {
    render();
    await goTo("Pages");
    await vi.waitFor(() => expect(preview.props.previewPath).toBe("/about-us"));
    act(() => part("page-settings").click());
    expect(panelTitle()).toBe("Page content");
    expect(container.querySelector("[data-settings-panel] a")?.textContent).toBe("Edit page content");
  });

  it("says when the store has nothing to preview a page with", async () => {
    api.resources.mockResolvedValue({ items: [], selected: null, nextCursor: null });
    render();
    await goTo("Products");
    await vi.waitFor(() => expect(container.textContent).toContain("Add a product to preview product pages."));
  });
});

describe("theme editor: landing pages", () => {
  async function createLanding(title: string, slug?: string) {
    await goTo("New landing page");
    type(field("new-landing-title"), title);
    if (slug !== undefined) type(field("new-landing-slug"), slug);
    act(() => button("Create page").click());
    await settle();
  }

  it("creates a landing page with a handle from its title, composes it from sections and previews its address", async () => {
    render();
    await createLanding("Eid Offers");
    expect(preview.props.previewPath).toBe("/pages/eid-offers");
    act(() => button("Add section").click());
    act(() => [...document.querySelectorAll<HTMLButtonElement>("[role=option]")].find((option) => option.textContent?.startsWith("Questions and answers"))!.click());
    type(field("theme-section-faq-heading"), "Eid delivery");
    await autosaved();
    const page = lastSaved().theme.pages.landing["eid-offers"]!;
    expect(page).toMatchObject({ title: "Eid Offers", description: "", sections: [{ id: "faq", type: "faq", settings: { heading: "Eid delivery" } }] });
    expect(storefrontThemeDocumentSchema.safeParse(lastSaved().theme).success).toBe(true);
    act(() => button("Back to the page").click());
    act(() => part("page-settings").click());
    type(field<HTMLTextAreaElement>("landing-description"), "Eid gifts, delivered.");
    await autosaved(2);
    expect(lastSaved().theme.pages.landing["eid-offers"]!.description).toBe("Eid gifts, delivered.");
    act(() => button("Delete landing page").click());
    act(() => confirm("Delete landing page").click());
    expect(preview.props.previewPath).toBe("/");
    await autosaved(3);
    expect(lastSaved().theme.pages.landing).toEqual({});
  });

  it("returns to the home page when undo removes a newly created landing page", async () => {
    render();
    await createLanding("Sale", "sale");
    expect(preview.props.previewPath).toBe("/pages/sale");
    act(() => button("Undo").click());
    await settle();
    expect(preview.props.previewPath).toBe("/");
    expect(rows()).toEqual(["hero", "rail", "faq"]);
  });

  it("refuses reserved or taken handles before creating a page", async () => {
    const theme = themeWith(HOME);
    theme.pages.landing = { sale: { title: "Sale", description: "", sections: [] } };
    render(theme);
    await goTo("New landing page");
    type(field("new-landing-title"), "Another sale");
    for (const slug of ["sale", "checkout", "Sale now", "pages"]) {
      type(field("new-landing-slug"), slug);
      expect(button("Create page").disabled, slug).toBe(true);
    }
    expect(container.ownerDocument.body.textContent).toContain("Use lowercase letters");
  });
});

describe("theme editor: versions", () => {
  const VERSION = (revision: number, extra: Record<string, unknown> = {}) => ({
    id: `themev_${revision}`, revision, source: "publish", sourceRevision: null, publishedBy: "staff_1", publishedByName: "Rahima",
    createdAt: "2026-10-03T10:30:00Z", changes: [], moreChanges: 0, note: null, ...extra,
  });
  const openVersions = async () => {
    openMenu("More actions");
    act(() => menuItem("Versions").click());
    await vi.waitFor(() => expect(document.body.textContent).toContain("Version 8"));
  };

  it("lists who published what with readable changes, previews a version and returns to the draft on the next edit", async () => {
    api.versions.mockResolvedValue({ versions: [VERSION(8, { note: "Eid campaign", changes: [
      { kind: "section-changed", page: "home", sectionId: "rail", sectionType: "product-rail" },
      { kind: "sections-reordered", page: "home" },
      { kind: "settings-changed", area: "colors" },
    ], moreChanges: 2 })], nextBeforeRevision: null, retained: 20 });
    render();
    expect(api.versions).not.toHaveBeenCalled();
    await openVersions();
    const text = document.body.textContent!;
    expect(text).toContain("Eid campaign");
    expect(text).toContain("Published by Rahima,");
    expect(text).toContain("New honey changed on Home page");
    expect(text).toContain("Sections reordered on Home page");
    expect(text).toContain("Colours changed");
    expect(text).toContain("and 2 more changes");
    act(() => versionButton(8, "Preview").click());
    expect(preview.props.sourceRevision).toBe(8);
    expect(container.querySelector("[data-version-banner]")?.textContent).toContain("Previewing version 8.");
    act(() => selectButton("rail").click());
    type(field("theme-section-rail-title"), "Fresh campaign");
    expect(preview.props.sourceRevision).toBeUndefined();
  });

  it("compares a version with the draft and restores it only to the draft, after confirmation", async () => {
    const old = themeWith(HOME.map((each) => each.id === "rail" ? { ...each, settings: { ...each.settings, title: "Old honey" } } as StorefrontSection : each));
    api.versions.mockResolvedValue({ versions: [VERSION(8)], nextBeforeRevision: null, retained: 20 });
    api.document.mockResolvedValue({ source: "version", revision: 8, document: old });
    api.restore.mockResolvedValue({ published: { revision: 1 }, draft: { revision: 2, basePublishedRevision: 1, updatedAt: null }, draftDiffersFromLive: true, lastPublished: null });
    const refetch = vi.fn(async () => ({ data: workspaceOf(old, { published: themeWith(HOME), draftRevision: 2 }) }));
    render(themeWith(HOME), { refetch });
    await openVersions();
    act(() => versionButton(8, "Compare with draft").click());
    await vi.waitFor(() => expect(document.querySelector('ul[aria-label="Compare with draft"]')?.textContent).toContain("New honey changed on Home page"));
    expect(api.document).toHaveBeenCalledWith({ query: { source: "version", revision: 8 } });
    act(() => versionButton(8, "Restore to draft").click());
    expect(api.restore).not.toHaveBeenCalled();
    expect(document.querySelector("[role=alertdialog]")?.textContent).toContain("Your store changes only when you publish.");
    await act(async () => confirm("Restore to draft").click());
    expect(api.restore).toHaveBeenCalledWith({ body: { sourceRevision: 8, expectedDraftRevision: 1, basePublishedRevision: 1 } });
    expect(api.publish).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(rowText("rail")).toBe("Old honey"));
    expect(container.textContent).toContain("Unpublished changes");
  });

  it("discards the draft with confirmation and reloads the live theme", async () => {
    const live = storefrontTemplateTheme("boutique");
    api.discard.mockResolvedValue({ published: { revision: 1 }, draft: { revision: 2, basePublishedRevision: 1, updatedAt: null }, draftDiffersFromLive: false, lastPublished: null });
    const refetch = vi.fn(async () => ({ data: workspaceOf(live, { draftRevision: 2 }) }));
    render(themeWith(HOME), { published: live, refetch });
    openMenu("More actions");
    act(() => menuItem("Discard draft").click());
    expect(api.discard).not.toHaveBeenCalled();
    await act(async () => confirm("Discard draft").click());
    expect(api.discard).toHaveBeenCalledWith({ body: { expectedDraftRevision: 1, basePublishedRevision: 1 } });
    await vi.waitFor(() => expect(container.textContent).toContain("Live"));
    expect(button("Undo").disabled).toBe(true);
  });

  it("previews a version's home page when it predates the landing page being edited", async () => {
    const theme = themeWith(HOME);
    theme.pages.landing = { sale: { title: "Sale", description: "", sections: [] } };
    api.versions.mockResolvedValue({ versions: [VERSION(8)], nextBeforeRevision: null, retained: 20 });
    api.document.mockResolvedValue({ source: "version", revision: 8, document: themeWith(HOME) });
    render(theme);
    await goTo("Sale");
    expect(preview.props.previewPath).toBe("/pages/sale");
    await openVersions();
    act(() => versionButton(8, "Preview").click());
    await vi.waitFor(() => expect(preview.props).toMatchObject({ sourceRevision: 8, previewPath: "/" }));
    expect(container.querySelector("[data-version-banner]")?.textContent).toContain("It has no such landing page");
  });
});

describe("theme editor: Bangla", () => {
  it("names the tree, pages and version changes in Bangla", async () => {
    act(() => setLocale("bn"));
    api.versions.mockResolvedValue({ versions: [{
      id: "themev_8", revision: 8, source: "publish", sourceRevision: null, publishedBy: "staff_1", publishedByName: "রহিমা",
      createdAt: "2026-10-03T10:30:00Z", changes: [{ kind: "sections-reordered", page: "home" }], moreChanges: 0, note: null,
    }], nextBeforeRevision: null, retained: 20 });
    render();
    expect(container.textContent).toContain("ঘোষণার বার");
    expect(container.textContent).toContain("হোম পেজ");
    openMenu("আরও অ্যাকশন");
    act(() => menuItem("সংস্করণ").click());
    await vi.waitFor(() => expect(document.body.textContent).toContain("হোম পেজ-এ সেকশনের ক্রম বদলেছে"));
    act(() => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await goTo("পণ্য");
    expect(container.textContent).toContain("পণ্যের তথ্য");
  });
});
