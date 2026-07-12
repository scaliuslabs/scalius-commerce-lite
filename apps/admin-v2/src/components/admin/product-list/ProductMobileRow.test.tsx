// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...props}>{children}</a>
  ),
}));

vi.mock("~/components/admin/data-table/DataTableRowActions", () => ({
  DataTableRowActions: ({ menuLabel }: { menuLabel: string }) => (
    <button type="button" aria-label={menuLabel}>Actions</button>
  ),
}));

import { ProductMobileRow } from "./ProductMobileRow";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ProductMobileRow", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("presents the essential catalog workflow without a clipped desktop table", async () => {
    await act(async () => root.render(
      <ProductMobileRow
        product={{
          id: "prod_1",
          aggregateRevision: 1,
          name: "Modular Studio Lamp",
          slug: "modular-studio-lamp",
          price: 1234.567,
          description: null,
          isActive: true,
          discountPercentage: null,
          discountType: null,
          discountAmount: null,
          freeDelivery: false,
          createdAt: new Date("2026-07-01T00:00:00Z"),
          updatedAt: new Date("2026-07-12T00:00:00Z"),
          category: { name: "Lighting" },
          variantCount: 8,
          mediaCount: 1,
          primaryImage: null,
          sku: "LAMP-MATTE-EU",
        }}
        selected={false}
        showTrashed={false}
        canSelect
        canEdit
        canDelete
        canRestore={false}
        canPermanentDelete={false}
        formatPrice={() => "KD 1,234.567"}
        onSelectedChange={vi.fn()}
        onView={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onRestore={vi.fn()}
        onPermanentDelete={vi.fn()}
      />,
    ));

    expect(host.querySelector("article")).toBeTruthy();
    expect(host.querySelector("a")?.textContent).toBe("Modular Studio Lamp");
    expect(host.textContent).toContain("LAMP-MATTE-EU · Lighting");
    expect(host.textContent).toContain("KD 1,234.567");
    expect(host.textContent).toContain("8 SKUs");
    expect(host.querySelector('[aria-label="Select Modular Studio Lamp"]')).toBeTruthy();
    expect(host.querySelector('[aria-label="Open actions for Modular Studio Lamp"]')).toBeTruthy();
  });
});
