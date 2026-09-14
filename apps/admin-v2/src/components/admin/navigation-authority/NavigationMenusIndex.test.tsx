// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  NavigationMenuSummary,
  NavigationPlacementSetting,
} from "~/lib/api-functions/navigation-authority";

const api = vi.hoisted(() => ({
  getMenus: vi.fn(),
  getPlacements: vi.fn(),
  trashMenu: vi.fn(),
}));

vi.mock("~/lib/api-functions/navigation-authority", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/api-functions/navigation-authority")>()),
  getNavigationMenusAuthority: api.getMenus,
  getNavigationPlacementSettings: api.getPlacements,
  trashNavigationMenuAuthority: api.trashMenu,
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import { NavigationMenusIndex } from "./NavigationMenusIndex";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function menuSummary(overrides: Partial<NavigationMenuSummary> = {}): NavigationMenuSummary {
  return {
    id: "menu_header",
    name: "Header primary",
    handle: "header-primary",
    revision: 4,
    publishedRevision: 4,
    dependencyRevision: 1,
    updatedAt: "2026-02-01T09:00:00.000Z",
    deletedAt: null,
    itemCount: 7,
    placementCount: 1,
    ...overrides,
  };
}

const headerPlacement: NavigationPlacementSetting = {
  placement: {
    id: "placement_header_primary_0",
    surface: "header",
    slot: "primary",
    position: 0,
    menuId: "menu_header",
    labelOverride: null,
    isEnabled: true,
    revision: 3,
  },
  menuName: "Header primary",
  menuDeletedAt: null,
  publishedRevision: 4,
  publicationItemCount: 7,
};

async function flushUi() {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

describe("NavigationMenusIndex", () => {
  let host: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    api.getPlacements.mockResolvedValue({ placements: [headerPlacement] });
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function render(props: Partial<Parameters<typeof NavigationMenusIndex>[0]> = {}) {
    await act(async () => root.render(
      <QueryClientProvider client={queryClient}>
        <NavigationMenusIndex
          query=""
          onQueryChange={vi.fn()}
          onOpenMenu={vi.fn()}
          {...props}
        />
      </QueryClientProvider>,
    ));
    await flushUi();
  }

  it("lists every menu with its publish status, storefront location and item count", async () => {
    api.getMenus.mockResolvedValue({
      items: [
        menuSummary(),
        menuSummary({
          id: "menu_help",
          name: "Help",
          handle: "help",
          revision: 9,
          publishedRevision: 7,
          placementCount: 0,
          itemCount: 2,
          updatedAt: "2026-01-01T09:00:00.000Z",
        }),
      ],
      nextCursor: null,
    });
    await render();

    await vi.waitFor(() => {
      const rows = document.body.querySelectorAll('[data-testid="index-table-row"]');
      expect(rows).toHaveLength(2);
    });

    const [first, second] = Array.from(
      document.body.querySelectorAll<HTMLElement>('[data-testid="index-table-row"]'),
    );
    expect(first?.textContent).toContain("Header primary");
    expect(first?.textContent).toContain("header-primary");
    expect(first?.textContent).toContain("Published");
    expect(first?.textContent).toContain("Header");
    expect(first?.textContent).toContain("7");

    // The second menu has edits the storefront is not showing yet.
    expect(second?.textContent).toContain("Draft changes");
    expect(second?.textContent).toContain("Not used");
  });

  it("opens the editor when a row is activated", async () => {
    api.getMenus.mockResolvedValue({ items: [menuSummary()], nextCursor: null });
    const onOpenMenu = vi.fn();
    await render({ onOpenMenu });

    await vi.waitFor(() => {
      expect(document.body.querySelector('[data-testid="index-table-row"]')).toBeTruthy();
    });
    const row = document.body.querySelector<HTMLElement>('[data-testid="index-table-row"]');
    await act(async () => row?.click());

    expect(onOpenMenu).toHaveBeenCalledWith("menu_header");
  });

  it("offers creating the first menu instead of an empty table", async () => {
    api.getMenus.mockResolvedValue({ items: [], nextCursor: null });
    await render();

    await vi.waitFor(() => {
      expect(document.body.querySelector('[data-testid="empty-state"]')).toBeTruthy();
    });
    expect(document.body.textContent).toContain("No menus yet");
    expect(document.body.querySelector('[data-testid="index-table"]')).toBeNull();

    const create = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button"))
      .filter((button) => button.textContent?.trim() === "Create menu");
    expect(create.length).toBeGreaterThan(0);
  });

  it("says a search returned nothing without hiding the filter bar", async () => {
    api.getMenus.mockResolvedValue({ items: [menuSummary()], nextCursor: null });
    await render({ query: "nothing-matches" });

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("No menus match that search");
    });
    expect(document.body.querySelector('[data-testid="index-filters"]')).toBeTruthy();
  });
});
