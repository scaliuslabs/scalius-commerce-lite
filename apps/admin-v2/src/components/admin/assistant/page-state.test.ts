// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ADMIN_ASSISTANT_PAGE_STATE_EVENT,
  createAdminAssistantPageStateSnapshot,
  publishAdminAssistantPageState,
  registerAdminAssistantSurface,
  resetAdminAssistantPageStateForTest,
  sanitizeAdminAssistantText,
  subscribeAdminAssistantSurfaceRegistry,
  type AdminAssistantPageStateSnapshot,
} from "./page-state";

function createScrollElement(metrics: {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
}) {
  return metrics as HTMLElement;
}

describe("admin assistant page state", () => {
  beforeEach(() => {
    resetAdminAssistantPageStateForTest();
  });

  afterEach(() => {
    resetAdminAssistantPageStateForTest();
    vi.restoreAllMocks();
  });

  it("redacts sensitive text before it reaches the page snapshot", () => {
    const text = sanitizeAdminAssistantText(
      "Customer alice@example.com called +8801712345678 with Bearer abc.def.ghi and chk_receiptProof",
    );

    expect(text).toContain("[redacted-email]");
    expect(text).toContain("[redacted-phone]");
    expect(text).toContain("Bearer [redacted-token]");
    expect(text).toContain("[redacted-token]");
    expect(text).not.toContain("alice@example.com");
    expect(text).not.toContain("+8801712345678");
    expect(text).not.toContain("chk_receiptProof");
  });

  it("creates bounded JSON-serializable snapshots with visible registered surfaces only", () => {
    registerAdminAssistantSurface({
      id: "hidden-payment-form",
      kind: "form",
      label: "Payment alice@example.com",
      visible: false,
    });

    for (let index = 0; index < 25; index += 1) {
      registerAdminAssistantSurface({
        id: `orders-table-${index}`,
        kind: "table",
        label:
          index === 0
            ? "Orders for buyer@example.com +8801712345678"
            : `Orders ${index}`,
        rowCount: 1_000_000,
        selectedCount: -5,
        validationErrorCount: Number.POSITIVE_INFINITY,
      });
    }

    const snapshot = createAdminAssistantPageStateSnapshot({
      routePath: "/admin/orders?receiptToken=chk_shouldNotLeak",
      pageTitle: "Orders buyer@example.com",
      pageHeading: "Phone +8801712345678",
      scrollElement: createScrollElement({
        clientHeight: 600,
        scrollHeight: 2_600,
        scrollTop: 2_200,
      }),
    });

    expect(snapshot).toMatchObject({
      version: 1,
      routePath: "/admin/orders",
      pageTitle: "Orders [redacted-email]",
      pageHeading: "Phone [redacted-phone]",
      mainScroll: {
        top: 2_000,
        maxTop: 2_000,
        viewportHeight: 600,
        contentHeight: 2_600,
        atBottom: true,
      },
    });
    expect(snapshot.surfaces).toHaveLength(20);
    expect(snapshot.surfaces[0]).toMatchObject({
      id: "orders-table-0",
      kind: "table",
      label: "Orders for [redacted-email] [redacted-phone]",
      rowCount: 10_000,
      selectedCount: 0,
    });
    expect(snapshot.surfaces[0]).not.toHaveProperty("validationErrorCount");
    expect(JSON.stringify(snapshot)).not.toContain("buyer@example.com");
    expect(JSON.stringify(snapshot)).not.toContain("+8801712345678");
    expect(JSON.stringify(snapshot)).not.toContain("chk_shouldNotLeak");
  });

  it("notifies registry subscribers on register, update, and unregister", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAdminAssistantSurfaceRegistry(listener);

    const handle = registerAdminAssistantSurface({
      id: "product-form",
      kind: "form",
      label: "Product form",
    });
    handle.update({ dirty: true });
    handle.unregister();
    unsubscribe();
    registerAdminAssistantSurface({
      id: "orders-table",
      kind: "table",
      label: "Orders",
    });

    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("publishes snapshots through the browser global and custom event", () => {
    const snapshot: AdminAssistantPageStateSnapshot = {
      version: 1,
      routePath: "/admin/products",
      pageTitle: "Products",
      pageHeading: "Products",
      mainScroll: {
        top: 0,
        maxTop: 0,
        viewportHeight: 0,
        contentHeight: 0,
        atTop: true,
        atBottom: true,
      },
      surfaces: [],
    };
    const listener = vi.fn((event: Event) => {
      expect((event as CustomEvent<AdminAssistantPageStateSnapshot>).detail).toEqual(
        snapshot,
      );
    });

    window.addEventListener(ADMIN_ASSISTANT_PAGE_STATE_EVENT, listener);
    publishAdminAssistantPageState(snapshot);

    expect(window.__SCALIUS_ADMIN_ASSISTANT_PAGE_STATE__).toEqual(snapshot);
    expect(listener).toHaveBeenCalledTimes(1);

    window.removeEventListener(ADMIN_ASSISTANT_PAGE_STATE_EVENT, listener);
  });
});
