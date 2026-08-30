import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";
import { storefrontAgentContextRoutes } from "./storefront-agent-contexts";

type Operation = {
  operationId?: string;
  parameters?: Array<{ in?: string; name?: string; required?: boolean }>;
  requestBody?: {
    required?: boolean;
    content?: { "application/json"?: { schema?: {
      properties?: Record<string, { description?: string; example?: string }>;
      required?: string[];
    } } };
  };
};

function buildSpec(): { paths?: Record<string, Record<string, Operation>> } {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  app.route("/storefront/agent-contexts", storefrontAgentContextRoutes);
  return app.getOpenAPIDocument({
    openapi: "3.0.0",
    info: { title: "Storefront agent contexts", version: "1" },
  }) as unknown as { paths?: Record<string, Record<string, Operation>> };
}

describe("storefront agent context OpenAPI contract", () => {
  it("assigns the locked stable operation IDs", () => {
    const spec = buildSpec();
    const expected = [
      ["post", "/api/v1/storefront/agent-contexts", "storefront.context.create"],
      ["get", "/api/v1/storefront/agent-contexts/{contextId}", "storefront.context.get"],
      ["post", "/api/v1/storefront/agent-contexts/{contextId}/close", "storefront.context.close"],
      ["get", "/api/v1/storefront/agent-contexts/{contextId}/cart", "storefront.cart.get"],
      ["post", "/api/v1/storefront/agent-contexts/{contextId}/cart/items", "storefront.cart.add"],
      ["patch", "/api/v1/storefront/agent-contexts/{contextId}/cart/items", "storefront.cart.set_quantity"],
      ["delete", "/api/v1/storefront/agent-contexts/{contextId}/cart/items", "storefront.cart.remove"],
      ["delete", "/api/v1/storefront/agent-contexts/{contextId}/cart", "storefront.cart.clear"],
      ["put", "/api/v1/storefront/agent-contexts/{contextId}/discount", "storefront.discount.apply"],
      ["delete", "/api/v1/storefront/agent-contexts/{contextId}/discount", "storefront.discount.remove"],
      ["put", "/api/v1/storefront/agent-contexts/{contextId}/delivery", "storefront.delivery.set"],
      ["post", "/api/v1/storefront/agent-contexts/{contextId}/checkout/validate", "storefront.checkout.validate"],
      ["post", "/api/v1/storefront/agent-contexts/{contextId}/checkout/quote", "storefront.checkout.quote"],
      ["post", "/api/v1/storefront/agent-contexts/{contextId}/checkout/submit", "storefront.checkout.submit"],
      ["post", "/api/v1/storefront/agent-contexts/{contextId}/customer/auth", "storefront.customer_auth.begin"],
      ["get", "/api/v1/storefront/agent-contexts/{contextId}/customer/auth/{continuationId}", "storefront.customer_auth.status"],
      ["post", "/api/v1/storefront/agent-contexts/{contextId}/customer/logout", "storefront.customer_auth.logout"],
      ["get", "/api/v1/storefront/agent-contexts/{contextId}/customer/profile", "storefront.customer_profile.get"],
      ["put", "/api/v1/storefront/agent-contexts/{contextId}/customer/profile", "storefront.customer_profile.update"],
      ["get", "/api/v1/storefront/agent-contexts/{contextId}/customer/orders", "storefront.orders.list"],
      ["get", "/api/v1/storefront/agent-contexts/{contextId}/customer/orders/{orderId}", "storefront.orders.get"],
      ["get", "/api/v1/storefront/agent-contexts/{contextId}/orders/{orderId}/receipt", "storefront.receipt.get"],
      ["post", "/api/v1/storefront/agent-contexts/{contextId}/orders/{orderId}/support-requests", "storefront.orders.support_request.create"],
      ["post", "/api/v1/storefront/agent-contexts/{contextId}/orders/{orderId}/payment", "storefront.orders.payment.begin"],
      ["get", "/api/v1/storefront/agent-contexts/{contextId}/payments/{continuationId}", "storefront.payment.status"],
      ["post", "/api/v1/storefront/agent-contexts/{contextId}/orders/{orderId}/payment-recovery", "storefront.payment_recovery.begin"],
      ["get", "/api/v1/storefront/agent-contexts/{contextId}/payment-recoveries/{continuationId}", "storefront.payment_recovery.status"],
      ["get", "/api/v1/storefront/agent-contexts/{contextId}/continuations/{continuationId}", "storefront.continuations.get"],
    ] as const;

    for (const [method, path, operationId] of expected) {
      expect(spec.paths?.[path]?.[method]?.operationId).toBe(operationId);
    }
  });

  it("requires every mutation body that carries context state", () => {
    const spec = buildSpec();
    const mutations = [
      ["post", "/api/v1/storefront/agent-contexts/{contextId}/close"],
      ["post", "/api/v1/storefront/agent-contexts/{contextId}/cart/items"],
      ["patch", "/api/v1/storefront/agent-contexts/{contextId}/cart/items"],
      ["delete", "/api/v1/storefront/agent-contexts/{contextId}/cart/items"],
      ["delete", "/api/v1/storefront/agent-contexts/{contextId}/cart"],
      ["put", "/api/v1/storefront/agent-contexts/{contextId}/discount"],
      ["delete", "/api/v1/storefront/agent-contexts/{contextId}/discount"],
      ["put", "/api/v1/storefront/agent-contexts/{contextId}/delivery"],
      ["post", "/api/v1/storefront/agent-contexts/{contextId}/checkout/validate"],
      ["post", "/api/v1/storefront/agent-contexts/{contextId}/checkout/quote"],
      ["post", "/api/v1/storefront/agent-contexts/{contextId}/checkout/submit"],
      ["post", "/api/v1/storefront/agent-contexts/{contextId}/customer/auth"],
      ["post", "/api/v1/storefront/agent-contexts/{contextId}/customer/logout"],
      ["put", "/api/v1/storefront/agent-contexts/{contextId}/customer/profile"],
      ["post", "/api/v1/storefront/agent-contexts/{contextId}/orders/{orderId}/support-requests"],
      ["post", "/api/v1/storefront/agent-contexts/{contextId}/orders/{orderId}/payment"],
      ["post", "/api/v1/storefront/agent-contexts/{contextId}/orders/{orderId}/payment-recovery"],
    ] as const;
    for (const [method, path] of mutations) {
      expect(spec.paths?.[path]?.[method]?.requestBody?.required).toBe(true);
    }
  });

  it("advertises the standard checkout idempotency header", () => {
    const operation = buildSpec().paths?.[
      "/api/v1/storefront/agent-contexts/{contextId}/checkout/submit"
    ]?.post;

    expect(operation?.parameters).toContainEqual(expect.objectContaining({
      in: "header",
      name: "idempotency-key",
      required: false,
    }));
  });

  it("requires the exact buyer-reviewed quote on checkout submit", () => {
    const schema = buildSpec().paths?.[
      "/api/v1/storefront/agent-contexts/{contextId}/checkout/submit"
    ]?.post?.requestBody?.content?.["application/json"]?.schema;

    expect(schema?.required).toContain("expectedQuoteFingerprint");
    expect(schema?.properties?.expectedQuoteFingerprint?.description).toContain("reviewed");
  });

  it("teaches agents to send unambiguous international phone numbers", () => {
    const phone = buildSpec().paths?.[
      "/api/v1/storefront/agent-contexts/{contextId}/checkout/submit"
    ]?.post?.requestBody?.content?.["application/json"]?.schema?.properties?.customerPhone;

    expect(phone).toMatchObject({
      description: expect.stringContaining("international E.164"),
      example: "+8801712345678",
    });
  });
});
