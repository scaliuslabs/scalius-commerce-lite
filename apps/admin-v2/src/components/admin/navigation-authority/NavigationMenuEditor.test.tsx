// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  NavigationMenuItemRow,
  NavigationMenuSummary,
} from "~/lib/api-functions/navigation-authority";

const api = vi.hoisted(() => ({
  getMenu: vi.fn(),
  getMenus: vi.fn(),
  getItemPage: vi.fn(),
  getPlacements: vi.fn(),
  publish: vi.fn(),
  rollback: vi.fn(),
  deleteItem: vi.fn(),
  updateMetadata: vi.fn(),
  blocker: vi.fn(),
}));

vi.mock("~/lib/api-functions/navigation-authority", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/api-functions/navigation-authority")>()),
  getNavigationMenuAuthority: api.getMenu,
  getNavigationMenusAuthority: api.getMenus,
  getNavigationMenuItemPage: api.getItemPage,
  getNavigationPlacementSettings: api.getPlacements,
  publishNavigationMenuAuthority: api.publish,
  rollbackNavigationMenuAuthority: api.rollback,
  deleteNavigationMenuItemAuthority: api.deleteItem,
  updateNavigationMenuMetadataAuthority: api.updateMetadata,
}));
vi.mock("@tanstack/react-router", () => ({ useBlocker: api.blocker }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import { NavigationMenuEditor } from "./NavigationMenuEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function menuSummary(overrides: Partial<NavigationMenuSummary> = {}): NavigationMenuSummary {
  return {
    id: "menu_header",
    name: "Header primary",
    handle: "header-primary",
    revision: 6,
    publishedRevision: 4,
    dependencyRevision: 1,
    updatedAt: "2026-02-01T09:00:00.000Z",
    deletedAt: null,
    itemCount: 2,
    placementCount: 1,
    ...overrides,
  };
}

function itemRow(overrides: Partial<NavigationMenuItemRow> = {}): NavigationMenuItemRow {
  return {
    id: "item_shop",
    menuId: "menu_header",
    parentId: null,
    position: 0,
    label: "Shop",
    labelMode: "custom",
    targetType: "internal_path",
    targetId: null,
    targetValue: "/shop",
    targetQuery: null,
    openInNewTab: false,
    isEnabled: true,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

async function flushUi() {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

function buttonsByText(text: string) {
  return Array.from(document.body.querySelectorAll<HTMLButtonElement>("button"))
    .filter((button) => button.textContent?.trim() === text);
}

describe("NavigationMenuEditor", () => {
  let host: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    api.blocker.mockReturnValue(undefined);
    api.getMenu.mockResolvedValue({ menu: menuSummary() });
    api.getMenus.mockResolvedValue({ items: [menuSummary()], nextCursor: null });
    api.getPlacements.mockResolvedValue({ placements: [] });
    api.getItemPage.mockResolvedValue({
      items: [{ item: itemRow(), childCount: 0 }],
      nextCursor: null,
    });
    api.publish.mockResolvedValue({
      revision: 7,
      publishedRevision: 7,
      itemCount: 2,
      checksum: "c",
    });
    api.rollback.mockResolvedValue({
      revision: 7,
      publishedRevision: 7,
      sourceRevision: 4,
      itemCount: 2,
      checksum: "c",
    });
    api.updateMetadata.mockResolvedValue({ revision: 7 });
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function render(props: Partial<Parameters<typeof NavigationMenuEditor>[0]> = {}) {
    await act(async () => root.render(
      <QueryClientProvider client={queryClient}>
        <NavigationMenuEditor
          menuId="menu_header"
          panel="items"
          query=""
          onBackToMenus={vi.fn()}
          onPanelChange={vi.fn()}
          onQueryChange={vi.fn()}
          onItemChange={vi.fn()}
          {...props}
        />
      </QueryClientProvider>,
    ));
    await flushUi();
  }

  it("shows the draft bar and publishes against the current revision", async () => {
    await render();

    await vi.waitFor(() => {
      expect(document.body.querySelector('[data-testid="contextual-save-bar"]')).toBeTruthy();
    });
    const bar = document.body.querySelector<HTMLElement>('[data-testid="contextual-save-bar"]');
    // The edits are already stored; only publishing is outstanding.
    expect(bar?.textContent).toContain("Draft changes are not published yet");
    expect(bar?.textContent).toContain("Customers still see revision 4");
    expect(bar?.textContent).toContain("Discard draft");

    // The bar owns the primary action while it is up, so the header does not
    // offer a second Publish button.
    const header = document.body.querySelector<HTMLElement>('[data-testid="page-header-actions"]');
    const headerButtons = Array.from(header?.querySelectorAll<HTMLButtonElement>("button") ?? [])
      .map((button) => button.textContent?.trim());
    expect(headerButtons).not.toContain("Publish");

    const publish = buttonsByText("Publish")[0];
    if (!publish) throw new Error("Expected a Publish button in the save bar");
    await act(async () => publish.click());
    await flushUi();

    expect(api.publish).toHaveBeenCalledWith({
      data: { menuId: "menu_header", expectedRevision: 6 },
    });
  });

  it("confirms discarding before restoring the published revision", async () => {
    await render();
    await vi.waitFor(() => {
      expect(document.body.querySelector('[data-testid="contextual-save-bar"]')).toBeTruthy();
    });

    const discard = buttonsByText("Discard draft")[0];
    if (!discard) throw new Error("Expected a Discard draft button");
    await act(async () => discard.click());
    await flushUi();

    expect(document.body.textContent).toContain("Discard draft changes?");
    expect(api.rollback).not.toHaveBeenCalled();

    const confirm = buttonsByText("Discard changes")[0];
    if (!confirm) throw new Error("Expected the discard confirmation action");
    await act(async () => confirm.click());
    await flushUi();

    expect(api.rollback).toHaveBeenCalledWith({
      data: { menuId: "menu_header", expectedRevision: 6, sourceRevision: 4 },
    });
  });

  it("keeps Publish in the header and hides the bar once nothing is outstanding", async () => {
    api.getMenu.mockResolvedValue({ menu: menuSummary({ revision: 4, publishedRevision: 4 }) });
    await render();

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Published");
    });
    expect(document.body.querySelector('[data-testid="contextual-save-bar"]')).toBeNull();

    const publish = buttonsByText("Publish")[0];
    expect(publish?.disabled).toBe(true);
  });

  it("offers Publish alone for a menu that has never been published", async () => {
    api.getMenu.mockResolvedValue({ menu: menuSummary({ revision: 2, publishedRevision: null }) });
    await render();

    await vi.waitFor(() => {
      expect(document.body.querySelector('[data-testid="contextual-save-bar"]')).toBeTruthy();
    });
    const bar = document.body.querySelector<HTMLElement>('[data-testid="contextual-save-bar"]')!;
    expect(bar.textContent).toContain("This menu is not published yet");
    expect(bar.textContent).toContain("Nothing of this menu is on the storefront yet");
    // Nothing is live, so there is no published version to discard back to.
    expect(bar.querySelector('[data-testid="contextual-save-bar-discard"]')).toBeNull();
    expect(buttonsByText("Discard draft")).toHaveLength(0);

    const publish = buttonsByText("Publish")[0];
    expect(publish?.disabled).toBe(false);
    await act(async () => publish?.click());
    await flushUi();

    expect(api.publish).toHaveBeenCalledWith({
      data: { menuId: "menu_header", expectedRevision: 2 },
    });
  });

  it("renames the menu from the title in the page header", async () => {
    await render();

    await vi.waitFor(() => {
      expect(document.body.querySelector('[aria-label="Rename menu"]')).toBeTruthy();
    });
    const header = document.body.querySelector<HTMLElement>('[data-testid="page-header"]')!;
    expect(header.querySelector("h1")?.textContent).toBe("Header primary");

    const rename = document.body.querySelector<HTMLButtonElement>('[aria-label="Rename menu"]')!;
    await act(async () => rename.click());
    await flushUi();

    const field = header.querySelector<HTMLInputElement>('input[aria-label="Menu name"]')!;
    // The heading stays in the DOM so the header keeps its accessible name.
    expect(header.getAttribute("aria-labelledby")).toBe(header.querySelector("h1")!.id);

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(field, "Main menu");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => buttonsByText("Save")[0]?.click());
    await flushUi();

    expect(api.updateMetadata).toHaveBeenCalledWith({
      data: {
        menuId: "menu_header",
        expectedRevision: 6,
        name: "Main menu",
        handle: "header-primary",
      },
    });
  });

  it("refuses to save an empty menu name", async () => {
    await render();

    await vi.waitFor(() => {
      expect(document.body.querySelector('[aria-label="Rename menu"]')).toBeTruthy();
    });
    await act(async () =>
      document.body.querySelector<HTMLButtonElement>('[aria-label="Rename menu"]')!.click());
    await flushUi();

    const field = document.body.querySelector<HTMLInputElement>('input[aria-label="Menu name"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(field, "   ");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => buttonsByText("Save")[0]?.click());
    await flushUi();

    expect(api.updateMetadata).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Enter a name so you can find this menu later.");
  });

  it("adds an item at the level its own add row belongs to", async () => {
    api.getItemPage.mockImplementation(({ data }: { data: { parentId?: string | null } }) =>
      Promise.resolve(
        data.parentId
          ? { items: [{ item: itemRow({ id: "item_shoes", label: "Shoes", parentId: data.parentId }), childCount: 0 }], nextCursor: null }
          : { items: [{ item: itemRow({ id: "item_shop", label: "Shop" }), childCount: 1 }], nextCursor: null },
      ));
    const onItemChange = vi.fn();
    await render({ onItemChange });

    await vi.waitFor(() => {
      expect(document.body.querySelector('[data-testid="navigation-add-item-row"]')).toBeTruthy();
    });

    const rootAdd = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="navigation-add-item-row"]',
    );
    expect(rootAdd?.getAttribute("aria-label")).toBe("Add menu item");
    await act(async () => rootAdd?.click());
    expect(onItemChange).toHaveBeenCalledWith("new", undefined);

    // Expanding a parent gives that level its own add row, pre-targeted.
    const expand = document.body.querySelector<HTMLButtonElement>('[aria-label="Expand Shop"]');
    if (!expand) throw new Error("Expected an expand control for Shop");
    await act(async () => expand.click());
    await flushUi();

    await vi.waitFor(() => {
      expect(document.body.querySelector('[aria-label="Add menu item under Shop"]')).toBeTruthy();
    });
    const nested = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Add menu item under Shop"]',
    );
    await act(async () => nested?.click());
    expect(onItemChange).toHaveBeenLastCalledWith("new", "item_shop");
  });

  it("marks an item whose destination no longer exists", async () => {
    api.getItemPage.mockResolvedValue({
      items: [{
        item: itemRow({ label: "Sale", targetType: "category", targetId: null, targetValue: null }),
        childCount: 0,
      }],
      nextCursor: null,
    });
    await render();

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Category unavailable");
    });
  });

  it("states what a removal takes with it before deleting", async () => {
    api.getItemPage.mockResolvedValue({
      items: [{ item: itemRow({ label: "Shop" }), childCount: 2 }],
      nextCursor: null,
    });
    api.deleteItem.mockResolvedValue({ deletedCount: 3, revision: 7 });
    await render();

    await vi.waitFor(() => {
      expect(document.body.querySelector('[aria-label="Remove Shop"]')).toBeTruthy();
    });
    const remove = document.body.querySelector<HTMLButtonElement>('[aria-label="Remove Shop"]');
    await act(async () => remove?.click());
    await flushUi();

    expect(document.body.textContent).toContain('"Shop" and its 2 nested items are removed');
    expect(api.deleteItem).not.toHaveBeenCalled();

    const confirm = buttonsByText("Remove item")[0];
    if (!confirm) throw new Error("Expected the remove confirmation action");
    await act(async () => confirm.click());
    await flushUi();

    expect(api.deleteItem).toHaveBeenCalledWith({
      data: { menuId: "menu_header", itemId: "item_shop", expectedRevision: 6 },
    });
  });

  it("blocks storefront assignment until the menu is published", async () => {
    api.getMenu.mockResolvedValue({ menu: menuSummary({ revision: 2, publishedRevision: null }) });
    await render();

    await vi.waitFor(() => {
      expect(document.body.querySelector('[data-testid="navigation-locations"]')).toBeTruthy();
    });
    const locations = document.body.querySelector<HTMLElement>(
      '[data-testid="navigation-locations"]',
    );
    expect(locations?.textContent).toContain(
      "Publish this menu before assigning it to a storefront location.",
    );
    expect(locations?.textContent).toContain("Footer column 4");
    const boxes = Array.from(
      locations?.querySelectorAll<HTMLButtonElement>('[role="checkbox"]') ?? [],
    );
    expect(boxes).toHaveLength(5);
    expect(boxes.every((box) => box.disabled)).toBe(true);
  });
});
