import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";

import { adminAnalyticsRoutes } from "./analytics";
import { adminAuthManagementRoutes } from "./auth-management";
import { adminFraudCheckerRoutes } from "./fraud-checker";
import { adminRbacRoutes } from "./rbac";
import { deliveryProvidersRoutes } from "./settings/delivery-providers";
import { metaConversionsAdminRoutes } from "./settings/meta-conversions-admin";

function buildSpec() {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  app.route("/admin/analytics", adminAnalyticsRoutes);
  app.route("/admin/auth", adminAuthManagementRoutes);
  app.route("/admin/fraud-checker", adminFraudCheckerRoutes);
  app.route("/admin/rbac", adminRbacRoutes);
  app.route("/admin/settings/delivery-providers", deliveryProvidersRoutes);
  app.route("/admin/settings/meta-conversions", metaConversionsAdminRoutes);
  return app.getOpenAPIDocument({
    openapi: "3.0.0",
    info: { title: "Integrations and identity operations", version: "test" },
  });
}

describe("integrations and administrator identity operation IDs", () => {
  it("keeps every in-scope semantic command stable at the route authority", () => {
    const spec = buildSpec();
    const expected: Record<string, Record<string, string>> = {
      "/api/v1/admin/analytics": {
        get: "dashboard.analytics.list",
        post: "dashboard.analytics.create",
      },
      "/api/v1/admin/analytics/health": {
        get: "dashboard.analytics.health",
      },
      "/api/v1/admin/analytics/{id}/source": {
        get: "dashboard.analytics.get",
      },
      "/api/v1/admin/analytics/{id}": {
        put: "dashboard.analytics.update",
        delete: "dashboard.analytics.trash",
      },
      "/api/v1/admin/analytics/{id}/toggle": {
        post: "dashboard.analytics.set_active",
      },
      "/api/v1/admin/analytics/{id}/restore": {
        post: "dashboard.analytics.restore",
      },
      "/api/v1/admin/analytics/{id}/permanent": {
        delete: "dashboard.analytics.delete_permanently",
      },
      "/api/v1/admin/settings/meta-conversions": {
        get: "dashboard.meta_conversions.get",
        post: "dashboard.meta_conversions.update",
      },
      "/api/v1/admin/settings/meta-conversions/logs": {
        get: "dashboard.meta_conversions.logs_list",
        post: "dashboard.meta_conversions.logs_cleanup",
        delete: "dashboard.meta_conversions.logs_clear",
      },
      "/api/v1/admin/settings/delivery-providers": {
        get: "dashboard.delivery_providers.list",
        post: "dashboard.delivery_providers.create",
        put: "dashboard.delivery_providers.update",
      },
      "/api/v1/admin/settings/delivery-providers/create-test": {
        post: "dashboard.delivery_providers.test_credentials",
      },
      "/api/v1/admin/settings/delivery-providers/{id}": {
        get: "dashboard.delivery_providers.get",
        post: "dashboard.delivery_providers.test",
        delete: "dashboard.delivery_providers.delete",
      },
      "/api/v1/admin/fraud-checker": {
        get: "dashboard.fraud_providers.list",
        post: "dashboard.fraud_providers.create",
        put: "dashboard.fraud_providers.update",
      },
      "/api/v1/admin/fraud-checker/{id}": {
        delete: "dashboard.fraud_providers.delete",
      },
      "/api/v1/admin/fraud-checker/{id}/test": {
        post: "dashboard.fraud_providers.test",
      },
      "/api/v1/admin/fraud-checker/lookup": {
        post: "dashboard.fraud_lookup.run",
      },
      "/api/v1/admin/auth/users": {
        get: "dashboard.team.users.list",
        post: "dashboard.team.users.invite",
      },
      "/api/v1/admin/auth/users/{id}": {
        delete: "dashboard.team.users.revoke_invitation",
      },
      "/api/v1/admin/auth/users/{id}/resend-setup": {
        post: "dashboard.team.users.resend_invitation",
      },
      "/api/v1/admin/auth/users/{id}/suspension": {
        post: "dashboard.team.users.set_suspension",
      },
      "/api/v1/admin/auth/change-password": {
        post: "dashboard.account.password_change",
      },
      "/api/v1/admin/auth/update-profile": {
        post: "dashboard.account.profile_update",
      },
      "/api/v1/admin/auth/scanner-link": {
        post: "dashboard.scanner_device.create_link",
      },
      "/api/v1/admin/auth/2fa/info": {
        get: "dashboard.account.two_factor.get",
      },
      "/api/v1/admin/auth/2fa/method-challenge": {
        post: "dashboard.account.two_factor.method_challenge",
      },
      "/api/v1/admin/auth/2fa/method": {
        post: "dashboard.account.two_factor.method_update",
      },
      "/api/v1/admin/auth/2fa/verify": {
        post: "dashboard.account.two_factor.verify",
      },
      "/api/v1/admin/auth/sessions": {
        get: "dashboard.account.sessions.list",
        delete: "dashboard.account.sessions.revoke_others",
      },
      "/api/v1/admin/auth/sessions/{commandId}": {
        delete: "dashboard.account.sessions.revoke",
      },
      "/api/v1/admin/auth/account-security": {
        get: "dashboard.account.security_get",
      },
      "/api/v1/admin/rbac/roles": {
        get: "dashboard.team.roles.list",
        post: "dashboard.team.roles.create",
      },
      "/api/v1/admin/rbac/roles/{id}": {
        get: "dashboard.team.roles.get",
        put: "dashboard.team.roles.update",
        delete: "dashboard.team.roles.delete",
      },
      "/api/v1/admin/rbac/user-roles": {
        post: "dashboard.team.user_roles.assign",
        delete: "dashboard.team.user_roles.remove",
      },
      "/api/v1/admin/rbac/user-permissions": {
        post: "dashboard.team.permission_overrides.set",
        delete: "dashboard.team.permission_overrides.remove",
      },
      "/api/v1/admin/rbac/permissions": {
        get: "dashboard.team.permissions.list",
      },
      "/api/v1/admin/rbac/my-permissions": {
        get: "dashboard.account.permissions.get",
      },
    };

    for (const [path, methods] of Object.entries(expected)) {
      for (const [method, operationId] of Object.entries(methods)) {
        expect(
          (spec.paths[path] as Record<string, { operationId?: string }> | undefined)?.[method]
            ?.operationId,
          `${method.toUpperCase()} ${path}`,
        ).toBe(operationId);
      }
    }
  });
});
