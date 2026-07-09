import { describe, expect, it } from "vitest";

import {
  ASSISTANT_PROTOCOL_VERSION,
  assistantCommandDescriptorSchema,
  assistantExecuteRequestSchema,
  assistantMessagePartSchema,
  assistantPrepareRequestSchema,
  assistantRiskRequiresExplicitConfirmation,
  isTerminalAssistantWorkflowStatus,
} from "./assistant-contracts";

describe("assistant contracts", () => {
  it("accepts an internally consistent read-only command", () => {
    expect(assistantCommandDescriptorSchema.parse({
      id: "catalog.product.search",
      title: "Search products",
      description: "Searches buyer-visible catalog products.",
      surface: "storefront",
      permission: null,
      riskClass: "read_only",
      confirmationPolicy: "none",
      idempotencyPolicy: "not_applicable",
      readOnly: true,
      reversible: false,
      destructive: false,
      financial: false,
      externalSideEffect: false,
      freshAuthRequired: false,
      supportsDryRun: false,
    })).toMatchObject({ id: "catalog.product.search", readOnly: true });
  });

  it("rejects mutations without idempotency and high-risk commands without step-up", () => {
    const base = {
      id: "admin.order.refund",
      title: "Refund order",
      description: "Refunds a captured order payment.",
      surface: "admin",
      permission: "orders.refund",
      riskClass: "high_risk",
      confirmationPolicy: "explicit",
      idempotencyPolicy: "not_applicable",
      readOnly: false,
      reversible: false,
      destructive: false,
      financial: true,
      externalSideEffect: true,
      freshAuthRequired: true,
      supportsDryRun: true,
    };

    const result = assistantCommandDescriptorSchema.safeParse(base);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join("."))).toEqual(
        expect.arrayContaining(["idempotencyPolicy", "confirmationPolicy"]),
      );
    }
  });

  it("keeps navigation paths same-origin", () => {
    expect(assistantMessagePartSchema.safeParse({
      type: "navigation",
      path: "/products/headphones",
      label: "Open headphones",
      requiresConfirmation: true,
    }).success).toBe(true);

    expect(assistantMessagePartSchema.safeParse({
      type: "navigation",
      path: "https://evil.example/products/headphones",
      label: "Leave the store",
      requiresConfirmation: true,
    }).success).toBe(false);

    for (const path of [
      "/checkout?token=chk_private_receipt",
      "/search?q=buyer@example.test",
      "/search?q=01711111111",
      "/products/%2e%2e/admin",
      "/products/example#private-state",
    ]) {
      expect(assistantMessagePartSchema.safeParse({
        type: "navigation",
        path,
        label: "Unsafe target",
        requiresConfirmation: true,
      }).success, path).toBe(false);
    }

    expect(assistantMessagePartSchema.safeParse({
      type: "navigation",
      path: "/search?q=gaming+accessories&sort=price",
      label: "Search products",
      requiresConfirmation: true,
    }).success).toBe(true);
  });

  it("accepts bounded semantic table, chart, source, export, and auth parts", () => {
    expect(assistantMessagePartSchema.parse({
      type: "table",
      title: "Inventory summary",
      columns: [{ key: "sku", label: "SKU" }, { key: "stock", label: "Stock", align: "end" }],
      rows: [{ id: "row_1", cells: { sku: "SKU-1", stock: 4 } }],
      truncated: false,
    }).type).toBe("table");
    expect(assistantMessagePartSchema.parse({
      type: "chart",
      title: "Orders",
      chartType: "line",
      series: [{ id: "orders", label: "Orders", points: [{ label: "Today", value: 5 }] }],
      textSummary: "Five orders were recorded today.",
    }).type).toBe("chart");
    expect(assistantMessagePartSchema.parse({
      type: "source",
      sourceId: "catalog_product_1",
      label: "Catalog product",
      path: "/products/example",
    }).type).toBe("source");
    expect(assistantMessagePartSchema.parse({
      type: "export",
      title: "Customer export",
      description: "Prepared CSV export.",
      format: "csv",
      path: "/admin/exports/export_1",
    }).type).toBe("export");
    expect(assistantMessagePartSchema.parse({
      type: "auth",
      authType: "step_up",
      title: "Verify this action",
      description: "Complete two-factor verification before continuing.",
      path: "/admin/auth/2fa",
    }).type).toBe("auth");
  });

  it("accepts canonical commerce GIDs as resource references without treating them as URLs", () => {
    expect(assistantMessagePartSchema.parse({
      type: "product_grid",
      products: [{
        id: "gid://scalius/product/prod_1",
        title: "Example product",
        path: "/products/example",
        availability: "in_stock",
        selectedVariantId: "gid://scalius/product-variant/var_1",
        badges: [],
      }],
    }).type).toBe("product_grid");
  });

  it("bounds prepare and execute requests with replay identifiers", () => {
    const prepared = assistantPrepareRequestSchema.parse({
      protocolVersion: ASSISTANT_PROTOCOL_VERSION,
      sessionId: "asst_session_1",
      capability: "admin.product.update",
      arguments: { productId: "prod_1", name: "New name" },
      expectedVersions: [{ resourceType: "product", resourceId: "prod_1", version: "42" }],
      clientRequestId: "request_1",
    });

    expect(prepared.expectedVersions).toHaveLength(1);
    expect(assistantExecuteRequestSchema.parse({
      protocolVersion: ASSISTANT_PROTOCOL_VERSION,
      actionId: "action_1",
      argumentsHash: "a".repeat(64),
      approvalToken: "approval-token",
      idempotencyKey: "execute_1",
      clientRequestId: "request_2",
    }).idempotencyKey).toBe("execute_1");
  });

  it("classifies confirmation and terminal workflow states", () => {
    expect(assistantRiskRequiresExplicitConfirmation("read_only")).toBe(false);
    expect(assistantRiskRequiresExplicitConfirmation("consequential")).toBe(true);
    expect(isTerminalAssistantWorkflowStatus("retrying")).toBe(false);
    expect(isTerminalAssistantWorkflowStatus("succeeded")).toBe(true);
  });
});
