// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, StrictMode, useEffect, type AnchorHTMLAttributes, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_STOREFRONT_THEME,
  storeShapeFromFacts,
  storefrontSectionDefault,
  storefrontThemeDocumentSchema,
  type StorefrontSection,
  type StorefrontSectionType,
  type StorefrontThemeDocument,
} from "@scalius/shared/storefront-theme";
import type { ThemeTextField, ThemePreviewField, ThemePreviewRect } from "@scalius/shared/theme-editor-bridge";
import { PermissionProvider } from "~/contexts/PermissionContext";
import { setLocale } from "~/i18n";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import type { ThemeWorkspaceDocument } from "~/lib/api-query-options/online-store";
import { ThemeEditor } from "./ThemeEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  draft: vi.fn(), publish: vi.fn(), restore: vi.fn(), restorePoint: vi.fn(), discard: vi.fn(), versions: vi.fn(), points: vi.fn(),
  document: vi.fn(), resources: vi.fn(), aiProviders: vi.fn(), aiDraft: vi.fn(),
}));
/** The fake frame: what the editor sends it, and the bridge's own callbacks. */
const frame = vi.hoisted(() => ({
  send: vi.fn(), reload: vi.fn(),
  path: null as string | null,
  shownPath: undefined as string | undefined,
  loading: false,
  failed: false,
  onSelect: null as null | ((id: string, field?: ThemeTextField) => void),
  onEditText: null as null | ((id: string, field: ThemeTextField, rect?: ThemePreviewRect) => void),
  field: null as ThemePreviewField | null,
  rects: {} as Record<string, readonly [number, number, number, number]>,
}));
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }));
const navigation = vi.hoisted(() => ({ blocker: vi.fn((_options: { enableBeforeUnload?: boolean }) => ({ status: "idle" })) }));

