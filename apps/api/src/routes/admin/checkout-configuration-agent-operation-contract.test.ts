import { OpenAPIHono } from "@hono/zod-openapi";
import { getRoutePermission } from "@scalius/core/auth/rbac/route-permissions";
import { describe, expect, it } from "vitest";

import { adminTaxRoutes } from "./taxes";
import { customerRequestPolicyRoutes } from "./settings/customer-requests";
import { adminLocationRoutes } from "./settings/delivery-locations";
import { notificationChannelsRoutes } from "./settings/notification-channels";
import { paymentSettingsRoutes } from "./settings/payments";
import { shippingMethodsSettingsRoutes } from "./settings/shipping";
import { systemSettingsRoutes } from "./settings/system";

type Operation = {
  operationId?: string;
  requestBody?: { required?: boolean };
};
type Spec = { paths?: Record<string, Record<string, Operation>> };
type ExpectedOperation = readonly [method: string, path: string, operationId: string];

function buildSpec(): Spec {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
  app.route("/settings", systemSettingsRoutes);
  app.route("/settings", paymentSettingsRoutes);
  app.route("/settings", customerRequestPolicyRoutes);
  app.route("/settings/shipping-methods", shippingMethodsSettingsRoutes);
  app.route("/settings/delivery-locations", adminLocationRoutes);
  app.route("/settings/notification-channels", notificationChannelsRoutes);
  app.route("/taxes", adminTaxRoutes);
  return app.getOpenAPIDocument({
    openapi: "3.0.0",
    info: { title: "Checkout configuration operation parity", version: "test" },
  }) as unknown as Spec;
}

const expectedOperations: ExpectedOperation[] = [
  ["get", "/api/v1/admin/settings/checkout-readiness", "dashboard.checkout.readiness_get"],
  ["get", "/api/v1/admin/settings/checkout-flow", "dashboard.checkout.flow_get"],
  ["put", "/api/v1/admin/settings/checkout-flow", "dashboard.checkout.flow_update"],
  ["get", "/api/v1/admin/settings/payment-methods", "dashboard.payments.methods_get"],
  ["post", "/api/v1/admin/settings/payment-methods", "dashboard.payments.methods_update"],
  ["get", "/api/v1/admin/settings/stripe", "dashboard.payments.stripe_get"],
  ["post", "/api/v1/admin/settings/stripe", "dashboard.payments.stripe_update"],
  ["get", "/api/v1/admin/settings/sslcommerz", "dashboard.payments.sslcommerz_get"],
  ["post", "/api/v1/admin/settings/sslcommerz", "dashboard.payments.sslcommerz_update"],
  ["get", "/api/v1/admin/settings/polar", "dashboard.payments.polar_get"],
  ["post", "/api/v1/admin/settings/polar", "dashboard.payments.polar_update"],
  ["get", "/api/v1/admin/settings/shipping-methods", "dashboard.shipping_methods.list"],
  ["post", "/api/v1/admin/settings/shipping-methods", "dashboard.shipping_methods.create"],
  ["get", "/api/v1/admin/settings/shipping-methods/{id}", "dashboard.shipping_methods.get"],
  ["put", "/api/v1/admin/settings/shipping-methods/{id}", "dashboard.shipping_methods.update"],
  ["delete", "/api/v1/admin/settings/shipping-methods/{id}", "dashboard.shipping_methods.trash"],
  ["post", "/api/v1/admin/settings/shipping-methods/{id}/restore", "dashboard.shipping_methods.restore"],
  ["delete", "/api/v1/admin/settings/shipping-methods/{id}/permanent-delete", "dashboard.shipping_methods.delete_permanently"],
  ["get", "/api/v1/admin/settings/delivery-locations", "dashboard.delivery_locations.list"],
  ["post", "/api/v1/admin/settings/delivery-locations", "dashboard.delivery_locations.create"],
  ["delete", "/api/v1/admin/settings/delivery-locations", "dashboard.delivery_locations.bulk_delete"],
  ["delete", "/api/v1/admin/settings/delivery-locations/all", "dashboard.delivery_locations.delete_all"],
  ["get", "/api/v1/admin/settings/delivery-locations/{id}", "dashboard.delivery_locations.get"],
  ["put", "/api/v1/admin/settings/delivery-locations/{id}", "dashboard.delivery_locations.update"],
  ["delete", "/api/v1/admin/settings/delivery-locations/{id}", "dashboard.delivery_locations.trash"],
  ["post", "/api/v1/admin/settings/delivery-locations/import-pathao", "dashboard.delivery_locations.pathao_import_chunk"],
  ["get", "/api/v1/admin/settings/delivery-locations/import-pathao/status", "dashboard.delivery_locations.pathao_import_status"],
  ["delete", "/api/v1/admin/settings/delivery-locations/import-pathao", "dashboard.delivery_locations.pathao_import_reset"],
  ["get", "/api/v1/admin/settings/customer-requests", "dashboard.customer_requests.policy_get"],
  ["put", "/api/v1/admin/settings/customer-requests", "dashboard.customer_requests.policy_update"],
  ["get", "/api/v1/admin/taxes", "dashboard.taxes.configuration_get"],
  ["get", "/api/v1/admin/taxes/settings", "dashboard.taxes.settings_get"],
  ["put", "/api/v1/admin/taxes/settings", "dashboard.taxes.settings_update"],
  ["get", "/api/v1/admin/taxes/classes", "dashboard.taxes.classes_list"],
  ["post", "/api/v1/admin/taxes/classes", "dashboard.taxes.classes_create"],
  ["put", "/api/v1/admin/taxes/classes/{id}", "dashboard.taxes.classes_update"],
  ["delete", "/api/v1/admin/taxes/classes/{id}", "dashboard.taxes.classes_delete"],
  ["get", "/api/v1/admin/taxes/rates", "dashboard.taxes.rates_list"],
  ["post", "/api/v1/admin/taxes/rates", "dashboard.taxes.rates_create"],
  ["put", "/api/v1/admin/taxes/rates/{id}", "dashboard.taxes.rates_update"],
  ["delete", "/api/v1/admin/taxes/rates/{id}", "dashboard.taxes.rates_delete"],
  ["get", "/api/v1/admin/taxes/jurisdictions", "dashboard.taxes.jurisdictions_list"],
  ["get", "/api/v1/admin/taxes/classifications", "dashboard.taxes.classifications_list"],
  ["put", "/api/v1/admin/taxes/classifications/{kind}/{id}", "dashboard.taxes.classifications_update"],
  ["post", "/api/v1/admin/taxes/preview", "dashboard.taxes.preview"],
  ["get", "/api/v1/admin/settings/notification-channels", "dashboard.notifications.customer_rules_get"],
  ["put", "/api/v1/admin/settings/notification-channels", "dashboard.notifications.customer_rules_update"],
  ["get", "/api/v1/admin/settings/notification-channels/admin-channels", "dashboard.notifications.admin_rules_get"],
  ["put", "/api/v1/admin/settings/notification-channels/admin-channels", "dashboard.notifications.admin_rules_update"],
  ["get", "/api/v1/admin/settings/firebase", "dashboard.notifications.firebase_get"],
  ["post", "/api/v1/admin/settings/firebase", "dashboard.notifications.firebase_update"],
];

