import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const detailRouteSource = readFileSync(
  fileURLToPath(new URL("./$orderId/index.tsx", import.meta.url)),
  "utf8",
);
const listRouteSource = readFileSync(
  fileURLToPath(new URL("./index.tsx", import.meta.url)),
  "utf8",
);
const desktopColumnsSource = readFileSync(
  fileURLToPath(
    new URL(
      "../../../components/admin/data-table/columns/order-columns.tsx",
      import.meta.url,
    ),
  ),
  "utf8",
);
const mobileCardSource = readFileSync(
  fileURLToPath(
    new URL(
      "../../../components/admin/order-list/OrderMobileCard.tsx",
      import.meta.url,
    ),
  ),
  "utf8",
);

describe("order detail navigation", () => {
  it("preserves the detail URL and renders a recoverable error when the required order read fails", () => {
    expect(detailRouteSource).toContain(
      "await prefetchOrderDetailQueries(queryClient, params.orderId);",
    );
    expect(detailRouteSource).toContain(
      "errorComponent: OrderDetailErrorComponent",
    );
    expect(detailRouteSource).toContain("Order could not be loaded");
    expect(detailRouteSource).toContain("Try again");
    expect(detailRouteSource).toContain("Back to orders");
    expect(detailRouteSource).not.toContain("redirect({ to: \"/admin/orders\" })");
    expect(detailRouteSource).not.toContain("createFileRoute, redirect");
  });

  it("uses typed route params for desktop, mobile, and edit navigation", () => {
    for (const source of [desktopColumnsSource, mobileCardSource]) {
      expect(source).toContain('to="/admin/orders/$orderId"');
      expect(source).toContain("params={{ orderId: order.id }}");
      expect(source).toContain("aria-label={`View order ${order.id}`}");
      expect(source).not.toContain("to={`/admin/orders/${order.id}` as string}");
    }

    expect(listRouteSource).toContain('to: "/admin/orders/$orderId/edit"');
    expect(listRouteSource).toContain("params: { orderId: id }");
    expect(listRouteSource).not.toContain(
      "to: `/admin/orders/${id}/edit` as string",
    );
  });
});
