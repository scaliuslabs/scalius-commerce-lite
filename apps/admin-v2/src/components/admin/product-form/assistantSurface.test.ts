import { describe, expect, it } from "vitest";

import {
  buildProductAssistantSurfaceLabel,
  countProductAssistantValidationErrors,
  type ProductAssistantSurfaceDraft,
} from "./assistantSurface";

describe("product assistant surface context", () => {
  it("builds a compact label from allowlisted product draft facts", () => {
    const label = buildProductAssistantSurfaceLabel({
      mode: "edit",
      name: "Green Tea",
      description: "<p>Bright &amp; crisp <strong>tea</strong>.</p>",
      isActive: true,
      slug: "green-tea",
      canonicalPath: "/products/tea",
      noIndex: true,
      excludeFromProductFeed: true,
    });

    expect(label).toContain("Edit product");
    expect(label).toContain("title: Green Tea");
    expect(label).toContain("status: Active");
    expect(label).toContain("route: /products/tea");
    expect(label).toContain("discovery: noindex, not in product feed");
    expect(label).toContain("description: Bright & crisp tea.");
    expect(label).not.toContain("<strong>");
  });

  it("redacts sensitive-looking text and ignores commerce-sensitive extras", () => {
    const label = buildProductAssistantSurfaceLabel({
      mode: "create",
      name: "alice@example.com sk_secret_123456",
      description: "<p>Call +8801712345678 before launch.</p>",
      isActive: false,
      slug: "draft-product",
      price: "999",
      sku: "SKU-SECRET-1",
      barcode: "1234567890123",
      stock: "42",
    } as ProductAssistantSurfaceDraft & Record<string, unknown>);

    expect(label).toContain("Create product");
    expect(label).toContain("status: Draft");
    expect(label).toContain("[redacted-email]");
    expect(label).toContain("[redacted-token]");
    expect(label).toContain("[redacted-phone]");
    expect(label).not.toContain("alice@example.com");
    expect(label).not.toContain("sk_secret_123456");
    expect(label).not.toContain("+8801712345678");
    expect(label).not.toContain("999");
    expect(label).not.toContain("SKU-SECRET-1");
    expect(label).not.toContain("1234567890123");
    expect(label).not.toContain("42");
  });

  it("falls back to the sanitized slug route when canonical path is invalid", () => {
    const label = buildProductAssistantSurfaceLabel({
      mode: "edit",
      name: "Tea",
      description: "Simple public description",
      isActive: true,
      slug: "tea",
      canonicalPath: "https://evil.example/products/tea?token=chk_secret",
    });

    expect(label).toContain("route: /products/tea");
    expect(label).not.toContain("evil.example");
    expect(label).not.toContain("chk_secret");
  });

  it("counts nested form validation errors without exposing field values", () => {
    const count = countProductAssistantValidationErrors({
      name: { message: "Required" },
      images: [{ url: { message: "Invalid image URL" } }],
      additionalInfo: {
        root: { type: "manual" },
      },
      ignored: "not an error",
    });

    expect(count).toBe(3);
  });
});