const operationsWithJsonBodies = new Set([
  "dashboard.checkout.flow_update",
  "dashboard.payments.methods_update",
  "dashboard.payments.stripe_update",
  "dashboard.payments.sslcommerz_update",
  "dashboard.payments.polar_update",
  "dashboard.shipping_methods.create",
  "dashboard.shipping_methods.update",
  "dashboard.delivery_locations.create",
  "dashboard.delivery_locations.bulk_delete",
  "dashboard.delivery_locations.delete_all",
  "dashboard.delivery_locations.update",
  "dashboard.customer_requests.policy_update",
  "dashboard.taxes.settings_update",
  "dashboard.taxes.classes_create",
  "dashboard.taxes.classes_update",
  "dashboard.taxes.rates_create",
  "dashboard.taxes.rates_update",
  "dashboard.taxes.classifications_update",
  "dashboard.taxes.preview",
  "dashboard.notifications.customer_rules_update",
  "dashboard.notifications.admin_rules_update",
  "dashboard.notifications.firebase_update",
]);

const backendScenarios = {
  checkoutFlowAndBuyerMethods: [
    "dashboard.checkout.readiness_get",
    "dashboard.checkout.flow_get",
    "dashboard.checkout.flow_update",
    "dashboard.payments.methods_get",
    "dashboard.payments.methods_update",
  ],
  gatewayConfiguration: [
    "dashboard.payments.stripe_get",
    "dashboard.payments.stripe_update",
    "dashboard.payments.sslcommerz_get",
    "dashboard.payments.sslcommerz_update",
    "dashboard.payments.polar_get",
    "dashboard.payments.polar_update",
  ],
  shippingMethodLifecycle: [
    "dashboard.shipping_methods.list",
    "dashboard.shipping_methods.create",
    "dashboard.shipping_methods.get",
    "dashboard.shipping_methods.update",
    "dashboard.shipping_methods.trash",
    "dashboard.shipping_methods.restore",
    "dashboard.shipping_methods.delete_permanently",
  ],
  deliveryHierarchyAndPathaoImport: [
    "dashboard.delivery_locations.list",
    "dashboard.delivery_locations.create",
    "dashboard.delivery_locations.bulk_delete",
    "dashboard.delivery_locations.delete_all",
    "dashboard.delivery_locations.get",
    "dashboard.delivery_locations.update",
    "dashboard.delivery_locations.trash",
    "dashboard.delivery_locations.pathao_import_chunk",
    "dashboard.delivery_locations.pathao_import_status",
    "dashboard.delivery_locations.pathao_import_reset",
  ],
  customerRequestPolicy: [
    "dashboard.customer_requests.policy_get",
    "dashboard.customer_requests.policy_update",
  ],
  taxPolicyRatesClassificationsAndPreview: [
    "dashboard.taxes.configuration_get",
    "dashboard.taxes.settings_get",
    "dashboard.taxes.settings_update",
    "dashboard.taxes.classes_list",
    "dashboard.taxes.classes_create",
    "dashboard.taxes.classes_update",
    "dashboard.taxes.classes_delete",
    "dashboard.taxes.rates_list",
    "dashboard.taxes.rates_create",
    "dashboard.taxes.rates_update",
    "dashboard.taxes.rates_delete",
    "dashboard.taxes.jurisdictions_list",
    "dashboard.taxes.classifications_list",
    "dashboard.taxes.classifications_update",
    "dashboard.taxes.preview",
  ],
  notificationRulesAndFcm: [
    "dashboard.notifications.customer_rules_get",
    "dashboard.notifications.customer_rules_update",
    "dashboard.notifications.admin_rules_get",
    "dashboard.notifications.admin_rules_update",
    "dashboard.notifications.firebase_get",
    "dashboard.notifications.firebase_update",
  ],
} as const;

