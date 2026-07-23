import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const productsSource = readSource("../routes/admin/products/index.tsx");
const inventorySource = readSource("../components/admin/InventoryManager.tsx");
const ordersSource = readSource("../routes/admin/orders/index.tsx");
const orderFormSource = readSource("../components/admin/OrderForm.tsx");
const orderViewHeaderSource = readSource("../components/admin/orderview/OrderViewHeader.tsx");
const mediaWorkspaceSource = readSource("../components/admin/media-manager/MediaWorkspace.tsx");

describe("primary admin workspace heading contract", () => {
  it("uses a semantic page title on the core list workspaces", () => {
    expect(productsSource).toContain("<h1 className=\"text-base font-semibold tracking-tight\">");
    expect(inventorySource).toContain("<h1 className=\"text-base font-semibold tracking-tight\">Inventory</h1>");
    expect(ordersSource).toContain("<h1 className=\"text-xl font-bold tracking-tight text-foreground\">");

    expect(productsSource).not.toContain("<CardTitle className=\"text-base font-semibold tracking-tight\">");
    expect(inventorySource).not.toContain("<CardTitle className=\"text-base font-semibold tracking-tight\">Inventory</CardTitle>");
    expect(ordersSource).not.toContain("<CardTitle className=\"text-xl font-bold tracking-tight text-foreground\">");
  });

  it("keeps create, edit, and detail order routes identifiable without extra help copy", () => {
    expect(orderFormSource).toContain("<h1 className=\"text-lg font-semibold leading-none tracking-tight text-foreground\">");
    expect(orderFormSource).toContain("Edit order");
    expect(orderFormSource).toContain('{" "}');
    expect(orderFormSource).toContain(') : "New order"}');
    expect(orderViewHeaderSource).toContain(
      '<h1 className="text-xl font-semibold tracking-tight text-foreground">',
    );
    expect(orderViewHeaderSource).toContain("Order #{order.id}");
    expect(orderViewHeaderSource).not.toContain(
      '<span className="sr-only">Order #{order.id} for </span>',
    );
  });

  it("uses h1 for the media route and h2 when the workspace is embedded in a picker", () => {
    expect(mediaWorkspaceSource).toContain("{picker ? (");
    expect(mediaWorkspaceSource).toContain("<h2 className=\"text-sm font-semibold\">Choose");
    expect(mediaWorkspaceSource).toContain("<h1 className=\"text-sm font-semibold\">Media</h1>");
  });
});
