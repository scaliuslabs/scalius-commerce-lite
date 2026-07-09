import { describe, expect, it } from "vitest";

import {
  createAdminAssistantChatApiRequest,
  normalizeAdminAssistantChatResult,
} from "./ai";

describe("admin assistant API adapter", () => {
  it("builds the /ai/chat message contract with bounded sanitized page context", () => {
    const request = createAdminAssistantChatApiRequest({
      message: "What should I check next?",
      history: [
        { role: "user", content: "old 1" },
        { role: "assistant", content: "old 2" },
        { role: "user", content: "old 3" },
        { role: "assistant", content: "old 4" },
        { role: "user", content: "old 5" },
        { role: "assistant", content: "old 6" },
        { role: "user", content: "old 7" },
      ],
      pageContext: {
        version: 1,
        routePath: "/admin/orders?email=buyer@example.com",
        pageTitle: "Orders for buyer@example.com",
        pageHeading: "Order 01775528888 chk_secretToken123456",
        mainScroll: {
          top: 10,
          maxTop: 100,
          viewportHeight: 700,
          contentHeight: 900,
          atTop: false,
          atBottom: false,
        },
        surfaces: [
          {
            id: "orders-table",
            kind: "table",
            label: "Orders",
            selectedCount: 2,
            rowCount: 12,
          },
          {
            id: "bad-kind",
            kind: "table",
            label: "01775528888",
          },
        ],
      },
    });

    expect(request.messages.map((message) => message.role)).toEqual([
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "user",
      "user",
    ]);
    expect(request.messages.at(-1)).toEqual({
      role: "user",
      content: "What should I check next?",
    });
    expect(request.pageContext?.surfaces[0]?.assistantActions).toBeUndefined();

    const serialized = JSON.stringify(request);
    expect(serialized).toContain("Current safe dashboard context");
    expect(serialized).toContain("Route: /admin/orders");
    expect(serialized).toContain("2 selected");
    expect(serialized).toContain("12 total rows");
    expect(serialized).not.toContain("buyer@example.com");
    expect(serialized).not.toContain("01775528888");
    expect(serialized).not.toContain("chk_secretToken123456");
    expect(serialized).not.toContain("old 1");
  });

  it("normalizes assistant navigation actions and drops unsafe API output", () => {
    const result = normalizeAdminAssistantChatResult({
      message: { role: "assistant", content: "Open the products page." },
      usage: { totalTokens: 12 },
      actions: [
        { type: "navigate", path: "/admin/products", label: "Open Products" },
        { type: "navigate", path: "https://evil.test/admin", label: "Evil" },
        { type: "navigate", path: "/admin/orders/123", label: "Order detail" },
        { type: "copy", path: "/admin/settings", label: "Copy" },
      ],
    });

    expect(result).toMatchObject({
      status: "ok",
      message: { role: "assistant", content: "Open the products page." },
      actions: [
        { type: "navigate", path: "/admin/products", label: "Open Products" },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("evil.test");
    expect(JSON.stringify(result)).not.toContain("/admin/orders/123");
  });

  it("normalizes page actions and drops unsupported assistant actions", () => {
    const result = normalizeAdminAssistantChatResult({
      message: { role: "assistant", content: "Here is a tighter product description." },
      actions: [
        {
          type: "apply_field_draft",
          id: "product-edit-form:apply_field_draft",
          targetId: "product-edit-form",
          label: "Apply to description",
          fieldName: "description",
          value: `Fresh description for buyer@example.com ${"x".repeat(20_000)}`,
        },
        {
          type: "delete_product",
          id: "product-edit-form:delete",
          targetId: "product-edit-form",
          label: "Delete product",
        },
      ],
    });

    expect(result).toMatchObject({
      status: "ok",
      actions: [
        {
          type: "apply_field_draft",
          id: "product-edit-form:apply_field_draft",
          targetId: "product-edit-form",
          label: "Apply to description",
          fieldName: "description",
        },
      ],
    });
    expect(JSON.stringify(result)).toContain("[redacted-email]");
    expect(JSON.stringify(result)).not.toContain("buyer@example.com");
    expect(JSON.stringify(result)).not.toContain("delete_product");
    if (result.status !== "ok" || !result.actions?.[0] || result.actions[0].type !== "apply_field_draft") {
      throw new Error("expected apply_field_draft action");
    }
    expect(String(result.actions[0].value).length).toBeLessThanOrEqual(12_000);
  });
});
