import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import app from "../app";
import { finalizeOpenApiContract, type OpenApiDocument } from "../openapi-contract";
import {
  AGENT_OPERATION_ID_PATTERN,
  buildAgentOperationManifest,
  type AgentOperationManifestEntry,
} from "./agent-operation-manifest";
import {
  AGENT_OPERATION_MANIFEST_PATH,
  assertCliWorkflowResolverCoreFresh,
  assertOpenApiContractModuleFresh,
  generateAgentOperationManifestSource,
} from "./generate-agent-operation-manifest";

function finalizedDocument(): OpenApiDocument {
  return finalizeOpenApiContract(
    app.getOpenAPIDocument({
      openapi: "3.0.0",
      info: {
        title: "Scalius Commerce API",
        version: "1.0.0",
        description: "E-commerce platform API powering admin dashboard and storefront",
        license: {
          name: "GNU Affero General Public License v3.0",
          url: "https://www.gnu.org/licenses/agpl-3.0.html",
        },
      },
      servers: [{ url: "/", description: "Default" }],
    }),
  ) as unknown as OpenApiDocument;
}

function byId(
  manifest: readonly AgentOperationManifestEntry[],
  operationId: string,
): AgentOperationManifestEntry {
  const entry = manifest.find((operation) => operation.operationId === operationId);
  if (!entry) throw new Error(`Missing generated operation ${operationId}`);
  return entry;
}

const HTTP_METHODS = new Set([
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
  "trace",
]);

function documentedOperationCount(document: OpenApiDocument): number {
  return Object.values(document.paths ?? {}).reduce<number>((total, pathItem) => {
    if (!pathItem || typeof pathItem !== "object") return total;
    return total + Object.keys(pathItem).filter((method) =>
      HTTP_METHODS.has(method.toLowerCase()),
    ).length;
  }, 0);
}

function containsStandaloneNullableSchema(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsStandaloneNullableSchema);
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length === 1 && record.nullable === true) return true;
  return Object.values(record).some(containsStandaloneNullableSchema);
}