vi.mock("~/lib/api", () => ({ apiData: (call: unknown) => call }));
vi.mock("@scalius/api-client/sdk", () => ({
  postApiV1AdminSettingsThemeDraft: api.draft,
  postApiV1AdminSettingsThemePublish: api.publish,
  postApiV1AdminSettingsThemeRestore: api.restore,
  postApiV1AdminSettingsThemeRestorePoint: api.restorePoint,
  postApiV1AdminSettingsThemeDiscard: api.discard,
  getApiV1AdminSettingsThemeVersions: api.versions,
  getApiV1AdminSettingsThemeRestorePoints: api.points,
  getApiV1AdminSettingsThemeDocument: api.document,
  getApiV1AdminSettingsThemeAiProviders: api.aiProviders,
  postApiV1AdminSettingsThemeAiDraft: api.aiDraft,
  getApiV1AdminNavigationResources: api.resources,
  getApiV1AdminSettingsMarkets: vi.fn(async () => ({ items: [] })),
  getApiV1AdminCategoriesFormOptions: vi.fn(async () => ({ categories: [] })),
  getApiV1AdminCollections: vi.fn(async () => ({ collections: [], pagination: { page: 1, totalPages: 1 } })),
  getApiV1AdminCollectionsByIds: vi.fn(async () => ({ collections: [] })),
  getApiV1AdminDiscounts: vi.fn(async () => ({ discounts: [] })),
  getApiV1AdminProducts: vi.fn(async () => ({ products: [], pagination: { page: 1, totalPages: 1 } })),
  getApiV1AdminProductsByIds: vi.fn(async () => ({ products: [] })),
}));
vi.mock("~/lib/toast", async (importActual) => ({ ...(await importActual<typeof import("~/lib/toast")>()), toast: toasts }));
vi.mock("sonner", () => ({ toast: toasts }));
vi.mock("../type-preview-fonts", () => ({ registerTypePreviewFonts: vi.fn() }));
vi.mock("../theme-preview", () => ({ useOpenThemePreview: () => vi.fn(), isSafeThemePreviewContinuation: () => true }));
vi.mock("~/components/admin/media-manager", () => ({ MediaManager: ({ trigger }: { trigger: ReactNode }) => <span>{trigger}</span> }));
vi.mock("@tanstack/react-router", () => ({
  useBlocker: navigation.blocker,
  useNavigate: () => vi.fn(),
  Link: ({ to, children, params: _params, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; params?: unknown; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));
// The frame and its bridge are their own units (the storefront's bridge tests): here a ready frame records commands.
vi.mock("./use-preview", () => ({
  PREVIEW_HELLO_TIMEOUT_MS: 15_000,
  usePreview: (options: { path: string | null; onSelect: (id: string, field?: ThemeTextField) => void; onEditText: (id: string, field: ThemeTextField, rect?: ThemePreviewRect) => void; onConnected: () => void }) => {
    frame.path = options.path;
    frame.onSelect = options.onSelect;
    frame.onEditText = options.onEditText;
    useEffect(() => options.onConnected(), []); // eslint-disable-line react-hooks/exhaustive-deps -- once, as a frame connects
    const snapshot = { layout: { rects: frame.rects, field: frame.field, scrollY: 0, height: 2000 }, hovered: null };
    return {
      phase: "ready", origin: "https://shop.test", frames: [{ id: 1, src: "about:blank" }], activeId: 1,
      visuals: { getSnapshot: () => snapshot, subscribe: () => () => {} }, fieldTarget: frame.field, marks: ["rail", "faq", "story"], shownPath: frame.shownPath ?? options.path, fieldsEnabled: true, loading: frame.loading, failed: frame.failed,
      send: frame.send, reload: frame.reload, retry: vi.fn(), register: () => () => {},
    };
  },
}));

// ─── The window: a viewport width the media queries and the canvas follow ──

let viewport = 1440;
function setViewport(width: number) {
  viewport = width;
  window.matchMedia = ((query: string) => {
    const min = /min-width:\s*(\d+)px/.exec(query);
    return {
      matches: min ? width >= Number(min[1]) : false,
      media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    } as MediaQueryList;
  }) as typeof window.matchMedia;
}

/**
 * The canvas width as CSS lays it out, read from the editor's own DOM: the
 * window less the sidebar (when its column is open) and the settings column
 * (when present). A change that made a panel push the canvas would show here.
 */
function canvasWidth(): number {
  const sidebar = document.querySelector<HTMLElement>("[data-theme-editor] aside[aria-label='Sections and settings']");
  const sidebarWidth = sidebar && !sidebar.className.includes("fixed") && sidebar.className.split(/\s+/).includes("w-80") ? 320 : 0;
  const settingsColumn = document.querySelector("[data-theme-editor] aside[aria-label='Settings']") ? 320 : 0;
  return viewport - sidebarWidth - settingsColumn;
}

class FakeResizeObserver {
  constructor(private readonly callback: (entries: unknown[], observer: unknown) => void) {}
  /** Only the canvas measures itself here; other observers wait for real entries. */
  observe(element: Element) { if (element.hasAttribute?.("data-editor-canvas")) this.callback([], this); }
  unobserve() {}
  disconnect() {}
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  frame.rects = {};
  frame.field = null;
  frame.shownPath = undefined;
  frame.loading = false;
  frame.failed = false;
  act(() => setLocale("en"));
  setViewport(1440);
  try { window.localStorage.clear(); } catch { /* none */ }
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute("data-editor-canvas") ? canvasWidth() : 0;
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute("data-editor-canvas") ? 852 : 0;
  });
  api.versions.mockResolvedValue({ versions: [], nextBeforeRevision: null, retained: 20 });
  api.points.mockResolvedValue({ restorePoints: [] });
  api.resources.mockResolvedValue({ items: [], selected: null, nextCursor: null });
  api.aiProviders.mockResolvedValue({ items: [] });
  let revision = 1;
  api.draft.mockImplementation(async () => ({ revision: (revision += 1), basePublishedRevision: 1, updatedAt: null }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setLocale("en");
  container.remove();
});

const SHAPE = storeShapeFromFacts({
  productCount: 40, skuCount: 60, topCategoryCount: 5, categoryDepth: 1, menu: [{}, {}, {}, {}, {}], hasCollections: true, hasDeliveryMethods: true,
});

const section = (type: StorefrontSectionType, id: string, settings: Record<string, unknown> = {}) =>
  ({ ...storefrontSectionDefault(type, id), settings: { ...storefrontSectionDefault(type, id).settings, ...settings } }) as StorefrontSection;

const HOME = [
  section("product_rail", "rail", { title: "New honey" }),
  section("faq", "faq", { heading: "Questions", items: [{ question: "Is it raw?", answer: "Yes." }] }),
  section("seo_text", "story", { heading: "Our story", body: "From the Sundarbans." }),
];

function themeWith(home: StorefrontSection[], base: StorefrontThemeDocument = DEFAULT_STOREFRONT_THEME): StorefrontThemeDocument {
  return { ...base, pages: { ...base.pages, home, homeMode: { kind: "sections" } } };
}

function workspaceOf(draft: StorefrontThemeDocument, published: StorefrontThemeDocument = draft, apps: ThemeWorkspaceDocument["apps"] = []): ThemeWorkspaceDocument {
  return {
    published: { theme: published, revision: 1 },
    draft: { theme: draft, revision: 1, basePublishedRevision: 1, updatedAt: null, updatedByName: null },
    draftDiffersFromLive: JSON.stringify(published) !== JSON.stringify(draft),
    lastPublished: null,
    storeShape: SHAPE,
    media: [],
    apps,
  } as unknown as ThemeWorkspaceDocument;
}

function render(theme: StorefrontThemeDocument = themeWith(HOME), options: {
  published?: StorefrontThemeDocument;
  permissions?: string[];
  refetch?: () => Promise<{ data?: ThemeWorkspaceDocument }>;
  apps?: ThemeWorkspaceDocument["apps"];
  /** A store that never saved a draft (revision 0). */
  noDraft?: boolean;
  strict?: boolean;
} = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  const workspace = workspaceOf(theme, options.published, options.apps);
  if (options.noDraft) (workspace.draft as { revision: number }).revision = 0;
  const editor = (
    <QueryClientProvider client={queryClient}>
      <PermissionProvider permissions={options.permissions ?? ["settings.general.view", "settings.general.edit", "settings.theme.edit"]}>
        <ThemeEditor workspace={workspace} refetch={options.refetch ?? (async () => ({ data: workspace }))} />
      </PermissionProvider>
    </QueryClientProvider>
  );
  act(() => {
    root.render(options.strict ? <StrictMode>{editor}</StrictMode> : editor);
  });
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const autosaved = (times = 1) => vi.waitFor(() => expect(api.draft).toHaveBeenCalledTimes(times), { timeout: 3000 });
const lastSaved = () => api.draft.mock.calls.at(-1)![0].body as { theme: StorefrontThemeDocument; expectedDraftRevision: number };
const button = (name: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)
  ?? [...document.querySelectorAll<HTMLButtonElement>("button")].find((each) => each.textContent?.trim() === name)!;
const row = (id: string) => container.querySelector<HTMLElement>(`[data-tree-row="${CSS.escape(id)}"]`)!;
const pageRows = () => [...container.querySelectorAll<HTMLElement>("[data-tree-group='page'] [role=treeitem][aria-level='1']")].map((each) => each.dataset.treeRow);
const status = () => container.querySelector("[data-save-status]")?.getAttribute("data-save-status");
const field = <Element extends HTMLElement = HTMLInputElement>(id: string) => document.querySelector<Element>(`#${CSS.escape(id)}`)!;
/** The frame's box: where the scaled frame sits, and the storefront's own viewport and scale. */
const frameStyle = () => `${container.querySelector("[data-preview-box]")!.getAttribute("style")} ${container.querySelector("[data-preview-frame]")!.getAttribute("style")}`;
/** Panes and dialogs load after the first render: wait for one to be there. */
const ready = (selector: string) => vi.waitFor(() => expect(document.querySelector(selector)).toBeTruthy());
const key = (target: Element, init: KeyboardEventInit) => act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init })); });