const presentationOnlyActions = [
  "reset an unsaved checkout, payment, gateway, customer-policy, notification, tax, or Firebase draft",
  "switch settings tabs, expand gateway panels, or open setup guidance",
  "filter, search, paginate, or select rows without changing server state",
  "toggle or select-all notification rules before the single save command",
] as const;

describe("checkout configuration agent operation contract", () => {
  it("publishes every reviewed semantic operation with one exact stable ID", () => {
    const spec = buildSpec();
    const ids = new Set<string>();
    for (const [method, path, operationId] of expectedOperations) {
      const operation = spec.paths?.[path]?.[method];
      expect(operation?.operationId, `${method.toUpperCase()} ${path}`).toBe(operationId);
      expect(operationId).toMatch(/^dashboard(\.[a-z][a-z0-9_]*){2,}$/);
      expect(ids.has(operationId), `duplicate ${operationId}`).toBe(false);
      ids.add(operationId);
    }
    expect(ids.size).toBe(51);
  });

  it("marks every declared JSON mutation body as required", () => {
    const spec = buildSpec();
    for (const [method, path, operationId] of expectedOperations) {
      if (!operationsWithJsonBodies.has(operationId)) continue;
      expect(spec.paths?.[path]?.[method]?.requestBody?.required, operationId).toBe(true);
    }
    expect(operationsWithJsonBodies.size).toBe(22);
  });

  it("maps every server outcome to one backend scenario and keeps local UI actions local", () => {
    const expectedIds = expectedOperations.map((entry) => entry[2]);
    const scenarioIds = Object.values(backendScenarios).flat();
    expect(new Set(scenarioIds).size).toBe(scenarioIds.length);
    expect([...scenarioIds].sort()).toEqual([...expectedIds].sort());
    expect(presentationOnlyActions).toHaveLength(4);
  });

  it("keeps tax list reads below the operation ceiling and under taxes.view", () => {
    const spec = buildSpec() as unknown as {
      paths: Record<string, Record<string, {
        parameters?: Array<{ name?: string; schema?: { maximum?: number } }>;
        responses?: Record<string, { content?: Record<string, { schema?: {
          properties?: { data?: { properties?: { items?: { maxItems?: number } } } };
        } }> }>;
      }>>;
    };
    for (const path of ["classes", "rates", "jurisdictions"]) {
      const routePath = `/api/v1/admin/taxes/${path}`;
      const operation = spec.paths[routePath]?.get;
      const limit = operation?.parameters?.find((parameter) => parameter.name === "limit");
      const items = operation?.responses?.["200"]?.content?.["application/json"]
        ?.schema?.properties?.data?.properties?.items;
      expect(limit?.schema?.maximum, routePath).toBe(50);
      expect(items?.maxItems, routePath).toBe(50);
      expect(getRoutePermission(routePath, "GET"), routePath).toEqual({
        permission: "taxes.view",
      });
    }
    expect(getRoutePermission("/api/v1/admin/taxes/settings", "GET")).toEqual({
      permission: "taxes.view",
    });
  });
});
