// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createAdminAssistantPageStateSnapshot,
  resetAdminAssistantPageStateForTest,
} from "~/components/admin/assistant/page-state";
import { ProductDeleteDialog } from "./-ProductDeleteDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("ProductDeleteDialog assistant surface", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    resetAdminAssistantPageStateForTest();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    resetAdminAssistantPageStateForTest();
    vi.restoreAllMocks();
  });

  it("registers a visible product delete dialog without product ids or confirm actions", () => {
    act(() => {
      root.render(
        <ProductDeleteDialog
          showTrashed={false}
          productToDelete="prod_sensitive_123"
          isBulkDeleteOpen={false}
          selectedCount={0}
          isActionLoading={false}
          onCloseSingle={() => undefined}
          onBulkOpenChange={() => undefined}
          onConfirmSingle={() => undefined}
          onConfirmBulk={() => undefined}
        />,
      );
    });

    const snapshot = createAdminAssistantPageStateSnapshot({
      routePath: "/admin/products",
      pageTitle: "Products",
      pageHeading: "Products",
    });

    expect(snapshot.surfaces).toEqual([
      {
        id: "product-delete-dialog",
        kind: "dialog",
        label: "Move product to trash confirmation dialog",
        open: true,
        submitting: false,
      },
    ]);
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("prod_sensitive_123");
    expect(serialized).not.toContain("confirm_single");
    expect(serialized).not.toContain("delete_product");
  });

  it("registers only aggregate bulk delete dialog state", () => {
    act(() => {
      root.render(
        <ProductDeleteDialog
          showTrashed
          productToDelete={null}
          isBulkDeleteOpen
          selectedCount={3}
          isActionLoading
          onCloseSingle={() => undefined}
          onBulkOpenChange={() => undefined}
          onConfirmSingle={() => undefined}
          onConfirmBulk={() => undefined}
        />,
      );
    });

    const snapshot = createAdminAssistantPageStateSnapshot({
      routePath: "/admin/products",
      pageTitle: "Trash",
      pageHeading: "Trash",
    });

    expect(snapshot.surfaces).toEqual([
      {
        id: "bulk-product-delete-dialog",
        kind: "dialog",
        label:
          "Permanent bulk product delete confirmation dialog (3 selected)",
        open: true,
        submitting: true,
      },
    ]);
    expect(snapshot.surfaces[0]?.assistantActions).toBeUndefined();
  });
});
