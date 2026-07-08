// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createAdminAssistantPageStateSnapshot,
  resetAdminAssistantPageStateForTest,
} from "./page-state";
import {
  registerAdminAssistantDialogSurface,
} from "./dialog-surface";

describe("admin assistant dialog surface", () => {
  beforeEach(() => {
    resetAdminAssistantPageStateForTest();
  });

  afterEach(() => {
    resetAdminAssistantPageStateForTest();
    vi.restoreAllMocks();
  });

  it("registers only open dialog state without assistant action metadata", () => {
    registerAdminAssistantDialogSurface({
      id: "product-delete-dialog",
      label: "Delete product for buyer@example.com +8801712345678 chk_secretToken123456",
      open: true,
      submitting: false,
    });
    registerAdminAssistantDialogSurface({
      id: "closed-dialog",
      label: "Closed dialog",
      open: false,
    });

    const snapshot = createAdminAssistantPageStateSnapshot({
      routePath: "/admin/products",
      pageTitle: "Products",
      pageHeading: "Products",
    });

    expect(snapshot.surfaces).toEqual([
      {
        id: "product-delete-dialog",
        kind: "dialog",
        label:
          "Delete product for [redacted-email] [redacted-phone] [redacted-token]",
        open: true,
        submitting: false,
      },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("buyer@example.com");
    expect(JSON.stringify(snapshot)).not.toContain("+8801712345678");
    expect(JSON.stringify(snapshot)).not.toContain("chk_secretToken123456");
    expect(JSON.stringify(snapshot)).not.toContain("confirm");
    expect(snapshot.surfaces[0]?.assistantActions).toBeUndefined();
  });

  it("updates and unregisters the dialog surface through the handle", () => {
    const handle = registerAdminAssistantDialogSurface({
      id: "product-delete-dialog",
      label: "Product delete confirmation dialog",
      open: true,
      submitting: false,
    });

    handle.update({
      id: "product-delete-dialog",
      label: "Product delete confirmation dialog",
      open: true,
      submitting: true,
    });

    expect(
      createAdminAssistantPageStateSnapshot({ routePath: "/admin/products" })
        .surfaces[0],
    ).toMatchObject({
      id: "product-delete-dialog",
      kind: "dialog",
      open: true,
      submitting: true,
    });

    handle.unregister();
    expect(
      createAdminAssistantPageStateSnapshot({ routePath: "/admin/products" })
        .surfaces,
    ).toEqual([]);
  });
});
