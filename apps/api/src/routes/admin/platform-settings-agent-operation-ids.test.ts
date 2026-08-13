import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";
import {
  PERMISSIONS,
  getRoutePermission,
} from "@scalius/core/auth/rbac";

import { cacheControlRoutes } from "../cache";
import { adminDashboardRoutes } from "./dashboard";
import { businessSettingsRoutes } from "./settings/business";
import { siteSettingsRoutes } from "./settings/site";
import { systemSettingsRoutes } from "./settings/system";
import { smsSettingsRoutes } from "./settings/sms";

type Operation = {
  operationId?: string;
  requestBody?: { required?: boolean };
};

type ExpectedOperation = readonly [
  method: string,
  path: string,
  operationId: string,
];

const EXPECTED_OPERATIONS: readonly ExpectedOperation[] = [
  ["get", "/api/v1/admin/dashboard/home-summary", "dashboard.home.summary"],
  ["get", "/api/v1/admin/dashboard/metrics-summary", "dashboard.home.metrics"],
  ["get", "/api/v1/admin/dashboard/summary", "dashboard.home.full_summary"],
  ["get", "/api/v1/admin/dashboard/activity", "dashboard.home.activity"],
  ["get", "/api/v1/admin/dashboard", "dashboard.home.legacy_combined"],
  ["get", "/api/v1/cache/groups", "dashboard.cache.groups_list"],
  ["post", "/api/v1/cache/clear", "dashboard.cache.purge_all"],
  ["post", "/api/v1/cache/clear-group", "dashboard.cache.purge_groups"],
  ["get", "/api/v1/admin/settings/general", "dashboard.settings.general_get"],
  ["get", "/api/v1/admin/settings/header", "dashboard.settings_header.get_header"],
  ["post", "/api/v1/admin/settings/header", "dashboard.settings_header.header"],
  ["get", "/api/v1/admin/settings/footer", "dashboard.settings_footer.get_footer"],
  ["post", "/api/v1/admin/settings/footer", "dashboard.settings_footer.footer"],
  [
    "get",
    "/api/v1/admin/settings/homepage-presentation",
    "dashboard.settings_homepage_presentation.get_homepage_presentation",
  ],
  [
    "post",
    "/api/v1/admin/settings/homepage-presentation",
    "dashboard.settings_homepage_presentation.homepage_presentation",
  ],
  ["get", "/api/v1/admin/settings/auth", "dashboard.settings.customer_auth_get"],
  ["post", "/api/v1/admin/settings/auth", "dashboard.settings.customer_auth_update"],
  ["get", "/api/v1/admin/settings/email", "dashboard.settings.email_get"],
  ["post", "/api/v1/admin/settings/email", "dashboard.settings.email_update"],
  ["get", "/api/v1/admin/settings/sms", "dashboard.settings_sms.get_sms"],
  ["post", "/api/v1/admin/settings/sms", "dashboard.settings_sms.sms"],
  ["get", "/api/v1/admin/settings/business", "dashboard.settings.business_get"],
  ["post", "/api/v1/admin/settings/business", "dashboard.settings.business_update"],
  ["get", "/api/v1/admin/settings/currency", "dashboard.settings.currency_get"],
  ["post", "/api/v1/admin/settings/currency", "dashboard.settings.currency_update"],
  ["get", "/api/v1/admin/settings/media", "dashboard.settings.media_delivery_get"],
  ["post", "/api/v1/admin/settings/media", "dashboard.settings.media_delivery_update"],
  ["get", "/api/v1/admin/settings/storefront-url", "dashboard.settings.storefront_url_get"],
  ["post", "/api/v1/admin/settings/storefront-url", "dashboard.settings.storefront_url_update"],
  ["get", "/api/v1/admin/settings/allowed-countries", "dashboard.settings.customer_countries_get"],
  ["put", "/api/v1/admin/settings/allowed-countries", "dashboard.settings.customer_countries_update"],
  ["get", "/api/v1/admin/settings/seo", "dashboard.seo.settings_get"],
  ["post", "/api/v1/admin/settings/seo", "dashboard.seo.settings_update"],
  ["get", "/api/v1/admin/settings/seo/feed-diagnostics", "dashboard.seo.feed_diagnostics"],
  ["get", "/api/v1/admin/settings/seo/live-probe", "dashboard.seo.live_probe"],
  ["get", "/api/v1/admin/settings/security", "dashboard.security.policy_get"],
  ["post", "/api/v1/admin/settings/security", "dashboard.security.policy_update"],
  ["get", "/api/v1/admin/settings/security/runtime-sources", "dashboard.security.runtime_sources"],
] as const;

