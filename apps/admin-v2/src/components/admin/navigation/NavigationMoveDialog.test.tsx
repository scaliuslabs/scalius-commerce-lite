// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildNavigationMoveModel,
  getNavigationMovePositionCount,
  NavigationMoveDialog,
} from "./NavigationMoveDialog";
import type { NavigationItem } from "./types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function menuItem(
  id: string,
  label: string,
  subMenu?: NavigationItem[],
): NavigationItem {
  return {
    id,
    target: { type: "label" },
    labelMode: "custom",
    customLabel: label,
    ...(subMenu?.length ? { subMenu } : {}),
  };
}

async function flushUi() {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

describe("NavigationMoveDialog", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  it("derives current placement and only offers depth-safe non-descendant parents", () => {
    const movingBranch = menuItem("sale", "Sale", [
      menuItem("sale-final", "Final sale"),
    ]);
    const catalog = menuItem("catalog", "Stale catalog label", [
      movingBranch,
      menuItem("clothing", "Clothing", [menuItem("shoes", "Shoes")]),
    ]);
    catalog.resolution = {
      title: "Current catalog",
      readiness: "ready",
      available: true,
    };
    const items = [catalog, menuItem("about", "About")];

    const model = buildNavigationMoveModel(items, "sale");

    expect(model).toMatchObject({
      itemLabel: "Sale",
      initialParentId: "catalog",
      initialPosition: 1,
    });
    expect(model?.parentOptions).toEqual([
      { parentId: null, label: "Top level", level: 1 },
      { parentId: "catalog", label: "Current catalog", level: 2 },
      { parentId: "about", label: "About", level: 2 },
    ]);
    expect(model?.parentOptions.map((option) => option.parentId)).not.toContain(
      "sale-final",
    );
  });

  it("counts destination positions after excluding the moving item", () => {
    const items = [
      menuItem("first", "First"),
      menuItem("moving", "Moving"),
      menuItem("catalog", "Catalog", [
        menuItem("child-one", "Child one"),
        menuItem("child-two", "Child two"),
      ]),
    ];

    expect(getNavigationMovePositionCount(items, "moving", null)).toBe(3);
    expect(getNavigationMovePositionCount(items, "moving", "catalog")).toBe(3);
  });

  it("clamps position for a new parent and submits one zero-based move", async () => {
    const onMove = vi.fn();
    const onOpenChange = vi.fn();
    const items = [
      menuItem("first", "First"),
      menuItem("second", "Second"),
      menuItem("catalog", "Catalog", [menuItem("only-child", "Only child")]),
      menuItem("moving", "Moving"),
    ];

    await act(async () => root.render(
      <NavigationMoveDialog
        open
        itemId="moving"
        items={items}
        onOpenChange={onOpenChange}
        onMove={onMove}
      />,
    ));

    const parentTrigger = document.body.querySelector<HTMLButtonElement>(
      '[role="combobox"][aria-label="Parent for Moving"]',
    );
    if (!parentTrigger) throw new Error("Expected parent selector");

    await act(async () => parentTrigger.click());
    await flushUi();
    const catalogOption = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('[role="option"]'),
    ).find((option) => option.textContent?.includes("Catalog"));
    if (!catalogOption) throw new Error("Expected Catalog parent option");
    await act(async () => catalogOption.click());

    expect(document.body.textContent).toContain(
      "Catalog · Level 2 · Position 2 of 2",
    );

    const moveButton = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent?.trim() === "Move item");
    if (!moveButton) throw new Error("Expected move button");
    await act(async () => moveButton.click());

    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove).toHaveBeenCalledWith("moving", "catalog", 1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