describe("agent operation contract", () => {
  const document = finalizedDocument();
  const manifest = buildAgentOperationManifest(document);

  it("classifies every documented operation with a stable unique identity", () => {
    const ids = manifest.map((operation) => operation.operationId);
    expect(ids).toHaveLength(documentedOperationCount(document));
    expect(new Set(ids)).toHaveLength(ids.length);
    expect(ids.every((operationId) => AGENT_OPERATION_ID_PATTERN.test(operationId))).toBe(true);
    expect(
      manifest.every((operation) =>
        ["execute", "continuation", "device", "excluded"].includes(
          operation.exposure,
        ),
      ),
    ).toBe(true);
  });

  it("keeps the human OpenAPI contract valid and navigable", () => {
    const operations = Object.values(document.paths ?? {}).flatMap((pathItem) => {
      if (!pathItem || typeof pathItem !== "object") return [];
      return Object.entries(pathItem)
        .filter(([method]) => HTTP_METHODS.has(method.toLowerCase()))
        .map(([, operation]) => operation as Record<string, unknown>);
    });

    expect(operations).toHaveLength(documentedOperationCount(document));
    expect(
      operations.every(
        (operation) =>
          typeof operation.summary === "string" && operation.summary.trim().length > 0,
      ),
    ).toBe(true);
    expect(containsStandaloneNullableSchema(document)).toBe(false);
    expect(operations.every((operation) => Array.isArray(operation.security))).toBe(true);
  });

  it("exposes the representative dashboard read, dashboard mutation, and storefront read", () => {
    expect(byId(manifest, "dashboard.products.list_summaries")).toMatchObject({
      method: "GET",
      pathTemplate: "/api/v1/admin/products/summaries",
      surface: "dashboard",
      principals: ["admin"],
      risk: "read",
      batch: "parallel",
      rbac: { type: "permission", permission: "products.view" },
    });
    expect(byId(manifest, "dashboard.products.list")).toMatchObject({
      exposure: "excluded",
      batch: "forbidden",
    });
    expect(byId(manifest, "dashboard.attributes.list_summaries")).toMatchObject({
      method: "GET",
      pathTemplate: "/api/v1/admin/attributes/summaries",
      exposure: "execute",
      maxResponseBytes: 65_536,
      rbac: { type: "permission", permission: "attributes.view" },
    });
    expect(byId(manifest, "dashboard.attributes.list")).toMatchObject({
      exposure: "excluded",
      batch: "forbidden",
    });
    expect(byId(manifest, "dashboard.products.create")).toMatchObject({
      method: "POST",
      pathTemplate: "/api/v1/admin/products",
      surface: "dashboard",
      principals: ["admin"],
      risk: "write",
      batch: "sequential",
      rbac: { type: "permission", permission: "products.create" },
      inputSchema: {
        requestBody: { required: true },
      },
    });
    expect(byId(manifest, "storefront.products.list")).toMatchObject({
      method: "GET",
      pathTemplate: "/api/v1/products",
      surface: "storefront",
      principals: ["customer", "visitor"],
      risk: "read",
      batch: "parallel",
      rbac: { type: "public" },
    });
    expect(byId(manifest, "storefront.context.create")).toMatchObject({
      method: "POST",
      pathTemplate: "/api/v1/storefront/agent-contexts",
      surface: "storefront",
      principals: ["customer", "visitor"],
      risk: "write",
      batch: "sequential",
      rbac: { type: "agentGrant" },
    });
    expect(byId(manifest, "storefront.cart.add")).toMatchObject({
      revision: "required",
      batch: "sequential",
      exposure: "execute",
    });
    expect(byId(manifest, "storefront.continuations.get")).toMatchObject({
      exposure: "continuation",
      batch: "forbidden",
    });
    expect(byId(manifest, "storefront.checkout.quote")).toMatchObject({
      method: "POST",
      pathTemplate: "/api/v1/storefront/agent-contexts/{contextId}/checkout/quote",
      exposure: "execute",
      risk: "read",
      batch: "parallel",
      rbac: { type: "agentGrant" },
      inputSchema: {
        requestBody: { required: true },
      },
    });
  });

  it("uses bounded foundational storefront reads and excludes superseded aggregates", () => {
    for (const [operationId, maxResponseBytes] of [
      ["storefront.products.get_section", 61_440],
      ["storefront.categories.get_section", 32_768],
      ["storefront.categories.list_summaries", 65_536],
      ["storefront.categories.list_product_summaries", 65_536],
      ["storefront.search.predict", 32_768],
      ["storefront.locations.city_summaries", 32_768],
      ["storefront.locations.zone_summaries", 32_768],
      ["storefront.locations.area_summaries", 32_768],
      ["storefront.checkout.get_config", 16_384],
      ["storefront.checkout_language.get_active", 16_384],
    ] as const) {
      expect(byId(manifest, operationId)).toMatchObject({
        exposure: "execute",
        surface: "storefront",
        risk: "read",
        batch: "parallel",
        transport: "json",
        maxRequestBytes: 16_384,
        maxResponseBytes,
        sensitiveOutput: false,
        rbac: { type: "public" },
      });
    }

    for (const operationId of [
      "storefront.products.get",
      "storefront.categories.get",
      "storefront.categories.list",
      "storefront.categories.list_products",
      "storefront.locations.cities",
      "storefront.locations.zones",
      "storefront.locations.areas",
      "storefront.products.search_legacy",
      "storefront.attributes.category_id_alias",
      "storefront.layout.header_alias",
      "storefront.layout.footer_alias",
    ]) {
      expect(byId(manifest, operationId)).toMatchObject({
        exposure: "excluded",
        risk: "read",
        batch: "forbidden",
        inputSchema: null,
        outputSchema: null,
        exclusionReason: expect.any(String),
      });
    }
  });

  it("exposes feed row preview with its exact transport and all-of read bounds", () => {
    expect(byId(manifest, "dashboard.seo.feed_row_preview")).toMatchObject({
      method: "GET",
      pathTemplate:
        "/api/v1/admin/settings/seo/feed-row-preview/{productId}",
      surface: "dashboard",
      exposure: "execute",
      risk: "read",
      openWorld: false,
      batch: "sequential",
      transport: "json",
      maxRequestBytes: 16_384,
      maxResponseBytes: 47_104,
      sensitiveOutput: false,
      rbac: {
        type: "allOf",
        permissions: ["products.view", "settings.general.view"],
      },
    });
  });

  it("keeps device pairing and credential self-revoke separate from general execution", () => {
    expect(byId(manifest, "system.agent_auth.device_start")).toMatchObject({
      method: "POST",
      pathTemplate: "/api/v1/agent-auth/device/start",
      surface: "system",
      exposure: "device",
      principals: ["admin"],
      risk: "security",
      batch: "forbidden",
      sensitiveOutput: true,
      rbac: { type: "public" },
    });
    expect(byId(manifest, "system.agent_auth.device_token")).toMatchObject({
      exposure: "device",
      sensitiveOutput: true,
      rbac: { type: "public" },
    });
    expect(byId(manifest, "system.agent_auth.device_ack")).toMatchObject({
      exposure: "device",
      idempotency: "supported",
      sensitiveOutput: false,
      rbac: { type: "public" },
    });
    expect(byId(manifest, "system.agent_auth.revoke")).toMatchObject({
      exposure: "device",
      risk: "security",
      batch: "forbidden",
      rbac: { type: "agentGrant" },
    });
    for (const operationId of [
      "dashboard.account.password_change",
      "dashboard.account.two_factor.method_challenge",
      "dashboard.account.two_factor.method_update",
      "dashboard.account.two_factor.verify",
      "dashboard.scanner_device.create_link",
    ]) {
      expect(byId(manifest, operationId)).toMatchObject({
        surface: "dashboard",
        exposure: "device",
        risk: "security",
        batch: "forbidden",
        transport: "json",
        maxResponseBytes: 16_384,
      });
    }
    expect(byId(manifest, "dashboard.scanner_device.create_link").rbac).toEqual({
      type: "allOf",
      permissions: ["products.edit", "products.view"],
    });
  });

  it("exposes only the reviewed self-service connection and grant management subset", () => {
    const browserHandoffOperations = manifest.filter((operation) =>
      operation.pathTemplate.startsWith(
        "/api/v1/admin/agent-access/browser-handoffs/",
      ),
    );
    expect(browserHandoffOperations).toHaveLength(2);
    expect(browserHandoffOperations.every((operation) =>
      operation.exposure === "excluded" &&
      operation.rbac.type === "unmapped" &&
      operation.risk === "security" &&
      operation.batch === "forbidden"
    )).toBe(true);

    const managementOperations = manifest.filter((operation) =>
      operation.pathTemplate.startsWith("/api/v1/admin/agent-access/") &&
      !operation.pathTemplate.startsWith(
        "/api/v1/admin/agent-access/browser-handoffs/",
      ),
    );
    expect(managementOperations).toHaveLength(14);
    const executableIds = managementOperations
      .filter((operation) => operation.exposure === "execute")
      .map((operation) => operation.operationId)
      .sort();
    expect(executableIds).toEqual([
      "dashboard.agent_access.connections.events_list",
      "dashboard.agent_access.connections.get",
      "dashboard.agent_access.connections.list",
      "dashboard.agent_access.grants.revoke",
      "dashboard.agent_access.grants.update",
      "dashboard.agent_access.tokens.create",
      "dashboard.agent_access.tokens.rotate",
    ]);
    expect(
      managementOperations.every(
        (operation) =>
          operation.surface === "dashboard" &&
          operation.batch === "forbidden" &&
          operation.rbac.type === "permission" &&
          ["agent_access.view", "agent_access.manage"].includes(
            operation.rbac.permission,
          ),
      ),
    ).toBe(true);
    expect(
      managementOperations
        .filter((operation) => !executableIds.includes(operation.operationId))
        .every((operation) => operation.exposure === "excluded"),
    ).toBe(true);
    expect(byId(manifest, "dashboard.agent_access.tokens.create")).toMatchObject({
      risk: "security",
      sensitiveOutput: true,
      oneTimeSecretOutput: true,
      batch: "forbidden",
    });
    expect(byId(manifest, "dashboard.agent_access.tokens.rotate")).toMatchObject({
      risk: "security",
      sensitiveOutput: true,
      oneTimeSecretOutput: true,
      batch: "forbidden",
    });
  });

  it("keeps request transport separate from artifact and secure continuation output", () => {
    expect(byId(manifest, "dashboard.media.upload_part")).toMatchObject({
      exposure: "execute",
      transport: "octet-stream",
      maxRequestBytes: 5 * 1024 * 1024,
      requiredClientAction: "direct-upload",
      artifactOutput: null,
    });
    expect(byId(manifest, "dashboard.inventory_labels.generate_artifact")).toMatchObject({
      exposure: "execute",
      transport: "json",
      batch: "forbidden",
      artifactOutput: {
        disposition: "attachment",
        delivery: "authenticated-handle",
      },
    });
    for (const operationId of [
      "dashboard.orders.export",
      "dashboard.orders.payment_recovery_export",
    ]) {
      expect(byId(manifest, operationId)).toMatchObject({
        exposure: "execute",
        transport: "json",
        batch: "forbidden",
        artifactOutput: {
          mediaTypes: ["text/csv"],
          disposition: "attachment",
          maxArtifactBytes: 16 * 1024 * 1024,
          delivery: "authenticated-handle",
        },
      });
    }
    expect(byId(manifest, "dashboard.orders.invoice_print")).toMatchObject({
      exposure: "execute",
      transport: "json",
      batch: "forbidden",
      artifactOutput: {
        mediaTypes: ["text/html"],
        disposition: "attachment",
        maxArtifactBytes: 65_536,
        delivery: "authenticated-handle",
      },
    });
    expect(byId(manifest, "dashboard.theme.preview_session_create")).toMatchObject({
      exposure: "continuation",
      transport: "continuation",
      sensitiveOutput: true,
      continuationOutput: {
        method: "POST",
        urlJsonPointer: "/data/continuation/url",
        fieldsJsonPointer: "/data/continuation/fields",
        sensitiveFields: ["continuationCode"],
      },
    });
    for (const operationId of [
      "storefront.customer_auth.begin",
      "storefront.orders.payment.begin",
      "storefront.payment_recovery.begin",
    ]) {
      expect(byId(manifest, operationId)).toMatchObject({
        exposure: "continuation",
        transport: "continuation",
        batch: "forbidden",
        sensitiveOutput: true,
        oneTimeSecretOutput: false,
        continuationOutput: {
          method: "POST",
          urlJsonPointer: "/data/browser/url",
          fieldsJsonPointer: "/data/browser/fields",
          sensitiveFields: ["continuationCode"],
        },
      });
    }
    expect(byId(manifest, "system.storefront_continuations.theme_preview_exchange")).toMatchObject({
      pathTemplate: "/api/v1/storefront/agent-continuations/theme-preview",
      surface: "system",
      principals: ["internal"],
      exposure: "excluded",
      sensitiveOutput: true,
    });
    expect(byId(manifest, "system.storefront_theme_preview.resolve")).toMatchObject({
      pathTemplate: "/api/v1/storefront/theme-preview/resolve",
      surface: "system",
      principals: ["internal"],
      exposure: "excluded",
      risk: "security",
      batch: "forbidden",
      rbac: { type: "unmapped" },
    });
    expect(
      manifest.some(
        (operation) =>
          operation.pathTemplate ===
          "/api/v1/storefront/agent-continuations/theme-preview/{continuationId}",
      ),
    ).toBe(false);
  });

  it("keeps unreviewed operations present but fail-closed", () => {
    const excluded = manifest.filter((operation) => operation.exposure === "excluded");
    expect(excluded.length).toBeGreaterThan(0);
    expect(
      excluded.every(
        (operation) =>
          operation.exclusionReason &&
          operation.batch === "forbidden" &&
          operation.inputSchema === null &&
          operation.outputSchema === null,
      ),
    ).toBe(true);
  });

  it("keeps legacy cookie, proof, OTP, and provider storefront routes out of execution", () => {
    const legacyStorefrontOperationIds = [
      "storefront.customer_auth_send_otp.send_otp",
      "storefront.customer_auth_verify_otp.verify_otp",
      "storefront.customer_auth_me.get_me",
      "storefront.customer_auth_logout.logout",
      "storefront.customer_auth_profile.replace_profile",
      "storefront.customer_auth_orders.get_orders",
      "storefront.customer_auth_orders.get",
      "storefront.customer_auth_orders_support_requests.support_requests",
      "storefront.customer_auth_orders_payment_session.payment_session",
      "storefront.customer_auth_orders_claim_receipt.claim_receipt",
      "storefront.discounts_validate.validate",
      "storefront.orders_status.get",
      "storefront.orders_payment_recovery_send_otp.send_otp",
      "storefront.orders_payment_recovery_verify_otp.verify_otp",
      "storefront.orders_receipt.get",
      "storefront.orders_receipt_support_requests.support_requests",
      "storefront.orders_cart_validation.cart_validation",
      "storefront.orders_tax_quote.tax_quote",
      "storefront.orders.orders",
      "storefront.payment_stripe_intent.intent",
      "storefront.payment_stripe_reconcile.reconcile",
      "storefront.payment_sslcommerz_session.session",
      "storefront.payment_polar_session.session",
    ] as const;

    for (const operationId of legacyStorefrontOperationIds) {
      expect(byId(manifest, operationId)).toMatchObject({
        surface: "storefront",
        exposure: "excluded",
        batch: "forbidden",
        transport: "json",
        inputSchema: null,
        outputSchema: null,
        exclusionReason: expect.any(String),
      });
    }

    for (const operationId of [
      "storefront.customer_auth_verify_otp.verify_otp",
      "storefront.orders_payment_recovery_verify_otp.verify_otp",
      "storefront.orders_receipt.get",
      "storefront.orders.orders",
      "storefront.payment_stripe_intent.intent",
      "storefront.payment_sslcommerz_session.session",
      "storefront.payment_polar_session.session",
    ]) {
      expect(byId(manifest, operationId).sensitiveOutput).toBe(true);
    }
  });

  it("keeps shipment status duplicate routes out of execution", () => {
    expect(byId(manifest, "dashboard.orders.shipment_refresh")).toMatchObject({
      exposure: "execute",
      pathTemplate:
        "/api/v1/admin/orders/{id}/shipments/{shipmentId}/refresh",
    });
    for (const operationId of [
      "dashboard.orders.shipment_status_sync",
      "dashboard.shipments.status_sync",
    ]) {
      expect(byId(manifest, operationId)).toMatchObject({
        exposure: "excluded",
        inputSchema: null,
        outputSchema: null,
        exclusionReason: expect.stringContaining("shipment"),
      });
    }
  });

  it("exposes operations whose required idempotency key is canonical at the route boundary", () => {
    for (const operationId of [
      "dashboard.orders.create",
      "dashboard.orders.invoice_issue",
      "dashboard.orders.notification_resend",
      "dashboard.orders.return_create",
      "dashboard.orders.return_approve",
      "dashboard.orders.return_receive",
      "dashboard.orders.return_cancel",
    ]) {
      expect(byId(manifest, operationId)).toMatchObject({
        exposure: "execute",
        idempotency: "required",
      });
      expect(byId(manifest, operationId).inputSchema).not.toBeNull();
      expect(byId(manifest, operationId).outputSchema).not.toBeNull();
    }
    expect(byId(manifest, "storefront.checkout.submit")).toMatchObject({
      exposure: "execute",
      risk: "financial",
      idempotency: "required",
      revision: "required",
      batch: "sequential",
      maxResponseBytes: 16_384,
      rbac: { type: "agentGrant" },
    });
  });

  it("does not advertise idempotency support for operations that do not consume the key", () => {
    for (const operationId of [
      "dashboard.orders.notification_retry",
      "dashboard.orders.support_request_update",
    ]) {
      expect(byId(manifest, operationId)).toMatchObject({
        exposure: "execute",
        idempotency: "none",
        batch: "forbidden",
      });
      expect(byId(manifest, operationId).inputSchema).not.toBeNull();
      expect(byId(manifest, operationId).outputSchema).not.toBeNull();
    }
  });

  it("keeps the checked-in manifest byte-for-byte fresh and timestamp-free", () => {
    const expected = generateAgentOperationManifestSource(document);
    const checkedIn = readFileSync(AGENT_OPERATION_MANIFEST_PATH, "utf8");
    expect(checkedIn).toBe(expected);
    expect(checkedIn).not.toMatch(/generatedAt|new Date\(|20\d\d-\d\d-\d\dT/);
  });

  it("keeps the runtime OpenAPI response byte-for-byte deploy generated", () => {
    expect(() => assertOpenApiContractModuleFresh(document)).not.toThrow();
  });

  it("keeps the dependency-free CLI workflow resolver byte-for-byte generated", () => {
    expect(() => assertCliWorkflowResolverCoreFresh()).not.toThrow();
  });
});
