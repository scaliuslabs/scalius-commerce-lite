// @vitest-environment happy-dom

// The Navigation page says whether the live theme draws the header menu, and
// switches the theme's "Header links from" to the menu in one click: saved to
// the draft, and published at once only when the draft held nothing else.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type AnchorHTMLAttributes, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_STOREFRONT_THEME, storeShapeFromFacts, type StorefrontThemeDocument } from "@scalius/shared/storefront-theme";
import type { ThemeWorkspaceDocument } from "~/lib/api-query-options/online-store";
import { HeaderMenuNotice, headerMenuReach, useHeaderMenuReach } from "./header-menu-reach";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ draft: vi.fn(), publish: vi.fn(), workspace: vi.fn() }));
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("~/lib/api", () => ({ apiData: (call: unknown) => call }));
vi.mock("@scalius/api-client/sdk", () => ({
  getApiV1AdminSettingsThemeEditor: api.workspace,
  postApiV1AdminSettingsThemeDraft: api.draft,
  postApiV1AdminSettingsThemePublish: api.publish,
}));
vi.mock("sonner", () => ({ toast: toasts }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
}));

const withSource = (source: "menu" | "category-tree" | "tree+menu"): StorefrontThemeDocument => ({
  ...DEFAULT_STOREFRONT_THEME,
  blocks: { ...DEFAULT_STOREFRONT_THEME.blocks, navigation: { ...DEFAULT_STOREFRONT_THEME.blocks.navigation, source } },
});
const SHAPE = storeShapeFromFacts({ productCount: 40, skuCount: 60, topCategoryCount: 5, categoryDepth: 1, menu: [{}, {}], hasCollections: true, hasDeliveryMethods: true });

function workspace(source: "menu" | "category-tree" | "tree+menu", differs: boolean): ThemeWorkspaceDocument {
  return {
    published: { theme: withSource(source), revision: 4 },
    draft: { theme: withSource(source), revision: 7, basePublishedRevision: 4, updatedAt: null, updatedByName: null },
    draftDiffersFromLive: differs,
    lastPublished: null,
    storeShape: SHAPE,
    media: [],
    apps: [],
  } as unknown as ThemeWorkspaceDocument;
}

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  api.draft.mockResolvedValue({ revision: 8, basePublishedRevision: 4, updatedAt: null });
  api.publish.mockResolvedValue({ published: { revision: 5 }, draft: { revision: 9, basePublishedRevision: 5 }, lastPublished: null });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function Harness({ canSwitch }: { canSwitch: boolean }) {
  return <HeaderMenuNotice reach={useHeaderMenuReach()} canSwitch={canSwitch} />;
}

async function render(canSwitch = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(<QueryClientProvider client={client}><Harness canSwitch={canSwitch} /></QueryClientProvider>));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

const switchButton = () => [...container.querySelectorAll("button")].find((each) => each.textContent === "Show this menu in the header");

describe("the header menu's reach", () => {
  it("follows the theme's Header links from, and the storefront's fallback without categories", () => {
    expect(headerMenuReach(withSource("menu"), 5)).toBe("drawn");
    expect(headerMenuReach(withSource("tree+menu"), 5)).toBe("afterCategories");
    expect(headerMenuReach(withSource("category-tree"), 5)).toBe("notDrawn");
    expect(headerMenuReach(withSource("category-tree"), 0)).toBe("drawn");
    // The categories fill the top links: the menu's links go behind More.
    const crowded = withSource("tree+menu");
    expect(headerMenuReach({ ...crowded, blocks: { ...crowded.blocks, navigation: { ...crowded.blocks.navigation, maxTopItems: 5 } } }, 5)).toBe("crowdedOut");
  });

  it("says a menu the theme does not draw is not drawn, and switches and publishes in one click", async () => {
    api.workspace.mockResolvedValue(workspace("category-tree", false));
    await render();
    expect(container.querySelector("[data-header-menu-not-drawn]")?.textContent).toContain("this menu isn't drawn there");
    await act(async () => switchButton()!.click());
    await vi.waitFor(() => expect(api.publish).toHaveBeenCalledTimes(1));
    const sent = api.draft.mock.calls[0]![0].body as { theme: StorefrontThemeDocument; expectedDraftRevision: number };
    expect(sent.expectedDraftRevision).toBe(7);
    expect(sent.theme.blocks.navigation.source).toBe("menu");
    expect(api.publish.mock.calls[0]![0].body).toMatchObject({ expectedPublishedRevision: 4, expectedDraftRevision: 8 });
    expect(toasts.success).toHaveBeenCalledWith("Header menu shown");
  });

  it("only saves to the draft when the draft holds other changes, and says to publish", async () => {
    api.workspace.mockResolvedValue(workspace("category-tree", true));
    await render();
    await act(async () => switchButton()!.click());
    await vi.waitFor(() => expect(api.draft).toHaveBeenCalledTimes(1));
    expect(api.publish).not.toHaveBeenCalled();
    expect(toasts.success).toHaveBeenCalledWith("Saved to theme draft", expect.objectContaining({ description: expect.stringContaining("publish it in the theme editor") }));
  });

  it("offers no switch to staff who cannot edit the theme, and says where a drawn menu shows", async () => {
    api.workspace.mockResolvedValue(workspace("category-tree", false));
    await render(false);
    expect(container.querySelector("[data-header-menu-not-drawn]")).not.toBeNull();
    expect(switchButton()).toBeUndefined();

    act(() => root.unmount());
    root = createRoot(container);
    api.workspace.mockResolvedValue(workspace("tree+menu", false));
    await render();
    expect(container.textContent).toContain("Drawn in the header after your published categories");
  });
});