const BODY_MUTATIONS = [
  ["post", "/api/v1/cache/clear-group"],
  ["post", "/api/v1/admin/settings/business"],
  ["post", "/api/v1/admin/settings/currency"],
  ["post", "/api/v1/admin/settings/media"],
  ["post", "/api/v1/admin/settings/storefront-url"],
  ["put", "/api/v1/admin/settings/allowed-countries"],
  ["post", "/api/v1/admin/settings/seo"],
  ["post", "/api/v1/admin/settings/security"],
  ["post", "/api/v1/admin/settings/header"],
  ["post", "/api/v1/admin/settings/footer"],
  ["post", "/api/v1/admin/settings/homepage-presentation"],
  ["post", "/api/v1/admin/settings/auth"],
  ["post", "/api/v1/admin/settings/email"],
  ["post", "/api/v1/admin/settings/sms"],
] as const;

const EXPECTED_PERMISSIONS = [
  ["GET", "/api/v1/admin/dashboard/home-summary", PERMISSIONS.DASHBOARD_VIEW],
  ["GET", "/api/v1/admin/dashboard/metrics-summary", PERMISSIONS.DASHBOARD_VIEW],
  ["GET", "/api/v1/admin/dashboard/summary", PERMISSIONS.DASHBOARD_VIEW],
  ["GET", "/api/v1/admin/dashboard/activity", PERMISSIONS.DASHBOARD_VIEW],
  ["GET", "/api/v1/admin/dashboard", PERMISSIONS.DASHBOARD_VIEW],
  ["GET", "/api/v1/cache/groups", PERMISSIONS.SETTINGS_CACHE_VIEW],
  ["POST", "/api/v1/cache/clear", PERMISSIONS.SETTINGS_CACHE_MANAGE],
  ["POST", "/api/v1/cache/clear-group", PERMISSIONS.SETTINGS_CACHE_MANAGE],
  ["GET", "/api/v1/admin/settings/general", PERMISSIONS.SETTINGS_GENERAL_VIEW],
  ["GET", "/api/v1/admin/settings/header", PERMISSIONS.SETTINGS_GENERAL_VIEW],
  ["POST", "/api/v1/admin/settings/header", PERMISSIONS.SETTINGS_HEADER_EDIT],
  ["GET", "/api/v1/admin/settings/footer", PERMISSIONS.SETTINGS_GENERAL_VIEW],
  ["POST", "/api/v1/admin/settings/footer", PERMISSIONS.SETTINGS_FOOTER_EDIT],
  ["GET", "/api/v1/admin/settings/homepage-presentation", PERMISSIONS.SETTINGS_GENERAL_VIEW],
  ["POST", "/api/v1/admin/settings/homepage-presentation", PERMISSIONS.SETTINGS_GENERAL_EDIT],
  ["GET", "/api/v1/admin/settings/auth", PERMISSIONS.SETTINGS_GENERAL_VIEW],
  ["POST", "/api/v1/admin/settings/auth", PERMISSIONS.SETTINGS_GENERAL_EDIT],
  ["GET", "/api/v1/admin/settings/email", PERMISSIONS.SETTINGS_GENERAL_VIEW],
  ["POST", "/api/v1/admin/settings/email", PERMISSIONS.SETTINGS_GENERAL_EDIT],
  ["GET", "/api/v1/admin/settings/sms", PERMISSIONS.SETTINGS_GENERAL_VIEW],
  ["POST", "/api/v1/admin/settings/sms", PERMISSIONS.SETTINGS_NOTIFICATIONS_EDIT],
  ["GET", "/api/v1/admin/settings/business", PERMISSIONS.SETTINGS_GENERAL_VIEW],
  ["POST", "/api/v1/admin/settings/business", PERMISSIONS.SETTINGS_GENERAL_EDIT],
  ["GET", "/api/v1/admin/settings/currency", PERMISSIONS.SETTINGS_GENERAL_VIEW],
  ["POST", "/api/v1/admin/settings/currency", PERMISSIONS.SETTINGS_GENERAL_EDIT],
  ["GET", "/api/v1/admin/settings/media", PERMISSIONS.SETTINGS_GENERAL_VIEW],
  ["POST", "/api/v1/admin/settings/media", PERMISSIONS.SETTINGS_GENERAL_EDIT],
  ["GET", "/api/v1/admin/settings/storefront-url", PERMISSIONS.SETTINGS_GENERAL_VIEW],
  ["POST", "/api/v1/admin/settings/storefront-url", PERMISSIONS.SETTINGS_GENERAL_EDIT],
  ["GET", "/api/v1/admin/settings/allowed-countries", PERMISSIONS.SETTINGS_GENERAL_VIEW],
  ["PUT", "/api/v1/admin/settings/allowed-countries", PERMISSIONS.SETTINGS_GENERAL_EDIT],
  ["GET", "/api/v1/admin/settings/seo", PERMISSIONS.SETTINGS_GENERAL_VIEW],
  ["POST", "/api/v1/admin/settings/seo", PERMISSIONS.SETTINGS_SEO_EDIT],
  ["GET", "/api/v1/admin/settings/seo/feed-diagnostics", PERMISSIONS.SETTINGS_GENERAL_VIEW],
  ["GET", "/api/v1/admin/settings/seo/live-probe", PERMISSIONS.SETTINGS_GENERAL_VIEW],
  ["GET", "/api/v1/admin/settings/security", PERMISSIONS.SETTINGS_GENERAL_VIEW],
  ["POST", "/api/v1/admin/settings/security", PERMISSIONS.SETTINGS_GENERAL_EDIT],
  ["GET", "/api/v1/admin/settings/security/runtime-sources", PERMISSIONS.SETTINGS_GENERAL_VIEW],
] as const;

