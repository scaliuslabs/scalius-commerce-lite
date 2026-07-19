// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getMoveOptions = vi.hoisted(() => vi.fn());

vi.mock("~/lib/api-functions/navigation-authority", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/api-functions/navigation-authority")>()),
  getNavigationMenuMoveOptionsAuthority: getMoveOptions,
}));

import { NavigationAuthorityMoveDialog } from "./NavigationAuthorityMoveDialog";
import type {
  NavigationMenuItemRow,
  NavigationMenuSummary,
} from "~/lib/api-functions/navigation-authority";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flushUi() {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

describe("NavigationAuthorityMoveDialog", () => {
  let host: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    getMoveOptions.mockResolvedValue({
      item: { id: "footwear", label: "Footwear", parentId: "shop" },
      subtreeDepth: 1,
      currentPosition: 2,
      selectedParentId: "shop",
      positionCount: 3,
      parents: [{
        id: "shop",
        label: "Shop",
        pathLabel: "Shop",
        resultingLevel: 2,
        childCount: 3,
      }],
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("submits the selected parent and exact zero-based position", async () => {
    const onMove = vi.fn();
    const menu = { id: "menu", revision: 9 } as NavigationMenuSummary;
    const item = { id: "footwear", label: "Footwear", parentId: "shop" } as NavigationMenuItemRow;

    await act(async () => root.render(
      <QueryClientProvider client={queryClient}>
        <NavigationAuthorityMoveDialog
          open
          menu={menu}
          item={item}
          moving={false}
          onOpenChange={vi.fn()}
          onMove={onMove}
        />
      </QueryClientProvider>,
    ));
    await flushUi();

    await vi.waitFor(() => {
      const parent = document.body.querySelector<HTMLButtonElement>('[aria-label="Parent for Footwear"]');
      const position = document.body.querySelector<HTMLInputElement>('[aria-label="Position for Footwear"]');
      expect(parent?.textContent).toContain("Shop");
      expect(position?.value).toBe("2");
      expect(document.body.textContent).toContain("Shop · Level 2 · Position 2 of 3");
    });

    const move = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.trim() === "Move item");
    if (!move) throw new Error("Expected Move item button");
    await act(async () => move.click());

    expect(onMove).toHaveBeenCalledWith({ parentId: "shop", index: 1 });
  });
});
