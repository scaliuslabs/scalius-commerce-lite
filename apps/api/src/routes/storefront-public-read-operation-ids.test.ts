import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";

import { attributeRoutes } from "./attributes";
import { categoryRoutes } from "./categories";
import { publicCheckoutLanguageRoutes } from "./checkout-languages";
import { checkoutRoutes } from "./checkout";
import { collectionRoutes } from "./collections";
import { footerRoutes } from "./footer";
import { headerRoutes } from "./header";
import { locationRoutes } from "./locations";
import { productRoutes } from "./products";
import { searchRoutes } from "./search";
import { seoRoutes } from "./seo";
import { shippingMethodRoutes } from "./shipping-methods";
import { storefrontRoutes } from "./storefront";
import {
  storefrontPublicPresentationOnlyScenarios,
  storefrontPublicReadExcludedOperations,
  storefrontPublicReadScenarios,
} from "./storefront-public-read-scenarios.fixture";

type Operation = { operationId?: string };
type Spec = { paths?: Record<string, Record<string, Operation>> };
type Expected = readonly [method: string, path: string, operationId: string];

function buildSpec(): Spec {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  app.route("/attributes", attributeRoutes);
  app.route("/categories", categoryRoutes);
  app.route("/checkout", checkoutRoutes);
  app.route("/checkout-languages", publicCheckoutLanguageRoutes);
  app.route("/collections", collectionRoutes);
  app.route("/footer", footerRoutes);
  app.route("/header", headerRoutes);
  app.route("/locations", locationRoutes);
  app.route("/products", productRoutes);
  app.route("/search", searchRoutes);
  app.route("/seo", seoRoutes);
  app.route("/shipping-methods", shippingMethodRoutes);
  app.route("/storefront", storefrontRoutes);
  return app.getOpenAPIDocument({
    openapi: "3.0.0",
    info: { title: "Storefront public read parity", version: "test" },
  }) as unknown as Spec;
}

const expectedOperations: Expected[] = [
  ["get", "/api/v1/products", "storefront.products.list"],
  ["get", "/api/v1/products/search", "storefront.products.search_legacy"],
  ["get", "/api/v1/products/{slug}/sections/{section}", "storefront.products.get_section"],
  ["get", "/api/v1/products/{slug}", "storefront.products.get"],
  ["get", "/api/v1/categories", "storefront.categories.list"],
  ["get", "/api/v1/categories/summaries", "storefront.categories.list_summaries"],
  ["get", "/api/v1/categories/{slug}", "storefront.categories.get"],
  ["get", "/api/v1/categories/{slug}/sections/{section}", "storefront.categories.get_section"],
  ["get", "/api/v1/categories/{slug}/products", "storefront.categories.list_products"],
  ["get", "/api/v1/categories/{slug}/product-summaries", "storefront.categories.list_product_summaries"],
  ["get", "/api/v1/collections", "storefront.collections.list"],
  ["get", "/api/v1/collections/{id}", "storefront.collections.get"],
  ["get", "/api/v1/search", "storefront.search.predict"],
  ["get", "/api/v1/attributes/filterable", "storefront.attributes.list_filterable"],
  ["get", "/api/v1/attributes/category/{categoryId}", "storefront.attributes.category_id_alias"],
  ["get", "/api/v1/attributes/category-slug/{categorySlug}", "storefront.attributes.list_for_category"],
  ["get", "/api/v1/attributes/search-filters", "storefront.attributes.list_for_search"],
  ["get", "/api/v1/locations/cities", "storefront.locations.cities"],
  ["get", "/api/v1/locations/cities/summaries", "storefront.locations.city_summaries"],
  ["get", "/api/v1/locations/zones", "storefront.locations.zones"],
  ["get", "/api/v1/locations/zones/summaries", "storefront.locations.zone_summaries"],
  ["get", "/api/v1/locations/areas", "storefront.locations.areas"],
  ["get", "/api/v1/locations/areas/summaries", "storefront.locations.area_summaries"],
  ["get", "/api/v1/shipping-methods", "storefront.shipping_methods.list"],
  ["get", "/api/v1/storefront/homepage", "storefront.homepage.get"],
  ["get", "/api/v1/storefront/layout", "storefront.layout.get"],
  ["get", "/api/v1/storefront/pages/slug/{slug}", "storefront.pages.render_by_slug_alias"],
  ["get", "/api/v1/header", "storefront.layout.header_alias"],
  ["get", "/api/v1/footer", "storefront.layout.footer_alias"],
  ["get", "/api/v1/checkout/config", "storefront.checkout.get_config"],
  ["get", "/api/v1/checkout-languages/active", "storefront.checkout_language.get_active"],
  ["get", "/api/v1/seo", "storefront.seo.get"],
];

describe("storefront public read operation identity", () => {
  it("publishes stable surface-qualified IDs for every buyer read in this slice", () => {
    const spec = buildSpec();
    const ids = new Set<string>();
    for (const [method, path, operationId] of expectedOperations) {
      expect(spec.paths?.[path]?.[method]?.operationId, `${method.toUpperCase()} ${path}`).toBe(operationId);
      expect(operationId).toMatch(/^(dashboard|storefront|system)(\.[a-z][a-z0-9_]*){2,}$/);
      expect(ids.has(operationId), `duplicate ${operationId}`).toBe(false);
      ids.add(operationId);
    }
  });

  it("classifies every canonical operation once and names every compatibility exclusion", () => {
    const canonicalIds = Object.values(storefrontPublicReadScenarios).flat();
    const excludedIds = Object.values(storefrontPublicReadExcludedOperations);
    expect(new Set(canonicalIds).size).toBe(canonicalIds.length);
    expect(new Set(excludedIds).size).toBe(excludedIds.length);
    expect(canonicalIds.some((id) => excludedIds.includes(id as never))).toBe(false);
    expect(new Set([...canonicalIds, ...excludedIds])).toEqual(
      new Set(expectedOperations.map((entry) => entry[2])),
    );
    expect(storefrontPublicPresentationOnlyScenarios).toHaveLength(2);
  });

  it("documents bounded public product sections without operational inventory counters", () => {
    const spec = buildSpec();
    const operation = JSON.stringify(
      spec.paths?.["/api/v1/products/{slug}/sections/{section}"]?.get,
    );
    expect(operation).toContain('"maxLength":12000');
    expect(operation).toContain('"maxItems":10');
    expect(operation).toContain('"availabilityBand"');
    expect(operation).not.toContain('"reservedStock"');
    expect(operation).not.toContain('"lowStockThreshold"');
    expect(operation).not.toContain('"trackInventory"');
  });
});