function buildSpec() {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  app.route("/admin/dashboard", adminDashboardRoutes);
  app.route("/cache", cacheControlRoutes);
  app.route("/admin/settings", siteSettingsRoutes);
  app.route("/admin/settings", businessSettingsRoutes);
  app.route("/admin/settings", systemSettingsRoutes);
  app.route("/admin/settings", smsSettingsRoutes);
  return app.getOpenAPIDocument({
    openapi: "3.0.0",
    info: { title: "Platform settings operation contract", version: "test" },
  });
}

function operation(
  spec: ReturnType<typeof buildSpec>,
  method: string,
  path: string,
): Operation {
  const pathItem = spec.paths?.[path] as Record<string, Operation> | undefined;
  const result = pathItem?.[method];
  if (!result) throw new Error(`Missing ${method.toUpperCase()} ${path}`);
  return result;
}

describe("dashboard platform/settings stable operation IDs", () => {
  it("freezes every retained semantic route to one explicit dashboard ID", () => {
    const spec = buildSpec();
    const ids = new Set<string>();

    for (const [method, path, operationId] of EXPECTED_OPERATIONS) {
      expect(operation(spec, method, path).operationId).toBe(operationId);
      expect(operationId).toMatch(/^dashboard(\.[a-z][a-z0-9_]*){2,}$/);
      expect(ids.has(operationId), `duplicate ${operationId}`).toBe(false);
      ids.add(operationId);
    }
  });

  it("marks every retained JSON mutation body as required", () => {
    const spec = buildSpec();
    for (const [method, path] of BODY_MUTATIONS) {
      expect(
        operation(spec, method, path).requestBody?.required,
        `${method.toUpperCase()} ${path}`,
      ).toBe(true);
    }
  });

  it("maps every retained operation to its existing live RBAC authority", () => {
    for (const [method, path, permission] of EXPECTED_PERMISSIONS) {
      expect(getRoutePermission(path, method)?.permission).toBe(permission);
    }
  });
});