function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  act(() => {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("theme editor: canvas notices", () => {
  it("collapses without navigation or resizing, preserves focus, and reopens the actions", () => {
    frame.shownPath = "/products/another-page";
    render();
    const geometry = frameStyle();
    const toggle = button("Hide preview notice");
    act(() => { toggle.focus(); toggle.click(); });
    expect(button("Show preview notice")).toBe(toggle);
    expect(document.activeElement).toBe(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("[data-canvas-notice] [hidden]")).toBeTruthy();
    expect(frame.reload).not.toHaveBeenCalled();
    expect(api.draft).not.toHaveBeenCalled();
    expect(frameStyle()).toBe(geometry);
    act(() => toggle.click());
    expect(button("Hide preview notice")).toBe(toggle);
    expect(document.activeElement).toBe(toggle);
    expect(container.querySelector("[data-canvas-notice] [hidden]")).toBeNull();
    act(() => button("Back to Home page").click());
    expect(frame.reload).toHaveBeenCalledTimes(1);
  });

  it("stays collapsed through refresh, but reappears for another destination or a new visit", () => {
    const theme = themeWith(HOME);
    frame.shownPath = "/products/one";
    render(theme);
    act(() => button("Hide preview notice").click());
    render(theme);
    expect(button("Show preview notice")).toBeTruthy();
    frame.loading = true;
    render(theme);
    expect(container.querySelector("[data-canvas-notice]")).toBeNull();
    frame.loading = false;
    render(theme);
    expect(button("Show preview notice")).toBeTruthy();
    frame.shownPath = "/products/two";
    render(theme);
    expect(button("Hide preview notice")).toBeTruthy();
    frame.shownPath = "/products/one";
    render(theme);
    expect(button("Hide preview notice")).toBeTruthy();
    act(() => button("Hide preview notice").click());
    frame.shownPath = undefined;
    render(theme);
    expect(container.querySelector("[data-canvas-notice]")).toBeNull();
    frame.shownPath = "/products/two";
    render(theme);
    expect(button("Hide preview notice")).toBeTruthy();
    expect(api.draft).not.toHaveBeenCalled();
  });

  it("reveals a new preview failure over a collapsed route message without clearing it", () => {
    const theme = themeWith(HOME);
    frame.shownPath = "/products/one";
    render(theme);
    act(() => button("Hide preview notice").click());
    frame.failed = true;
    render(theme);
    expect(button("Hide preview notice")).toBeTruthy();
    expect(container.querySelector("[data-canvas-notice]")?.textContent).toContain("The preview couldn't load.");
    expect(button("Try again")).toBeTruthy();
    act(() => button("Hide preview notice").click());
    expect(frame.failed).toBe(true);
    expect(button("Show preview notice").querySelector(".text-warning")).toBeTruthy();
  });

  it("keeps the way back to the draft available when a historical preview fails", async () => {
    api.versions.mockResolvedValue({ versions: [{ revision: 1, createdAt: "2026-10-13T00:00:00Z", changes: [], moreChanges: 0 }], nextBeforeRevision: null, retained: 20 });
    render();
    act(() => button("Versions").click());
    await ready("[data-theme-version='1']");
    act(() => document.querySelector<HTMLButtonElement>("[data-theme-version='1'] button")!.click());
    expect(button("Back to draft")).toBeTruthy();
    frame.failed = true;
    render();
    expect(button("Try again")).toBeTruthy();
    act(() => button("Back to draft").click());
    expect(button("Back to draft")).toBeUndefined();
    expect(api.restore).not.toHaveBeenCalled();
    expect(api.draft).not.toHaveBeenCalled();
  });
});

describe("theme editor: layers", () => {
  it("starts with nothing selected, with shared parts around the page's sections in ARIA trees", () => {
    // From 1600 px the settings column is always there, empty until something is selected.
    setViewport(1600);
    render();
    expect(container.querySelectorAll("[role=tree]").length).toBeGreaterThanOrEqual(2);
    expect(pageRows()).toEqual(["page-settings", "rail", "faq", "story", "add-section"]);
    expect(row("header")).toBeTruthy();
    expect(row("footer")).toBeTruthy();
    expect(container.querySelector("[role=treeitem][aria-selected=true]")).toBeNull();
    expect(container.textContent).toContain("Nothing selected");
  });

  it("moves a row with Alt+Down, saves it, and moves the section in the frame at once", async () => {
    render();
    act(() => row("rail").focus());
    key(row("rail"), { key: "ArrowDown", altKey: true });
    expect(pageRows()).toEqual(["page-settings", "faq", "rail", "story", "add-section"]);
    expect(frame.send).toHaveBeenCalledWith(expect.objectContaining({ type: "arrange", region: "page", order: ["faq", "rail", "story"], revision: expect.any(Number) }));
    await autosaved();
    expect(lastSaved().theme.pages.home.map((each) => each.id)).toEqual(["faq", "rail", "story"]);
    expect(lastSaved().expectedDraftRevision).toBe(1);
  });

  it("picks a row up with Space, moves it with the arrows and drops it", async () => {
    render();
    act(() => row("story").focus());
    key(row("story"), { key: " " });
    key(row("story"), { key: "ArrowUp" });
    key(row("story"), { key: "ArrowUp" });
    key(row("story"), { key: " " });
    expect(pageRows()).toEqual(["page-settings", "story", "rail", "faq", "add-section"]);
  });

  it("selects from the frame and from the tree, and opens a section's settings", () => {
    render();
    act(() => frame.onSelect!("faq"));
    expect(row("faq").getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector("[data-editor-canvas]")?.textContent).not.toContain("Questions");
    act(() => row("rail").click());
    expect(row("rail").getAttribute("aria-selected")).toBe("true");
    expect(frame.send).toHaveBeenCalledWith({ type: "reveal", id: "rail" });
  });
});

describe("theme editor: live preview and saving", () => {
  it("draws unmarked catalog copy canonically, then autosaves", async () => {
    render();
    act(() => row("rail").click());
    await ready("#theme-section-rail-title");
    type(field("theme-section-rail-title"), "Fresh honey");
    expect(frame.send.mock.calls.some(([command]) => command.type === "text")).toBe(false);
    await vi.waitFor(() => expect(frame.send).toHaveBeenCalledWith(expect.objectContaining({
      type: "render",
      body: expect.objectContaining({ scope: { kind: "home" }, only: "rail" }),
    })));
    await autosaved();
    expect(lastSaved().theme.pages.home[0]!.settings).toMatchObject({ title: "Fresh honey" });
    await vi.waitFor(() => expect(status()).toBe("saved"));
  });

  it("holds back only the section with an invalid field; the rest keeps saving", async () => {
    render();
    act(() => row("faq").click());
    await ready("#theme-section-faq-heading");
    type(field("theme-section-faq-heading"), "x".repeat(200));
    act(() => row("story").click());
    await ready("#theme-section-story-heading");
    type(field("theme-section-story-heading"), "Our honey story");
    await autosaved();
    const saved = lastSaved().theme.pages.home;
    expect(saved.find((each) => each.id === "faq")!.settings).toMatchObject({ heading: "Questions" });
    expect(saved.find((each) => each.id === "story")!.settings).toMatchObject({ heading: "Our honey story" });
    await vi.waitFor(() => expect(status()).toBe("held"));
    expect(container.querySelector("[data-save-status]")!.textContent).toContain("1 setting to fix");
  });

  it("names a setting to fix in the publish summary instead of 'No changes', and takes the cursor to it", async () => {
    render();
    act(() => row("faq").click());
    await ready("#theme-section-faq-heading");
    type(field("theme-section-faq-heading"), "x".repeat(200));
    await vi.waitFor(() => expect(status()).toBe("held"));
    act(() => row("rail").click());
    act(() => button("Publish").click());
    await ready("[data-publish-dialog]");
    const dialog = document.querySelector("[data-publish-dialog]")!;
    expect(dialog.querySelector("[data-publish-held]")?.textContent).toContain("1 setting needs fixing before your edit can be saved or published");
    expect(dialog.textContent).not.toContain("No changes.");
    // The held edit would not go live: publishing waits for it.
    const publish = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((each) => each.textContent === "Publish")!;
    expect(publish.disabled).toBe(true);
    act(() => [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((each) => each.textContent === "Fix it")!.click());
    await ready("#theme-section-faq-heading");
    await vi.waitFor(() => expect(document.activeElement).toBe(field("theme-section-faq-heading")));
    expect(document.querySelector("[data-publish-dialog]")).toBeNull();
  });

  it("keeps an edit that cannot be saved yet across a reload of the editor", async () => {
    render();
    act(() => row("faq").click());
    await ready("#theme-section-faq-heading");
    type(field("theme-section-faq-heading"), "x".repeat(200));
    await vi.waitFor(() => expect(status()).toBe("held"));
    await vi.waitFor(() => expect(window.localStorage.getItem("scalius.theme-editor.held-edits")).toContain("x".repeat(200)));

    // The editor opens again on the same draft revision: the held edit is back, still to fix.
    act(() => root.unmount());
    root = createRoot(container);
    render();
    await vi.waitFor(() => expect(status()).toBe("held"));
    expect(toasts.info).toHaveBeenCalledWith("Edits that weren't saved yet are back. Fix the setting to save them.");
    act(() => row("faq").click());
    await ready("#theme-section-faq-heading");
    expect(field("theme-section-faq-heading").value).toBe("x".repeat(200));
    // Fixed, it saves, and the kept copy goes.
    type(field("theme-section-faq-heading"), "Delivery questions");
    await autosaved();
    expect(lastSaved().theme.pages.home.find((each) => each.id === "faq")!.settings).toMatchObject({ heading: "Delivery questions" });
    await vi.waitFor(() => expect(window.localStorage.getItem("scalius.theme-editor.held-edits")).toBeNull());
  });

  it("calls a draft that matches what is live 'Live' whatever its key order (a discarded draft of a store that never published)", async () => {
    // The built-in default as an unpublished store reads it, and the same document as a saved draft reads back.
    const readBack = JSON.parse(JSON.stringify(storefrontThemeDocumentSchema.parse(DEFAULT_STOREFRONT_THEME))) as StorefrontThemeDocument;
    expect(JSON.stringify(readBack)).not.toBe(JSON.stringify(DEFAULT_STOREFRONT_THEME));
    render(readBack, { published: DEFAULT_STOREFRONT_THEME });
    await settle();
    expect(status()).toBe("saved");
    expect(container.querySelector("[data-save-status]")!.textContent).toContain("No changes");
    expect(container.textContent).toContain("Live");
    expect(container.textContent).not.toContain("Draft saved");
    expect(api.draft).not.toHaveBeenCalled();
  });

  it("opens the tab and group of a theme setting to fix, and puts the cursor in the field", async () => {
    render();
    const tab = (name: string) => [...container.querySelectorAll<HTMLButtonElement>("[role=tab]")].find((each) => each.textContent === name)!;
    const choose = (name: string) => act(() => tab(name).dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    choose("Theme settings");
    await vi.waitFor(() => expect([...document.querySelectorAll("h2 > button[aria-expanded]")].some((each) => each.textContent === "Colors")).toBe(true));
    const colors = () => [...document.querySelectorAll<HTMLButtonElement>("h2 > button[aria-expanded]")].find((each) => each.textContent === "Colors")!;
    act(() => colors().click());
    await ready("#theme-color-background");
    type(field("theme-color-background"), "bad-colour");
    await vi.waitFor(() => expect(status()).toBe("held"));
    // Collapse the group and leave the tab, as the merchant did.
    act(() => colors().click());
    choose("Sections");
    await vi.waitFor(() => expect(document.querySelector("#theme-color-background")).toBeNull());
    act(() => button("1 setting to fix").click());
    await ready("#theme-color-background");
    await vi.waitFor(() => expect(document.activeElement).toBe(field("theme-color-background")));
    expect(colors().getAttribute("aria-expanded")).toBe("true");
    expect(field("theme-color-background-note").textContent).toContain("Use a color code");
  });

  it("on a phone, the setting to fix switches the bottom bar to Theme, opens the group and focuses the field", async () => {
    setViewport(390);
    render();
    const bar = (name: string) => [...container.querySelectorAll<HTMLButtonElement>("nav[aria-label='Editor'] button")].find((each) => each.textContent === name)!;
    const colors = () => [...document.querySelectorAll<HTMLButtonElement>("h2 > button[aria-expanded]")].find((each) => each.textContent === "Colors")!;
    act(() => bar("Theme").click());
    await vi.waitFor(() => expect(colors()).toBeTruthy());
    act(() => colors().click());
    await ready("#theme-color-background");
    type(field("theme-color-background"), "bad-colour");
    await vi.waitFor(() => expect(status()).toBe("held"));
    act(() => colors().click());
    act(() => bar("Layers").click());
    await vi.waitFor(() => expect(document.querySelector("#theme-color-background")).toBeNull());
    // On a phone the status dot is the control: a real target, not a clipped screen-reader-only button.
    expect(button("1 setting to fix").className).not.toContain("sr-only");
    expect(button("1 setting to fix").querySelector("[aria-hidden]")).toBeTruthy();
    act(() => button("1 setting to fix").click());
    await ready("#theme-color-background");
    await vi.waitFor(() => expect(document.activeElement).toBe(field("theme-color-background")));
    expect(colors().getAttribute("aria-expanded")).toBe("true");
    const drawer = container.querySelector<HTMLElement>("aside[aria-label='Sidebar']");
    expect(drawer?.hasAttribute("inert") ?? false).toBe(false);
  });

  it("on a phone, keeps toasts above the Layers / Theme / Add bar, and on a computer lifts nothing", () => {
    const lift = () => document.documentElement.style.getPropertyValue("--toast-lift");
    const height = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(56);
    try {
      setViewport(390);
      render();
      expect(container.querySelector("nav[aria-label='Editor']")).toBeTruthy();
      expect(lift()).toBe("56px");
      act(() => root.unmount());
      expect(lift()).toBe("");
      root = createRoot(container);
      setViewport(1440);
      render();
      expect(lift()).toBe("");
    } finally {
      height.mockRestore();
    }
  });

  it("undoes and redoes across autosave", async () => {
    render();
    act(() => row("rail").focus());
    key(row("rail"), { key: "ArrowDown", altKey: true });
    await autosaved();
    act(() => button("Undo").click());
    expect(pageRows()).toEqual(["page-settings", "rail", "faq", "story", "add-section"]);
    await autosaved(2);
    expect(lastSaved().theme.pages.home.map((each) => each.id)).toEqual(["rail", "faq", "story"]);
    key(window.document.body, { key: "z", ctrlKey: true, shiftKey: true });
    expect(pageRows()).toEqual(["page-settings", "faq", "rail", "story", "add-section"]);
  });

  it("keeps the edits on a conflict, names who saved, and overwrites only when asked", async () => {
    const theme = themeWith(HOME);
    const theirs = workspaceOf(themeWith([HOME[2]!]));
    (theirs.draft as { revision: number; updatedByName: string | null }).revision = 5;
    (theirs.draft as { updatedByName: string | null }).updatedByName = "Rahima";
    api.draft.mockRejectedValueOnce(new AdminApiResponseError("Theme draft changed", 409, "conflict"));
    render(theme, { refetch: async () => ({ data: theirs }) });
    act(() => row("rail").focus());
    key(row("rail"), { key: "ArrowDown", altKey: true });
    await vi.waitFor(() => expect(container.textContent).toContain("Rahima saved this theme"));
    expect(status()).toBe("conflict");
    act(() => button("Hide preview notice").click());
    expect(status()).toBe("conflict");
    expect(api.draft).toHaveBeenCalledTimes(1);
    act(() => button("Show preview notice").click());
    expect(button("Overwrite with my edits")).toBeTruthy();
    expect(pageRows()).toEqual(["page-settings", "faq", "rail", "story", "add-section"]);
    await act(async () => button("Overwrite with my edits").click());
    await autosaved(2);
    expect(lastSaved().expectedDraftRevision).toBe(5);
    expect(lastSaved().theme.pages.home.map((each) => each.id)).toEqual(["faq", "rail", "story"]);
  });

  it("creates a store's first draft once on open, with no conflict, even when effects run twice", async () => {
    // The server answers 409 to a stale revision, as the real one does.
    let current = 0;
    api.draft.mockImplementation(async ({ body }: { body: { expectedDraftRevision: number } }) => {
      await Promise.resolve();
      if (body.expectedDraftRevision !== current) throw new AdminApiResponseError("Theme draft changed", 409, "conflict");
      return { revision: (current += 1), basePublishedRevision: 1, updatedAt: null };
    });
    render(themeWith(HOME), { noDraft: true, strict: true });
    await autosaved(1);
    await settle();
    expect(api.draft).toHaveBeenCalledTimes(1);
    expect(lastSaved().expectedDraftRevision).toBe(0);
    expect(status()).not.toBe("conflict");
  });

  it("saves now with Ctrl+S", async () => {
    render();
    act(() => row("rail").focus());
    key(row("rail"), { key: "ArrowDown", altKey: true });
    key(document.body, { key: "s", ctrlKey: true });
    await vi.waitFor(() => expect(api.draft).toHaveBeenCalledTimes(1), { timeout: 300 });
  });
});

describe("theme editor: sections and blocks", () => {
  it("keeps the insertion beside the same section when Undo moves it during browsing", async () => {
    render();
    frame.rects = { faq: [0, 400, 1280, 300] };
    act(() => row("faq").focus());
    key(row("faq"), { key: "ArrowDown", altKey: true });
    act(() => row("faq").click());
    await ready('button[aria-label="Add section above"]');
    act(() => button("Add section above").click());
    await ready("[data-section-library]");
    key(document.body, { key: "z", ctrlKey: true });
    expect(pageRows()).toEqual(["page-settings", "rail", "faq", "story", "add-section"]);
    act(() => document.querySelector<HTMLButtonElement>("[data-library-item='newsletter']")!.click());
    act(() => button("Add Newsletter").click());
    expect(pageRows()).toEqual(["page-settings", "rail", "newsletter", "faq", "story", "add-section"]);
    act(() => button("Undo").click());
    expect(pageRows()).toEqual(["page-settings", "rail", "faq", "story", "add-section"]);
  });

  it("adds a section from the library, saying why a second hero cannot be added", async () => {
    render(themeWith([section("hero", "hero"), ...HOME]));
    act(() => row("add-section").click());
    await ready("[data-section-library]");
    const library = document.querySelector("[data-section-library]")!;
    expect(library).toBeTruthy();
    const hero = library.querySelector<HTMLButtonElement>("[data-library-item='hero']")!;
    expect(hero.disabled).toBe(false);
    expect(hero.textContent).toContain("This page already has one.");
    act(() => hero.click());
    expect(button("Add Banners").disabled).toBe(true);
    act(() => library.querySelector<HTMLButtonElement>("[data-library-item='newsletter']")!.click());
    expect(pageRows()).toEqual(["page-settings", "hero", "rail", "faq", "story", "add-section"]);
    act(() => button("Add Newsletter").click());
    expect(pageRows()).toEqual(["page-settings", "hero", "rail", "faq", "story", "newsletter", "add-section"]);
    expect(row("newsletter").getAttribute("aria-selected")).toBe("true");
    await autosaved();
    expect(lastSaved().theme.pages.home.at(-1)).toMatchObject({ id: "newsletter", type: "newsletter" });
  });

  it("adds, hides and removes a block from the tree", async () => {
    render();
    act(() => row("faq").click());
    // A section's blocks are rows below it.
    act(() => button("Show the blocks of Questions").click());
    expect(row("faq/items/0")).toBeTruthy();
    act(() => row("faq/items/add").click());
    expect(row("faq/items/1").getAttribute("aria-selected")).toBe("true");
    await ready("#theme-section-faq-items-1-question");
    type(field("theme-section-faq-items-1-question"), "Do you deliver?");
    await ready("#theme-section-faq-items-1-answer");
    type(field<HTMLTextAreaElement>("theme-section-faq-items-1-answer"), "Yes, everywhere.");
    act(() => row("faq/items/0").querySelector<HTMLButtonElement>("button[aria-label^=Hide]")!.click());
    await autosaved();
    expect(lastSaved().theme.pages.home[1]!.settings).toMatchObject({
      items: [{ question: "Is it raw?", answer: "Yes.", hidden: true }, { question: "Do you deliver?", answer: "Yes, everywhere." }],
    });
  });

  it("removes a section with an undo in the toast", () => {
    render();
    act(() => row("story").click());
    act(() => [...document.querySelectorAll<HTMLButtonElement>("[role=toolbar] button")].find((each) => each.getAttribute("aria-label") === "Remove")?.click());
    // The canvas toolbar shows only with a measured part: the tree's Delete key does the same.
    if (pageRows().includes("story")) {
      act(() => row("story").focus());
      key(row("story"), { key: "Delete" });
    }
    expect(pageRows()).toEqual(["page-settings", "rail", "faq", "add-section"]);
    const undo = toasts.success.mock.calls.at(-1)![1] as { action: { onClick: () => void } };
    act(() => undo.action.onClick());
    expect(pageRows()).toEqual(["page-settings", "rail", "faq", "story", "add-section"]);
  });

  it("keeps a template's fixed part: it moves with the sections but cannot be removed", async () => {
    const base = themeWith(HOME);
    render({ ...base, pages: { ...base.pages, templates: { ...base.pages.templates, product: { sections: [section("faq", "faq")], main: 0 } } } });
    act(() => container.querySelector<HTMLButtonElement>("[data-page-picker]")!.click());
    const products = [...document.querySelectorAll<HTMLElement>("[cmdk-item]")].find((each) => each.textContent?.trim().startsWith("Products"))!;
    await act(async () => products.click());
    await settle();
    expect(pageRows()).toEqual(["product-main", "faq", "add-section"]);
    act(() => row("product-main").focus());
    key(row("product-main"), { key: "Delete" });
    expect(pageRows()).toEqual(["product-main", "faq", "add-section"]);
    key(row("product-main"), { key: "ArrowDown", altKey: true });
    expect(pageRows()).toEqual(["faq", "product-main", "add-section"]);
    await autosaved();
    expect(lastSaved().theme.pages.templates.product).toMatchObject({ main: 1 });
  });
});

describe("theme editor: AI drafts and publishing", () => {
  it("explains how to get AI when the store has none, without a dead control", async () => {
    render();
    act(() => row("add-section").click());
    await ready("[data-section-library]");
    const ai = [...document.querySelectorAll<HTMLButtonElement>("[data-section-library] button")].find((each) => each.textContent?.startsWith("Draft with AI"))!;
    await act(async () => ai.click());
    await vi.waitFor(() => expect(document.querySelector("[data-ai-draft]")?.textContent).toContain("Browse AI apps"));
    // Staff who may not connect an agent are told who can.
    expect(document.querySelector("[data-ai-draft]")!.textContent).toContain("Ask the store owner");
    expect(api.aiProviders).toHaveBeenCalledTimes(1);
  });

  it("adds drafted sections marked until opened, and the publish summary warns about unopened ones", async () => {
    api.aiProviders.mockResolvedValue({ items: [{ id: "acme.ai:writer", name: "Writer", appName: "Acme AI", appId: "acme.ai" }] });
    api.aiDraft.mockResolvedValue({ sections: [section("faq", "faq")], rejected: 1, note: null });
    api.publish.mockResolvedValue({ published: { revision: 2 }, draft: { revision: 9, basePublishedRevision: 2 }, lastPublished: null });
    render();
    act(() => row("add-section").click());
    await ready("[data-section-library]");
    const ai = [...document.querySelectorAll<HTMLButtonElement>("[data-section-library] button")].find((each) => each.textContent?.startsWith("Draft with AI"))!;
    await act(async () => ai.click());
    await vi.waitFor(() => expect(field<HTMLTextAreaElement>("ai-draft-prompt")).toBeTruthy());
    await ready("#ai-draft-prompt");
    type(field<HTMLTextAreaElement>("ai-draft-prompt"), "Questions about delivery");
    await act(async () => button("Create draft").click());
    await vi.waitFor(() => expect(pageRows()).toContain("faq-2"));
    expect(api.aiDraft.mock.calls[0]![0].body).toMatchObject({ providerId: "acme.ai:writer", prompt: "Questions about delivery", page: "home" });
    expect(row("faq-2").textContent).toContain("AI draft");
    expect(toasts.success).toHaveBeenCalledWith("Section drafted", { description: "A drafted section didn't fit this theme and was left out." });

    act(() => button("Publish").click());
    await ready("[data-publish-dialog]");
    const dialog = document.querySelector("[data-publish-dialog]")!;
    expect(dialog.textContent).toContain("Questions");
    expect(dialog.querySelector("[role=alert]")?.textContent ?? dialog.textContent).toMatch(/AI/);
    // Opening the section removes its mark.
    act(() => [...dialog.querySelectorAll<HTMLButtonElement>("ul button")][0]!.click());
    await settle();
    expect(row("faq-2").textContent).not.toContain("AI draft");
  });

  it("publishes with a note after saving", async () => {
    api.publish.mockResolvedValue({ published: { revision: 2 }, draft: { revision: 9, basePublishedRevision: 2 }, lastPublished: null });
    render();
    act(() => row("rail").focus());
    key(row("rail"), { key: "ArrowDown", altKey: true });
    await autosaved();
    act(() => button("Publish").click());
    await ready("[data-publish-dialog]");
    const dialog = document.querySelector("[data-publish-dialog]")!;
    expect(dialog.textContent).toContain("On your pages");
    await ready("#theme-publish-note");
    type(field<HTMLTextAreaElement>("theme-publish-note"), "Eid layout");
    await act(async () => [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((each) => each.textContent === "Publish")!.click());
    await vi.waitFor(() => expect(api.publish).toHaveBeenCalledTimes(1));
    expect(api.publish.mock.calls[0]![0].body).toMatchObject({ expectedPublishedRevision: 1, expectedDraftRevision: 2, note: "Eid layout" });
  });

  it("keeps the publish dialog open on apps that are not ready, naming their parts and linking each app", async () => {
    api.publish.mockRejectedValueOnce(new AdminApiResponseError("This theme uses parts of Noor theme, which is not active.", 400, "theme_apps_unavailable", {
      apps: [
        {
          pluginId: "scalius.noor",
          name: "Noor theme",
          reason: "app_inactive",
          parts: [
            { kind: "skin", type: "noor_header", target: "header", path: "apps.skins.header.app", place: { page: "theme" }, name: "Noor header" },
            { kind: "section", type: "studio_hero", path: "pages.home.2.settings.app", place: { page: "home", index: 2 }, name: "Studio hero" },
          ],
        },
        { pluginId: "acme.gone", reason: "app_inactive", parts: [{ kind: "product_block", type: "size_chart", path: "blocks.product.apps.0.app", place: { page: "template", template: "product", index: 0 } }] },
      ],
      moreParts: 3,
    }));
    render();
    act(() => row("rail").focus());
    key(row("rail"), { key: "ArrowDown", altKey: true });
    await autosaved();
    act(() => button("Publish").click());
    await ready("[data-publish-dialog]");
    const dialog = document.querySelector("[data-publish-dialog]")!;
    await act(async () => [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((each) => each.textContent === "Publish")!.click());
    await vi.waitFor(() => expect(dialog.querySelector("[data-theme-apps-unavailable]")).not.toBeNull());
    const alert = dialog.querySelector<HTMLElement>("[data-theme-apps-unavailable]")!;
    expect(alert.querySelector("[data-theme-app='scalius.noor']")!.textContent).toBe(
      "Noor theme is not active. Activate it from its page, or remove its parts from the theme:Header (skin 'Noor header')Home page: section 3 'Studio hero'Open Noor theme",
    );
    expect(alert.querySelector("[data-theme-app='acme.gone']")!.textContent).toContain("acme.gone is not installed. Add it from Apps");
    expect(alert.querySelector("[data-theme-app='acme.gone']")!.textContent).toContain("Product page app block");
    expect([...alert.querySelectorAll("a")].map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Open Noor theme", "/admin/apps/$pluginId"],
      ["Open Apps", "/admin/apps"],
    ]);
    expect(alert.textContent).toContain("And 3 more parts not listed here.");
    // The refusal is the dialog's, not a passing toast.
    expect(toasts.error).not.toHaveBeenCalled();
    expect(document.querySelector("[data-publish-dialog]")).not.toBeNull();
  });

  it("lets staff who may only view browse the theme without changing it", () => {
    render(themeWith(HOME), { permissions: ["settings.general.view"] });
    expect(status()).toBe("readOnly");
    expect(row("add-section")).toBeNull();
    act(() => row("rail").focus());
    key(row("rail"), { key: "ArrowDown", altKey: true });
    expect(pageRows()).toEqual(["page-settings", "rail", "faq", "story"]);
  });
});

describe("theme editor: keyboard", () => {
  it("lists the shortcuts with Ctrl+/ and toggles the sidebar with \\", () => {
    render();
    key(document.body, { key: "/", ctrlKey: true });
    expect(document.body.textContent).toContain("Keyboard shortcuts");
    key(document.body, { key: "Escape" });
    const sidebar = () => container.querySelector<HTMLElement>("aside[aria-label='Sections and settings']")!;
    expect(sidebar().className).toContain("w-80");
    key(document.body, { key: "\\" });
    expect(sidebar().className).toContain("w-0");
  });
});

/**
 * Layout shift (research P1-P3): selecting, hovering, saving and opening a
 * panel never change the preview frame's box. The canvas measures its width
 * from the editor's own DOM (canvasWidth), so a panel that pushed the canvas
 * would change the frame's custom properties here.
 */
describe("theme editor: the frame never moves", () => {
  for (const width of [1280, 1440, 1600, 390]) {
    it(`keeps the frame's box at a ${width} px window`, async () => {
      setViewport(width);
      render();
      frame.rects = { rail: [0, 0, 1280, 400], faq: [0, 400, 1280, 300] };
      await settle();
      const before = frameStyle();
      expect(before).toContain("--ow:");

      // Select from the tree (desktop) or the frame (phone), and hover a row.
      if (width >= 1024) act(() => row("faq").click());
      else act(() => frame.onSelect!("faq"));
      act(() => row("rail")?.dispatchEvent(new PointerEvent("pointerover", { bubbles: true })));
      await settle();
      expect(frameStyle()).toBe(before);

      // Edit and save.
      await ready("#theme-section-faq-heading");
      const heading = field("theme-section-faq-heading");
      type(heading, "Common questions");
      await autosaved();
      await vi.waitFor(() => expect(status()).toBe("saved"));
      expect(frameStyle()).toBe(before);

      // Open Theme settings, the library and the shortcuts.
      const themeTab = [...container.querySelectorAll<HTMLButtonElement>("[role=tab]")].find((tab) => tab.textContent === "Theme settings");
      if (themeTab) act(() => themeTab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
      key(document.body, { key: "/", ctrlKey: true });
      await settle();
      expect(frameStyle()).toBe(before);
    });
  }
});

describe("theme editor: exact canvas text", () => {
  it.each([
    { measured: null, enabled: false },
    { measured: { id: "story", field: "heading", rect: [20, 100, 500, 50] }, enabled: false },
    { measured: { id: "faq", field: "body", rect: [20, 100, 500, 50] }, enabled: false },
    { measured: { id: "faq", field: "heading", rect: [20, 100, 500, 50] }, enabled: true },
  ])("offers desktop toolbar editing only with its matching field box (%j)", ({ measured, enabled }) => {
    frame.rects = { faq: [20, 100, 500, 200] };
    frame.field = measured as ThemePreviewField | null;
    render(); act(() => frame.onSelect!("faq", "heading"));
    const edit = container.querySelector<HTMLButtonElement>("[data-canvas-edit-text]");
    expect(Boolean(edit)).toBe(enabled);
    if (edit) {
      act(() => edit.click());
      expect(container.querySelector("[data-canvas-text-editor] input")).not.toBeNull();
    }
  });
  it.each([null, { id: "faq", field: "heading", rect: [1, 2, 30, 40] } as ThemePreviewField])("opens the first paragraph edit before its selection layout arrives (%j)", (previousField) => {
    frame.field = previousField;
    render(themeWith([section("editorial", "story", { layout: "rich-text", heading: "Story", body: "First paragraph.\n\nদ্বিতীয় অনুচ্ছেদ।" })]));
    // The click selection and double-click intent arrive before React can use a new field layout.
    act(() => {
      frame.onSelect!("story", "body");
      frame.onEditText!("story", "body", [20, 100, 500, 90]);
    });
    const input = container.querySelector<HTMLTextAreaElement>("[data-canvas-text-editor] textarea");
    expect(input).not.toBeNull();
    expect(input!.value).toBe("First paragraph.\n\nদ্বিতীয় অনুচ্ছেদ।");
    expect(document.activeElement).toBe(input);
    expect(api.draft).not.toHaveBeenCalled();
  });
  it("warns only while the native buffer differs from its baseline, without saving keystrokes", async () => {
    frame.field = { id: "faq", field: "heading", rect: [20, 100, 500, 50] };
    render(); act(() => frame.onSelect!("faq", "heading"));
    await ready("#theme-section-faq-heading");
    act(() => frame.onEditText!("faq", "heading"));
    const input = container.querySelector<HTMLInputElement>("[data-canvas-text-editor] input")!;
    const guarded = () => navigation.blocker.mock.lastCall?.[0]?.enableBeforeUnload;
    expect(guarded()).toBe(false);
    type(input, "Changed questions");
    expect(guarded()).toBe(true);
    expect(field("theme-section-faq-heading").value).toBe("Questions");
    expect(api.draft).not.toHaveBeenCalled();
    type(input, "Questions");
    expect(guarded()).toBe(false);
    key(input, { key: "Enter" });
    expect(guarded()).toBe(false);
    expect(api.draft).not.toHaveBeenCalled();
    expect(button("Undo").disabled).toBe(true);
  });
  it("selects a field without stealing focus, applies one completed session, and undoes it", async () => {
    frame.field = { id: "faq", field: "heading", rect: [20, 100, 500, 50] };
    render();
    act(() => frame.onSelect!("faq", "heading"));
    await ready("#theme-section-faq-heading");
    expect(document.activeElement?.id).not.toBe("theme-section-faq-heading");
    const otherButton = document.createElement("button"); container.append(otherButton);
    act(() => otherButton.focus());
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    act(() => otherButton.dispatchEvent(enter));
    expect(enter.defaultPrevented).toBe(false);
    expect(container.querySelector("[data-canvas-text-editor]")).toBeNull();
    otherButton.remove();
    act(() => frame.onEditText!("faq", "heading"));
    const input = container.querySelector<HTMLInputElement>("[data-canvas-text-editor] input")!;
    expect(input).toBeTruthy(); expect(document.activeElement).toBe(input);
    type(input, "Canvas questions");
    expect(field("theme-section-faq-heading").value).toBe("Questions");
    key(input, { key: "Enter" });
    expect(container.querySelector("[data-canvas-text-editor]")).toBeNull();
    expect(field("theme-section-faq-heading").value).toBe("Canvas questions");
    key(document.body, { key: "z", ctrlKey: true });
    expect(field("theme-section-faq-heading").value).toBe("Questions");
    frame.field = null;
  });
  it("edits an app section's marked text setting and writes its value", async () => {
    const apps: ThemeWorkspaceDocument["apps"] = [{
      id: "acme.studio", name: "Acme Studio", skins: [], templates: [], pagePresets: [], components: [],
      sections: [{ key: "acme.studio/quote", type: "quote", name: "Quote", description: null, settings: [
        { key: "author", label: "Quoted by", help: null, type: "text", required: false, options: null, default: "A buyer", min: null, max: null, integer: false, maxLength: 40 },
      ] }],
    }];
    const quote = { id: "app", type: "app", version: 1, settings: { app: "acme.studio/quote", values: {} } } as StorefrontSection;
    frame.field = { id: "app", field: "author", rect: [20, 100, 300, 40] };
    render(themeWith([quote]), { apps });
    act(() => frame.onSelect!("app", "author"));
    await ready("#theme-section-app-values-author");
    act(() => frame.onEditText!("app", "author"));
    const input = container.querySelector<HTMLInputElement>("[data-canvas-text-editor] input")!;
    expect(input.value).toBe("A buyer");
    expect(container.querySelector("[data-canvas-text-editor]")?.textContent).toContain("Quoted by");
    type(input, "Rahima, Dhaka");
    key(input, { key: "Enter" });
    expect(field("theme-section-app-values-author").value).toBe("Rahima, Dhaka");
    await autosaved();
    expect(lastSaved().theme.pages.home[0]).toEqual({ ...quote, settings: { app: "acme.studio/quote", values: { author: "Rahima, Dhaka" } } });
    frame.field = null;
  });
  it("keeps a phone tap as selection and Edit text focuses the existing native setting", async () => {
    setViewport(390); frame.field = { id: "faq", field: "heading", rect: [20, 100, 300, 50] };
    render(); act(() => frame.onSelect!("faq", "heading"));
    await ready("#theme-section-faq-heading");
    expect(document.activeElement?.id).not.toBe("theme-section-faq-heading");
    act(() => frame.onEditText!("faq", "heading"));
    expect(document.activeElement?.id).toBe("theme-section-faq-heading");
    expect(container.querySelector("[data-canvas-text-editor]")).toBeNull();
    frame.field = null;
  });
});
