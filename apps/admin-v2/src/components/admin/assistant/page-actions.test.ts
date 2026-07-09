// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createAdminAssistantPageStateSnapshot,
  registerAdminAssistantSurface,
  resetAdminAssistantPageStateForTest,
} from "./page-state";
import {
  executeAdminAssistantPageAction,
  executeAdminAssistantPageActionWithResult,
  registerAdminAssistantPageActionHandler,
  resetAdminAssistantPageActionsForTest,
  type AdminAssistantPageAction,
} from "./page-actions";

describe("admin assistant page actions", () => {
  beforeEach(() => {
    resetAdminAssistantPageStateForTest();
    resetAdminAssistantPageActionsForTest();
  });

  afterEach(() => {
    resetAdminAssistantPageStateForTest();
    resetAdminAssistantPageActionsForTest();
    vi.restoreAllMocks();
  });

  it("redacts and bounds unsafe action ids, fields, labels, and values before dispatch", async () => {
    const received: AdminAssistantPageAction[] = [];
    const longValue = `Draft for buyer@example.com ${"x".repeat(400)} chk_receiptProof`;
    const longFieldName = `privateFieldForBuyeralice@example.com${"x".repeat(120)}`;
    const longActionId = `product-form-save-for-alice@example.com-${"x".repeat(120)}`;

    registerAdminAssistantPageActionHandler(longActionId, (action) => {
      received.push(action);
      return true;
    });

    await expect(
      executeAdminAssistantPageAction({
        id: longActionId,
        type: "apply_field_draft",
        targetId: `product-form-for-+8801712345678-${"x".repeat(120)}`,
        fieldName: longFieldName,
        label: "Buyer alice@example.com +8801712345678",
        value: longValue,
      }),
    ).resolves.toBe(true);

    expect(received).toHaveLength(1);
    const [action] = received;
    expect(action.id.length).toBeLessThanOrEqual(80);
    expect(action.targetId.length).toBeLessThanOrEqual(80);
    expect(action.label).toBe("Buyer [redacted-email] [redacted-phone]");
    expect(JSON.stringify(action)).toContain("[redacted-email]");
    expect(JSON.stringify(action)).toContain("[redacted-phone]");
    expect(JSON.stringify(action)).toContain("[redacted-token]");
    expect(JSON.stringify(action)).not.toContain("alice@example.com");
    expect(JSON.stringify(action)).not.toContain("+8801712345678");
    expect(JSON.stringify(action)).not.toContain("chk_receiptProof");

    if (action.type !== "apply_field_draft") {
      throw new Error("expected apply_field_draft action");
    }

    expect(action.fieldName.length).toBeLessThanOrEqual(80);
    expect(String(action.value).length).toBeLessThanOrEqual(12_000);
  });

  it("executes only registered handlers", async () => {
    const registered = vi.fn(() => true);
    const other = vi.fn(() => true);

    registerAdminAssistantPageActionHandler("product-form-save", registered);
    registerAdminAssistantPageActionHandler("orders-table-select", other);

    await expect(
      executeAdminAssistantPageAction({
        id: "product-form-save",
        type: "save_registered_form",
        targetId: "product-form",
      }),
    ).resolves.toBe(true);

    expect(registered).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
  });

  it("does not execute unregistered handlers", async () => {
    const handler = vi.fn(() => true);
    const handle = registerAdminAssistantPageActionHandler(
      "product-form-save",
      handler,
    );

    handle.unregister();

    await expect(
      executeAdminAssistantPageAction({
        id: "product-form-save",
        type: "save_registered_form",
        targetId: "product-form",
      }),
    ).resolves.toBe(false);

    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects a stale product action after a different product surface registers", async () => {
    const oldHandler = vi.fn(() => true);
    const currentHandler = vi.fn(() => true);
    const oldActionId = "product-edit:prod_one:instance-a:apply_field_draft";
    const oldHandle = registerAdminAssistantPageActionHandler(
      oldActionId,
      oldHandler,
    );

    oldHandle.unregister();
    registerAdminAssistantPageActionHandler(
      "product-edit:prod_two:instance-b:apply_field_draft",
      currentHandler,
    );

    await expect(
      executeAdminAssistantPageActionWithResult(
        {
          id: oldActionId,
          type: "apply_field_draft",
          targetId: "product-edit:prod_one:instance-a",
          fieldName: "description",
          value: "Product one copy",
        },
        { executionKey: "assistant-message-one:apply-product-one-copy" },
      ),
    ).resolves.toEqual({ ok: false, reason: "handler_unavailable" });

    expect(oldHandler).not.toHaveBeenCalled();
    expect(currentHandler).not.toHaveBeenCalled();
  });

  it("consumes one rendered action before awaiting its handler", async () => {
    let resolveHandler: ((accepted: boolean) => void) | undefined;
    const handler = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveHandler = resolve;
        }),
    );
    registerAdminAssistantPageActionHandler("product-form-save", handler);
    const action = {
      id: "product-form-save",
      type: "save_registered_form",
      targetId: "product-form",
    };
    const options = { executionKey: "assistant-message-one:save-product" };

    const firstExecution = executeAdminAssistantPageActionWithResult(
      action,
      options,
    );
    await expect(
      executeAdminAssistantPageActionWithResult(action, options),
    ).resolves.toEqual({ ok: false, reason: "already_consumed" });

    resolveHandler?.(true);
    await expect(firstExecution).resolves.toEqual({
      ok: true,
      reason: "executed",
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("fails closed for unsupported or unsafe actions", async () => {
    const handler = vi.fn(() => true);
    registerAdminAssistantPageActionHandler("product-form-save", handler);

    await expect(
      executeAdminAssistantPageAction({
        id: "product-form-save",
        type: "delete_everything",
        targetId: "product-form",
      }),
    ).resolves.toBe(false);
    await expect(
      executeAdminAssistantPageAction({
        id: "product-form-save",
        type: "apply_field_draft",
        targetId: "product-form",
        fieldName: "   ",
        value: "Published",
      }),
    ).resolves.toBe(false);
    await expect(
      executeAdminAssistantPageAction({
        id: "missing-handler",
        type: "save_registered_form",
        targetId: "product-form",
      }),
    ).resolves.toBe(false);

    expect(handler).not.toHaveBeenCalled();
  });

  it("bounds row selection inputs before registered table handlers run", async () => {
    const handledActions: AdminAssistantPageAction[] = [];
    const rowIds = Array.from({ length: 130 }, (_, index) =>
      index === 0 ? "row-buyer@example.com-chk_receiptProof" : `row-${index}`,
    );

    registerAdminAssistantPageActionHandler("orders-table-select", (action) => {
      handledActions.push(action);
      return true;
    });

    await expect(
      executeAdminAssistantPageAction({
        id: "orders-table-select",
        type: "select_visible_rows",
        targetId: "orders-table",
        rowIds,
      }),
    ).resolves.toBe(true);

    expect(handledActions).toHaveLength(1);
    const [action] = handledActions;
    expect(action.type).toBe("select_visible_rows");
    if (action.type !== "select_visible_rows") {
      throw new Error("expected select_visible_rows action");
    }
    expect(action.rowIds).toHaveLength(100);
    expect(action.rowIds[0]).toContain("[redacted-email]");
    expect(action.rowIds[0]).toContain("[redacted-token]");
    expect(JSON.stringify(action)).not.toContain("buyer@example.com");
    expect(JSON.stringify(action)).not.toContain("chk_receiptProof");
  });

  it("keeps handler internals out of page-state snapshots", () => {
    const internalSecret = "handler-internal-secret";
    registerAdminAssistantPageActionHandler("product-form-save", () => {
      throw new Error(internalSecret);
    });
    registerAdminAssistantSurface({
      id: "product-form",
      kind: "form",
      label: "Product form",
      dirty: true,
    });

    const snapshot = createAdminAssistantPageStateSnapshot({
      routePath: "/admin/products/new",
      pageTitle: "Products",
      pageHeading: "Create product",
      scrollElement: null,
    });

    const serialized = JSON.stringify(snapshot);
    expect(serialized).toContain("product-form");
    expect(serialized).not.toContain("product-form-save");
    expect(serialized).not.toContain(internalSecret);
    expect(serialized).not.toContain("handler");
  });
});
