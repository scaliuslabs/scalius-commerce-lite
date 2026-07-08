import { describe, expect, it } from "vitest";

import {
  buildProductAssistantSurfaceLabel,
  createProductAssistantActionHandlers,
  createProductAssistantSurfaceActions,
  countProductAssistantValidationErrors,
  getProductAssistantActionId,
  PRODUCT_ASSISTANT_SAFE_FIELDS,
  PRODUCT_ASSISTANT_SURFACE_CAPABILITIES,
  type ProductAssistantSurfaceDraft,
} from "./assistantSurface";

describe("product assistant surface context", () => {
  it("builds an aggregate-only label from allowlisted product draft facts", () => {
    const label = buildProductAssistantSurfaceLabel({
      mode: "edit",
      name: "Green Tea",
      description: "<p>Bright &amp; crisp <strong>tea</strong>.</p>",
    });

    expect(label).toContain("Edit product");
    expect(label).toContain("safe fields: name, description");
    expect(label).toContain("name: populated");
    expect(label).toContain("description: populated");
    expect(label).toContain("actions: focus, draft, save");
    expect(label).not.toContain("Green Tea");
    expect(label).not.toContain("Bright & crisp tea");
    expect(label).not.toContain("<strong>");
  });

  it("keeps labels bounded and omits sensitive-looking field values", () => {
    const label = buildProductAssistantSurfaceLabel({
      mode: "create",
      name: `alice@example.com sk_secret_123456 ${"tea ".repeat(200)}`,
      description: `<p>Call +8801712345678 before launch. ${"copy ".repeat(200)}</p>`,
      price: "999",
      sku: "SKU-SECRET-1",
      barcode: "1234567890123",
      stock: "42",
    } as ProductAssistantSurfaceDraft & Record<string, unknown>);

    expect(label).toContain("Create product");
    expect(label.length).toBeLessThanOrEqual(160);
    expect(label).not.toContain("alice@example.com");
    expect(label).not.toContain("sk_secret_123456");
    expect(label).not.toContain("+8801712345678");
    expect(label).not.toContain("999");
    expect(label).not.toContain("SKU-SECRET-1");
    expect(label).not.toContain("1234567890123");
    expect(label).not.toContain("42");
  });

  it("does not expose route, discovery, or commerce-sensitive fields in label snapshots", () => {
    const label = buildProductAssistantSurfaceLabel({
      mode: "edit",
      name: "Tea",
      description: "Simple public description",
      isActive: false,
      slug: "tea",
      canonicalPath: "https://evil.example/products/tea?token=chk_secret",
      noIndex: true,
      excludeFromSitemap: true,
      excludeFromProductFeed: true,
      price: "999",
      sku: "SKU-SECRET-1",
      stock: "42",
      images: ["https://cdn.example/image.jpg"],
    } as ProductAssistantSurfaceDraft & Record<string, unknown>);

    expect(label).not.toContain("/products/tea");
    expect(label).not.toContain("evil.example");
    expect(label).not.toContain("chk_secret");
    expect(label).not.toContain("noindex");
    expect(label).not.toContain("sitemap");
    expect(label).not.toContain("product feed");
    expect(label).not.toContain("999");
    expect(label).not.toContain("SKU-SECRET-1");
    expect(label).not.toContain("42");
    expect(label).not.toContain("cdn.example");
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

  it("advertises only name and description as safe registered fields", () => {
    expect(PRODUCT_ASSISTANT_SAFE_FIELDS).toEqual(["name", "description"]);
    expect(PRODUCT_ASSISTANT_SURFACE_CAPABILITIES).toEqual({
      actions: [
        "focus_surface",
        "apply_field_draft",
        "save_registered_form",
      ],
      safeFields: ["name", "description"],
    });
  });

  it("builds stable browser action registrations for a visible product form", () => {
    expect(getProductAssistantActionId("product-edit-form", "apply_field_draft")).toBe(
      "product-edit-form:apply_field_draft",
    );
    expect(createProductAssistantSurfaceActions("product-edit-form")).toEqual([
      {
        id: "product-edit-form:focus_surface",
        type: "focus_surface",
        label: "Focus product field",
        safeFields: ["name", "description"],
      },
      {
        id: "product-edit-form:apply_field_draft",
        type: "apply_field_draft",
        label: "Apply product draft",
        safeFields: ["name", "description"],
      },
      {
        id: "product-edit-form:save_registered_form",
        type: "save_registered_form",
        label: "Save product form",
      },
    ]);
  });

  it("focuses and drafts only allowlisted fields", async () => {
    const focused: string[] = [];
    const drafts: Array<{ field: string; value: string }> = [];
    const handlers = createProductAssistantActionHandlers({
      focusField: (field) => {
        focused.push(field);
        return true;
      },
      applyFieldDraft: (field, value) => {
        drafts.push({ field, value });
      },
      saveForm: () => true,
    });

    await expect(
      handlers.focus_surface({ focus: { field: "description" } }),
    ).resolves.toEqual({
      ok: true,
      action: "focus_surface",
      field: "description",
    });
    await expect(
      handlers.apply_field_draft({ field: "name", value: "Fresh tea" }),
    ).resolves.toEqual({
      ok: true,
      action: "apply_field_draft",
      field: "name",
    });
    await expect(
      handlers.apply_field_draft({
        field: "description",
        value: "<p>Longer product copy.</p>",
      }),
    ).resolves.toEqual({
      ok: true,
      action: "apply_field_draft",
      field: "description",
    });

    expect(focused).toEqual(["description"]);
    expect(drafts).toEqual([
      { field: "name", value: "Fresh tea" },
      { field: "description", value: "<p>Longer product copy.</p>" },
    ]);
  });

  it("rejects unsupported or unsafe assistant field actions", async () => {
    const touched: string[] = [];
    const handlers = createProductAssistantActionHandlers({
      focusField: (field) => {
        touched.push(field);
        return true;
      },
      applyFieldDraft: (field) => {
        touched.push(field);
      },
      saveForm: () => true,
    });

    await expect(
      handlers.focus_surface({ field: "price" }),
    ).resolves.toMatchObject({
      ok: false,
      action: "focus_surface",
      reason: "unsupported_field",
    });
    await expect(
      handlers.apply_field_draft({ field: "sku", value: "SKU-1" }),
    ).resolves.toMatchObject({
      ok: false,
      action: "apply_field_draft",
      reason: "unsupported_field",
    });
    await expect(
      handlers.apply_field_draft({ field: "description", value: 42 }),
    ).resolves.toMatchObject({
      ok: false,
      action: "apply_field_draft",
      reason: "invalid_value",
      field: "description",
    });

    expect(touched).toEqual([]);
  });

  it("refuses registered save while submitting or invalid", async () => {
    const saveAttempts: string[] = [];
    const submittingHandlers = createProductAssistantActionHandlers({
      focusField: () => true,
      applyFieldDraft: () => undefined,
      saveForm: () => {
        saveAttempts.push("submitting");
        return true;
      },
      isSubmitting: () => true,
    });
    const invalidHandlers = createProductAssistantActionHandlers({
      focusField: () => true,
      applyFieldDraft: () => undefined,
      saveForm: () => {
        saveAttempts.push("invalid");
        return true;
      },
      validateForm: () => false,
    });

    await expect(
      submittingHandlers.save_registered_form(),
    ).resolves.toMatchObject({
      ok: false,
      action: "save_registered_form",
      reason: "already_submitting",
    });
    await expect(invalidHandlers.save_registered_form()).resolves.toMatchObject(
      {
        ok: false,
        action: "save_registered_form",
        reason: "validation_errors",
      },
    );

    expect(saveAttempts).toEqual([]);
  });
});
