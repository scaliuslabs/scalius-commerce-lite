import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertOrderFormLocationLookup,
  buildEditOrderFormRouteData,
  buildNewOrderFormRouteData,
} from "./-order-form-route-state";

const newRouteSource = readFileSync(
  fileURLToPath(new URL("./new.tsx", import.meta.url)),
  "utf8",
);
const editRouteSource = readFileSync(
  fileURLToPath(new URL("./$orderId/edit.tsx", import.meta.url)),
  "utf8",
);
const errorSource = readFileSync(
  fileURLToPath(new URL("./-OrderFormRouteError.tsx", import.meta.url)),
  "utf8",
);

describe("order form route data", () => {
  it("preserves a truthful empty product catalog", () => {
    expect(buildNewOrderFormRouteData({ products: [] })).toEqual({
      productsWithVariants: [],
    });
  });

  it("does not convert a failed or malformed product lookup into an empty catalog", () => {
    expect(() => buildNewOrderFormRouteData(undefined)).toThrow(
      "Product catalog response was unavailable or unusable",
    );
    expect(() => buildNewOrderFormRouteData({})).toThrow(
      "did not include a product list",
    );
    expect(() => buildNewOrderFormRouteData({ products: [{}] })).toThrow(
      "included an unusable product row",
    );
  });

  it("requires an explicit location list while accepting a truthful empty list", () => {
    expect(() => assertOrderFormLocationLookup(undefined)).toThrow(
      "Delivery location response was unavailable or unusable",
    );
    expect(() => assertOrderFormLocationLookup({})).toThrow(
      "did not include a location list",
    );
    expect(() => assertOrderFormLocationLookup({ locations: [] })).not.toThrow();
  });

  it("requires edit form defaults and product data without inventing fallbacks", () => {
    expect(() => buildEditOrderFormRouteData({ productsWithVariants: [] })).toThrow(
      "Order form defaults response was unavailable or unusable",
    );
    expect(() => buildEditOrderFormRouteData({
      productsWithVariants: [{}],
      defaultValues: { items: [] },
    })).toThrow("included an unusable product row");
    expect(() => buildEditOrderFormRouteData({
      productsWithVariants: [],
      defaultValues: {},
    })).toThrow("did not include order items");
    expect(buildEditOrderFormRouteData({
      productsWithVariants: [],
      defaultValues: { id: "order_1", items: [] },
    })).toEqual({
      productsWithVariants: [],
      defaultValues: { id: "order_1", items: [] },
    });
  });
});

describe("order form route failure wiring", () => {
  it("keeps new-order lookup failures on the route error boundary", () => {
    const loader = newRouteSource.slice(
      newRouteSource.indexOf("loader: async"),
      newRouteSource.indexOf("head: ()"),
    );
    expect(loader).toContain("productsQueryOptions({ page: 1, limit: 100 })");
    expect(loader).toContain('deliveryLocationsQueryOptions({ type: "city" })');
    expect(loader).toContain("buildNewOrderFormRouteData(result)");
    expect(loader).not.toContain("catch");
    expect(loader).not.toContain("productsWithVariants: []");
    expect(newRouteSource).toContain("errorComponent: NewOrderFormErrorComponent");
    expect(newRouteSource).toContain("No empty catalog was substituted");
  });

  it("keeps edit lookup failures on a compact retry/back error boundary", () => {
    const loader = editRouteSource.slice(
      editRouteSource.indexOf("loader: async"),
      editRouteSource.indexOf("head: ("),
    );
    expect(loader).toContain("orderFormDataQueryOptions(params.orderId)");
    expect(loader).toContain('deliveryLocationsQueryOptions({ type: "city" })');
    expect(loader).toContain("buildEditOrderFormRouteData(result)");
    expect(loader).not.toContain("catch");
    expect(editRouteSource).toContain("errorComponent: EditOrderFormErrorComponent");
    expect(editRouteSource).not.toContain("redirect({ to:");
    expect(editRouteSource).not.toContain("createFileRoute, redirect");
    expect(errorSource).toContain("Try again");
    expect(errorSource).toContain('<Link to="/admin/orders">Back to orders</Link>');
  });
});
