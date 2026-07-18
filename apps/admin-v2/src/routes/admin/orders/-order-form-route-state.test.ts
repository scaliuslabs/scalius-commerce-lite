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
const editable = { allowed: true, reason: null };

describe("order form route data", () => {
  it("preserves a truthful empty product catalog", () => {
    expect(buildNewOrderFormRouteData()).toEqual({
      productsWithVariants: [],
    });
  });

  it("keeps catalog discovery out of the new-order route payload", () => {
    expect(buildNewOrderFormRouteData()).toEqual({ productsWithVariants: [] });
    expect(newRouteSource).not.toContain("productsQueryOptions");
    expect(newRouteSource).toContain("buildNewOrderFormRouteData()");
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
      fullEditReadiness: editable,
    })).toEqual({
      productsWithVariants: [],
      defaultValues: { id: "order_1", items: [] },
      fullEditReadiness: editable,
    });

    expect(() => buildEditOrderFormRouteData({
      productsWithVariants: [],
      defaultValues: { id: "order_1", items: [] },
    })).toThrow("Order edit readiness response was unavailable or unusable");
  });

  it("normalizes only an omitted optional SKU-option collection", () => {
    const product = {
      id: "product_1",
      name: "Simple product",
      price: 100,
      discountPercentage: null,
      variants: [{ id: "variant_1", productId: "product_1" }],
    };

    expect(buildEditOrderFormRouteData({
      productsWithVariants: [product],
      defaultValues: { id: "order_1", items: [] },
      fullEditReadiness: editable,
    }).productsWithVariants[0]?.variants[0]?.selectedOptions).toEqual([]);

    expect(() => buildEditOrderFormRouteData({
      productsWithVariants: [{
        ...product,
        variants: [{
          id: "variant_1",
          productId: "product_1",
          selectedOptions: {},
        }],
      }],
      defaultValues: { id: "order_1", items: [] },
      fullEditReadiness: editable,
    })).toThrow("included unusable SKU options");

    expect(() => buildEditOrderFormRouteData({
      productsWithVariants: [{ ...product, variants: undefined }],
      defaultValues: { id: "order_1", items: [] },
      fullEditReadiness: editable,
    })).toThrow("included an unusable product row");

    expect(() => buildEditOrderFormRouteData({
      productsWithVariants: [{ ...product, variants: [null] }],
      defaultValues: { id: "order_1", items: [] },
      fullEditReadiness: editable,
    })).toThrow("included an unusable SKU row");
  });
});

describe("order form route failure wiring", () => {
  it("keeps new-order location failures on the route error boundary", () => {
    const loader = newRouteSource.slice(
      newRouteSource.indexOf("loader: async"),
      newRouteSource.indexOf("head: ()"),
    );
    expect(loader).toContain('deliveryLocationsQueryOptions({ type: "city" })');
    expect(loader).toContain("buildNewOrderFormRouteData()");
    expect(loader).not.toContain("catch");
    expect(loader).not.toContain("productsWithVariants: []");
    expect(newRouteSource).toContain("errorComponent: NewOrderFormErrorComponent");
    expect(newRouteSource).toContain("Product search is loaded independently");
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
