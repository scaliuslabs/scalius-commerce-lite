import { describe, expect, it } from "vitest";
import {
  ADMIN_COMMAND_POLICY_DIGEST,
  ADMIN_COMMAND_REGISTRY,
  auditAdminCommandRegistry,
  describeAdminCapability,
  isSafeAdminPathTemplate,
  resolveAdminApiCapability,
  searchAdminCapabilities,
  type AdminCommandDescriptor,
} from "./admin-command-registry";

function operation(key: string): AdminCommandDescriptor {
  const descriptor = ADMIN_COMMAND_REGISTRY.find((candidate) => candidate.operationKey === key);
  if (!descriptor) throw new Error(`Missing test operation: ${key}`);
  return descriptor;
}

describe("Admin command registry", () => {
  it("classifies every frozen operation once with bounded policy metadata", () => {
    expect(ADMIN_COMMAND_REGISTRY).toHaveLength(306);
    expect(new Set(ADMIN_COMMAND_REGISTRY.map((descriptor) => descriptor.id)).size).toBe(306);
    expect(new Set(ADMIN_COMMAND_REGISTRY.map((descriptor) => descriptor.operationKey)).size).toBe(306);
    expect(ADMIN_COMMAND_REGISTRY.every((descriptor) => descriptor.execution.enabled === false)).toBe(true);
    expect(auditAdminCommandRegistry()).toEqual([]);
    expect(ADMIN_COMMAND_POLICY_DIGEST).toBe("admin-command-v1-306-5195e4af");
  });

  it("keeps reads eligible but execution-disabled in this policy-only slice", () => {
    const descriptor = operation("GET /api/v1/admin/products");

    expect(descriptor).toMatchObject({
      id: "admin.api.get.products",
      surface: "admin",
      authorization: { kind: "permission", permission: "products.view" },
      implementation: "typed-command",
      flags: { readOnly: true, destructive: false, financial: false },
      risk: "R0",
      confirmation: "none",
      idempotency: { policy: "not-applicable", evidence: { kind: "not-applicable" } },
      preview: { required: false, supported: false, dryRunSupported: false },
      execution: { enabled: false, readiness: "read-only-eligible" },
    });
  });

  it("classifies ordinary CRUD as persistent reversible commands pending controls", () => {
    const create = operation("POST /api/v1/admin/products");
    const update = operation("PUT /api/v1/admin/products/{id}");
    const softDelete = operation("DELETE /api/v1/admin/products/{id}");
    const restore = operation("POST /api/v1/admin/products/{id}/restore");

    expect(create).toMatchObject({
      risk: "R2",
      authorization: { kind: "permission", permission: "products.create" },
      flags: { readOnly: false, reversible: true, destructive: false },
    });
    expect(update).toMatchObject({
      risk: "R2",
      authorization: { kind: "permission", permission: "products.edit" },
      flags: { reversible: true, destructive: false },
    });
    expect(softDelete).toMatchObject({
      risk: "R3",
      flags: { reversible: true, destructive: true },
    });
    expect(restore).toMatchObject({
      risk: "R2",
      flags: { reversible: true, destructive: false },
    });
    for (const descriptor of [create, update, softDelete, restore]) {
      expect(descriptor.idempotency).toEqual({
        policy: "required",
        evidence: { kind: "unproven" },
      });
      expect(descriptor.preview).toMatchObject({ required: true, supported: false });
      expect(descriptor.execution.enabled).toBe(false);
    }
  });

  it("requires the exact refund permission and strongest financial controls", () => {
    expect(operation("POST /api/v1/admin/orders/{id}/refund")).toMatchObject({
      id: "admin.api.post.orders.by-id.refund",
      authorization: { kind: "permission", permission: "orders.refund" },
      implementation: "typed-command",
      flags: {
        readOnly: false,
        reversible: false,
        destructive: true,
        financial: true,
        freshAuth: true,
      },
      risk: "R3",
      confirmation: "signed-explicit-fresh-auth",
      idempotency: { policy: "required", evidence: { kind: "unproven" } },
      execution: { enabled: false, readiness: "requires-controls" },
      auditCategory: "financial",
      concurrency: "serial-and-reconcile",
    });
  });

  it("keeps RBAC and security mutations in dedicated secure controls", () => {
    expect(operation("PUT /api/v1/admin/rbac/roles/{id}")).toMatchObject({
      authorization: { kind: "permission", permission: "team.manage_roles" },
      implementation: "secure-manual",
      flags: { readOnly: false, freshAuth: true },
      risk: "R3",
      confirmation: "secure-control",
      execution: { enabled: false, readiness: "secure-manual" },
      auditCategory: "security",
    });
    expect(operation("GET /api/v1/admin/auth/users").authorization).toEqual({
      kind: "any-of",
      permissions: ["team.manage", "team.manage_roles", "team.view"],
    });
  });

  it("classifies credential reads and writes without putting secrets in model schemas", () => {
    expect(operation("GET /api/v1/admin/settings/stripe")).toMatchObject({
      flags: { readOnly: true },
      secretHandling: "redacted-result",
      result: { redactionRequired: true },
      execution: { enabled: false, readiness: "read-only-eligible" },
    });
    expect(operation("POST /api/v1/admin/settings/stripe")).toMatchObject({
      implementation: "secure-manual",
      authorization: { kind: "permission", permission: "settings.general.edit" },
      flags: { financial: true, external: true, freshAuth: true },
      risk: "R3",
      confirmation: "secure-control",
      secretHandling: "secure-input-and-redacted-result",
      execution: { enabled: false, readiness: "secure-manual" },
    });
    expect(operation("POST /api/v1/admin/auth/change-password")).toMatchObject({
      authorization: { kind: "any-admin" },
      implementation: "secure-manual",
      secretHandling: "secure-input-and-redacted-result",
    });
    expect(operation("POST /api/v1/admin/settings/auth")).toMatchObject({
      implementation: "secure-manual",
      flags: { freshAuth: true },
      secretHandling: "secure-input-and-redacted-result",
      risk: "R3",
    });
  });

  it("marks bulk, permanent delete, inventory, and outbound effects as R3", () => {
    expect(operation("POST /api/v1/admin/products/bulk-delete")).toMatchObject({
      flags: { bulk: true, destructive: true },
      risk: "R3",
    });
    expect(operation("DELETE /api/v1/admin/products/{id}/permanent")).toMatchObject({
      flags: { destructive: true, reversible: false, freshAuth: true },
      risk: "R3",
    });
    expect(operation("POST /api/v1/admin/inventory/stock-adjust")).toMatchObject({
      authorization: { kind: "permission", permission: "products.edit" },
      flags: { readOnly: false, freshAuth: true },
      risk: "R3",
    });
    expect(operation("POST /api/v1/admin/orders/{id}/notifications/{outboxId}/resend")).toMatchObject({
      flags: { external: true },
      risk: "R3",
      concurrency: "serial-and-reconcile",
    });
  });

  it("treats explicitly read-like POST operations as reads", () => {
    for (const key of [
      "POST /api/v1/admin/ai-context/batch-details",
      "POST /api/v1/admin/customers/mcp-search",
      "POST /api/v1/admin/fraud-checker/lookup",
      "POST /api/v1/admin/settings/delivery-providers/create-test",
    ]) {
      expect(operation(key)).toMatchObject({
        flags: { readOnly: true },
        risk: "R0",
        idempotency: { policy: "not-applicable" },
        execution: { enabled: false, readiness: "read-only-eligible" },
      });
    }
  });

  it("refuses to inflate idempotency metadata into executable mutation proof", () => {
    const base = operation("POST /api/v1/admin/products");
    const invalid: AdminCommandDescriptor = {
      ...base,
      execution: { ...base.execution, enabled: true },
      preview: { ...base.preview, supported: true, evidenceId: "preview:test" },
    };

    expect(auditAdminCommandRegistry([invalid])).toContain(
      "POST /api/v1/admin/products: executable mutation lacks implemented idempotency evidence",
    );
  });

  it("fails closed on unsafe, duplicate, ambiguous, unclassified, or non-idempotent descriptors", () => {
    const read = operation("GET /api/v1/admin/products");
    const otherRead = operation("GET /api/v1/admin/categories");
    const mutation = operation("POST /api/v1/admin/products");
    const issues = auditAdminCommandRegistry([
      read,
      { ...otherRead, id: read.id },
      {
        ...read,
        id: "admin.api.get.unsafe",
        operationKey: "GET https://evil.test/admin",
        pathTemplate: "https://evil.test/admin",
      },
      {
        ...read,
        id: "admin.api.get.ambiguous",
        operationKey: "GET /api/v1/admin/products#ambiguous",
        authorization: { kind: "permission", permission: "" },
      },
      {
        ...read,
        id: "admin.api.get.unclassified",
        operationKey: "GET /api/v1/admin/products#unclassified",
        implementation: "unclassified" as AdminCommandDescriptor["implementation"],
      },
      {
        ...mutation,
        id: "admin.api.post.products.no-idempotency",
        operationKey: "POST /api/v1/admin/products#no-idempotency",
        idempotency: { policy: "not-applicable", evidence: { kind: "not-applicable" } },
      },
    ]);

    expect(issues).toContain(`${read.id}: duplicate capability ID`);
    expect(issues).toContain("GET https://evil.test/admin: unsafe path template");
    expect(issues).toContain("GET /api/v1/admin/products#ambiguous: ambiguous authorization");
    expect(issues).toContain("GET /api/v1/admin/products#unclassified: unclassified implementation");
    expect(issues).toContain(
      "POST /api/v1/admin/products#no-idempotency: mutation does not require idempotency",
    );
  });

  it("accepts executable mutation metadata only with named proof for preview and idempotency", () => {
    const base = operation("POST /api/v1/admin/products");
    const proven: AdminCommandDescriptor = {
      ...base,
      idempotency: {
        policy: "required",
        evidence: { kind: "inherent", evidenceId: "test:atomic-product-create" },
      },
      preview: { ...base.preview, supported: true, evidenceId: "test:product-create-preview" },
      execution: { ...base.execution, enabled: true, blockers: [] },
    };

    expect(auditAdminCommandRegistry([proven])).toEqual([]);
  });

  it("only resolves exact registered templates and bounds discovery", () => {
    expect(resolveAdminApiCapability("GET", "/api/v1/admin/products")?.id)
      .toBe("admin.api.get.products");
    expect(resolveAdminApiCapability("GET", "/api/v1/admin/products/actual-id")).toBeNull();
    expect(resolveAdminApiCapability("GET", "https://evil.test/api/v1/admin/products")).toBeNull();
    expect(resolveAdminApiCapability("GET", "/api/v1/admin/products?token=secret")).toBeNull();
    expect(resolveAdminApiCapability("GET", "/api/v1/admin/../orders")).toBeNull();
    expect(isSafeAdminPathTemplate("/api/v1/admin/orders/:id/invoice")).toBe(true);

    const results = searchAdminCapabilities({ query: "products", limit: 10_000 });
    expect(results.length).toBeLessThanOrEqual(50);
    expect(results.every((descriptor) => descriptor.operationKey.toLowerCase().includes("products") ||
      descriptor.id.includes("products"))).toBe(true);
    expect(describeAdminCapability("admin.api.get.products")?.operationKey)
      .toBe("GET /api/v1/admin/products");
    expect(describeAdminCapability("https://evil.test")).toBeNull();
  });
});
