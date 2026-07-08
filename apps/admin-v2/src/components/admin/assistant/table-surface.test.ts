// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { executeAdminAssistantPageAction, resetAdminAssistantPageActionsForTest } from "./page-actions";
import {
  createAdminAssistantPageStateSnapshot,
  resetAdminAssistantPageStateForTest,
} from "./page-state";
import {
  getAdminAssistantTableActionId,
  registerAdminAssistantTableSurface,
} from "./table-surface";

describe("admin assistant table surface", () => {
  beforeEach(() => {
    resetAdminAssistantPageActionsForTest();
    resetAdminAssistantPageStateForTest();
  });

  afterEach(() => {
    resetAdminAssistantPageActionsForTest();
    resetAdminAssistantPageStateForTest();
    vi.restoreAllMocks();
  });

  it("registers aggregate table metadata and safe visible row ids only", () => {
    registerAdminAssistantTableSurface({
      id: "products-table",
      label: "Products for buyer@example.com +8801712345678",
      visibleRowIds: [
        "prod_1",
        "prod_1",
        "prod_buyer@example.com_chk_receiptProof",
        ...Array.from({ length: 120 }, (_, index) => `prod_${index + 2}`),
      ],
      selectedRowIds: ["prod_1"],
      onSelectVisibleRows: () => true,
      onClearSelection: () => true,
    });

    const snapshot = createAdminAssistantPageStateSnapshot({
      routePath: "/admin/products",
      pageTitle: "Products",
      pageHeading: "Products",
    });

    expect(snapshot.surfaces).toHaveLength(1);
    expect(snapshot.surfaces[0]).toMatchObject({
      id: "products-table",
      kind: "table",
      label: "Products for [redacted-email] [redacted-phone]",
      rowCount: 100,
      selectedCount: 1,
    });
    const selectAction = snapshot.surfaces[0]?.assistantActions?.find(
      (action) => action.type === "select_visible_rows",
    );
    const clearAction = snapshot.surfaces[0]?.assistantActions?.find(
      (action) => action.type === "clear_selection",
    );

    expect(selectAction).toMatchObject({
      id: "products-table:select_visible_rows",
      label: "Select visible rows",
    });
    expect(selectAction?.visibleRowIds).toHaveLength(100);
    expect(selectAction?.visibleRowIds?.[0]).toBe("prod_1");
    expect(selectAction?.visibleRowIds).not.toContain(
      "prod_buyer@example.com_chk_receiptProof",
    );
    expect(clearAction).toMatchObject({
      id: "products-table:clear_selection",
      label: "Clear selection",
    });
    expect(JSON.stringify(snapshot)).not.toContain("buyer@example.com");
    expect(JSON.stringify(snapshot)).not.toContain("+8801712345678");
    expect(JSON.stringify(snapshot)).not.toContain("chk_receiptProof");
  });

  it("selects only requested row ids that are currently visible", async () => {
    const selectVisibleRows = vi.fn(() => true);
    registerAdminAssistantTableSurface({
      id: "products-table",
      label: "Products",
      visibleRowIds: ["prod_1", "prod_2"],
      onSelectVisibleRows: selectVisibleRows,
      onClearSelection: () => true,
    });

    await expect(
      executeAdminAssistantPageAction({
        id: getAdminAssistantTableActionId(
          "products-table",
          "select_visible_rows",
        ),
        type: "select_visible_rows",
        targetId: "products-table",
        rowIds: ["prod_2", "hidden_prod_3"],
      }),
    ).resolves.toBe(true);

    expect(selectVisibleRows).toHaveBeenCalledTimes(1);
    expect(selectVisibleRows).toHaveBeenCalledWith(["prod_2"]);
  });

  it("fails closed when no requested row id is visible", async () => {
    const selectVisibleRows = vi.fn(() => true);
    registerAdminAssistantTableSurface({
      id: "products-table",
      label: "Products",
      visibleRowIds: ["prod_1"],
      onSelectVisibleRows: selectVisibleRows,
      onClearSelection: () => true,
    });

    await expect(
      executeAdminAssistantPageAction({
        id: "products-table:select_visible_rows",
        type: "select_visible_rows",
        targetId: "products-table",
        rowIds: ["hidden_prod_3"],
      }),
    ).resolves.toBe(false);

    expect(selectVisibleRows).not.toHaveBeenCalled();
  });

  it("fails closed when the page action targets another table", async () => {
    const selectVisibleRows = vi.fn(() => true);
    const clearSelection = vi.fn(() => true);
    registerAdminAssistantTableSurface({
      id: "products-table",
      label: "Products",
      visibleRowIds: ["prod_1"],
      selectedRowIds: ["prod_1"],
      onSelectVisibleRows: selectVisibleRows,
      onClearSelection: clearSelection,
    });

    await expect(
      executeAdminAssistantPageAction({
        id: "products-table:select_visible_rows",
        type: "select_visible_rows",
        targetId: "orders-table",
        rowIds: ["prod_1"],
      }),
    ).resolves.toBe(false);
    await expect(
      executeAdminAssistantPageAction({
        id: "products-table:clear_selection",
        type: "clear_selection",
        targetId: "orders-table",
      }),
    ).resolves.toBe(false);

    expect(selectVisibleRows).not.toHaveBeenCalled();
    expect(clearSelection).not.toHaveBeenCalled();
  });

  it("clears selection through the registered table callback", async () => {
    const clearSelection = vi.fn(() => true);
    registerAdminAssistantTableSurface({
      id: "products-table",
      label: "Products",
      visibleRowIds: ["prod_1"],
      selectedRowIds: ["prod_1"],
      onSelectVisibleRows: () => true,
      onClearSelection: clearSelection,
    });

    await expect(
      executeAdminAssistantPageAction({
        id: "products-table:clear_selection",
        type: "clear_selection",
        targetId: "products-table",
      }),
    ).resolves.toBe(true);

    expect(clearSelection).toHaveBeenCalledTimes(1);
  });

  it("unregisters surface metadata and table handlers together", async () => {
    const handle = registerAdminAssistantTableSurface({
      id: "products-table",
      label: "Products",
      visibleRowIds: ["prod_1"],
      onSelectVisibleRows: () => true,
      onClearSelection: () => true,
    });

    handle.unregister();

    const snapshot = createAdminAssistantPageStateSnapshot({
      routePath: "/admin/products",
    });

    expect(snapshot.surfaces).toEqual([]);
    await expect(
      executeAdminAssistantPageAction({
        id: "products-table:clear_selection",
        type: "clear_selection",
        targetId: "products-table",
      }),
    ).resolves.toBe(false);
  });
});
