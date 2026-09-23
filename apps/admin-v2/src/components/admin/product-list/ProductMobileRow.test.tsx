// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, params }: { children: React.ReactNode; to: string; params: { productId: string } }) => (
    <a href={to.replace("$productId", params.productId)}>{children}</a>
  ),
}));

vi.mock("~/components/admin/data-table/DataTableRowActions", () => ({
  DataTableRowActions: ({ menuLabel, onEdit, onView }: { menuLabel: string; onEdit?: () => void; onView?: () => void }) => (
    <button type="button" aria-label={menuLabel} data-can-edit={String(Boolean(onEdit))} data-can-view={String(Boolean(onView))} />
  ),
}));

import { ProductMobileRow } from "./ProductMobileRow";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const product = {
  id: "prod_1",
  aggregateRevision: 1,
  name: "Modular Studio Lamp",
  slug: "modular-studio-lamp",
  price: 1234.5,
  description: null,
  isActive: true,
  discountPercentage: 0,
  discountType: "percentage",
  discountAmount: 0,
  freeDelivery: false,
  createdAt: "2026-07-01T00:00:00Z",
  updatedAt: "2026-07-12T00:00:00Z",
  category: { name: "Lighting" },
  variantCount: 8,
  mediaCount: 1,
  primaryImage: null,
  sku: "LAMP-MATTE-EU",
};

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

  async function render(canEdit: boolean, canSelect: boolean) {
    await act(async () => root.render(
      <ProductMobileRow
        product={product}
        selected={false}
        showTrashed={false}
        canSelect={canSelect}
        canEdit={canEdit}
        canDelete={canEdit}
        canRestore={false}
        canPermanentDelete={false}
        fmt={() => "৳1,234.50"}
        onSelectedChange={vi.fn()}
        onOpen={vi.fn()}
        onDelete={vi.fn()}
        onRestore={vi.fn()}
        onPermanentDelete={vi.fn()}
      />,
    ));
  }

  it("links to the one product page and shows price and category on the second line", async () => {
    await render(true, true);

    const link = host.querySelector("a");
    expect(link?.textContent).toBe("Modular Studio Lamp");
    expect(link?.getAttribute("href")).toBe("/admin/products/prod_1/edit");
    expect(host.querySelector("p")?.textContent).toBe("৳1,234.50 · Lighting");
    expect(host.querySelector('[role="checkbox"]')).toBeTruthy();
    expect(host.querySelector("[data-can-edit]")?.getAttribute("data-can-edit")).toBe("true");
  });

  it("offers view only and no selection to people who can't change products", async () => {
    await render(false, false);

    expect(host.querySelector('[role="checkbox"]')).toBeNull();
    const actions = host.querySelector("[data-can-edit]");
    expect(actions?.getAttribute("data-can-edit")).toBe("false");
    expect(actions?.getAttribute("data-can-view")).toBe("true");
  });
});
