// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CHECKOUT_TRANSFER_UNAVAILABLE_MESSAGE,
  clearCheckoutFormDraft,
  clearCheckoutAttemptSession,
  clearHostedPaymentRecoverySession,
  clearCheckoutSession,
  clearCheckoutTransferSession,
  fingerprintCheckoutCart,
  matchesCheckoutRecoveryCart,
  matchesCheckoutRecoverySession,
  readCheckoutFormDraft,
  readCheckoutPaymentSelection,
  readHostedPaymentRecoverySession,
  writeHostedPaymentRecoverySession,
  writeCheckoutFormDraft,
  writeCheckoutPaymentSelection,
  writeCheckoutTransferSession,
} from "./session-state";

const checkoutTransferKeys = [
  "scalius_checkout_data",
  "scalius_checkout_gateways",
  "scalius_checkout_payment_method",
] as const;

const legacyAnalyticsKeys = [
  "scalius_user_phone",
  "scalius_user_email",
  "scalius_user_name",
  "scalius_user_city",
] as const;

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: vi.fn(() => store.clear()),
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    key: vi.fn((index: number) => Array.from(store.keys())[index] ?? null),
    removeItem: vi.fn((key: string) => {
      store.delete(key);
    }),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, String(value));
    }),
  };
}

const browserSessionStorage = createMemoryStorage();
const browserLocalStorage = createMemoryStorage();

function installSessionStorage(storage: Storage): void {
  Object.defineProperty(globalThis, "sessionStorage", {
    value: storage,
    configurable: true,
  });
  Object.defineProperty(window, "sessionStorage", {
    value: storage,
    configurable: true,
  });
}

function installLocalStorage(storage: Storage): void {
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
  });
  Object.defineProperty(window, "localStorage", {
    value: storage,
    configurable: true,
  });
}

describe("checkout session state", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    installSessionStorage(browserSessionStorage);
    installLocalStorage(browserLocalStorage);
    sessionStorage.clear();
    localStorage.clear();
  });

  it("clears cart-to-checkout transfer state without rotating the active checkout id", () => {
    const keys = [
      ...checkoutTransferKeys,
      "checkoutId",
      ...legacyAnalyticsKeys,
    ];

    for (const key of keys) {
      sessionStorage.setItem(key, `${key}-value`);
    }

    clearCheckoutTransferSession();

    for (const key of [...checkoutTransferKeys, ...legacyAnalyticsKeys]) {
      expect(sessionStorage.getItem(key)).toBeNull();
    }
    expect(sessionStorage.getItem("checkoutId")).toBe("checkoutId-value");
  });

  it("removes checkout transfer state, active checkout id, and legacy analytics PII keys", () => {
    const keys = [
      ...checkoutTransferKeys,
      "checkoutId",
      ...legacyAnalyticsKeys,
    ];

    for (const key of keys) {
      sessionStorage.setItem(key, `${key}-value`);
    }

    clearCheckoutSession();

    for (const key of keys) {
      expect(sessionStorage.getItem(key)).toBeNull();
    }
  });

  it("can end a terminal checkout while preserving the buyer form draft", () => {
    writeCheckoutFormDraft({
      customerName: "Buyer",
      customerPhone: "+8801712345678",
    });
    sessionStorage.setItem("checkoutId", "checkout_terminal");
    sessionStorage.setItem("scalius_checkout_data", "{}");

    clearCheckoutAttemptSession({ preserveFormDraft: true });

    expect(sessionStorage.getItem("checkoutId")).toBeNull();
    expect(sessionStorage.getItem("scalius_checkout_data")).toBeNull();
    expect(readCheckoutFormDraft()?.customerName).toBe("Buyer");
  });

  it("writes cart-to-checkout transfer state only when storage persists both keys", () => {
    writeCheckoutPaymentSelection("polar");
    const result = writeCheckoutTransferSession(
      {
        customerName: "Buyer",
        cartItems: "{}",
      },
      '[{"id":"cod"}]',
    );

    expect(result).toEqual({ ok: true });
    expect(sessionStorage.getItem("scalius_checkout_data")).toContain("Buyer");
    expect(sessionStorage.getItem("scalius_checkout_gateways")).toBe('[{"id":"cod"}]');
    expect(readCheckoutPaymentSelection()).toBe("polar");
  });

  it("keeps only bounded checkout form fields for Back and Forward navigation", () => {
    writeCheckoutFormDraft({
      customerName: "Buyer",
      customerPhone: "+8801712345678",
      shippingAddress: "Rajshahi",
      city: "city_1",
      zone: "zone_1",
      shippingLocation: "delivery_2",
      notes: "Call on arrival",
      unknownField: "ignored",
    } as never);

    expect(readCheckoutFormDraft()).toEqual({
      customerName: "Buyer",
      customerPhone: "+8801712345678",
      shippingAddress: "Rajshahi",
      city: "city_1",
      zone: "zone_1",
      shippingLocation: "delivery_2",
      notes: "Call on arrival",
    });

    clearCheckoutTransferSession();
    expect(readCheckoutFormDraft()?.customerName).toBe("Buyer");
    clearCheckoutFormDraft();
    expect(readCheckoutFormDraft()).toBeNull();
  });

  it("persists explicit empty buyer fields instead of reviving older draft values", () => {
    writeCheckoutFormDraft({
      customerName: "Old buyer",
      customerPhone: "+8801712345678",
      shippingAddress: "Old address",
    });
    writeCheckoutFormDraft({
      customerName: "",
      customerPhone: "+8801812345678",
      shippingAddress: "",
    });

    expect(readCheckoutFormDraft()).toMatchObject({
      customerName: "",
      customerPhone: "+8801812345678",
      shippingAddress: "",
    });
  });

  it("expires malformed or old checkout form drafts", () => {
    sessionStorage.setItem(
      "scalius_checkout_form_draft",
      JSON.stringify({
        version: 1,
        updatedAt: Date.now() - 25 * 60 * 60 * 1000,
        values: { customerName: "Old buyer" },
      }),
    );
    expect(readCheckoutFormDraft()).toBeNull();

    sessionStorage.setItem("scalius_checkout_form_draft", "{bad-json");
    expect(readCheckoutFormDraft()).toBeNull();
  });

  it("persists only safe payment method identifiers", () => {
    writeCheckoutPaymentSelection("sslcommerz");
    expect(readCheckoutPaymentSelection()).toBe("sslcommerz");

    writeCheckoutPaymentSelection("unsafe method/value");
    expect(readCheckoutPaymentSelection()).toBe("sslcommerz");

    clearCheckoutTransferSession();
    expect(readCheckoutPaymentSelection()).toBeNull();
  });

  it("matches hosted recovery to the original checkout before clearing current state", () => {
    const cartItems = {
      line_1: { id: "product_1", variantId: "variant_1", quantity: 1 },
    };
    const recovery = {
      href: "/order-success?orderId=order_1&payment=stripe",
      gateway: "stripe" as const,
      orderId: "order_1",
      checkoutId: "checkout_original",
      cartFingerprint: fingerprintCheckoutCart(cartItems),
      createdAt: Date.now(),
    };

    sessionStorage.setItem("checkoutId", "checkout_original");
    expect(matchesCheckoutRecoverySession(recovery, cartItems)).toBe(true);

    sessionStorage.setItem("checkoutId", "checkout_new");
    expect(matchesCheckoutRecoverySession(recovery, cartItems)).toBe(false);
  });

  it("fails closed and clears partial transfer state when required checkout data storage is blocked", () => {
    const storage = createMemoryStorage();
    const originalSetItem = storage.setItem.bind(storage);
    storage.setItem = vi.fn((key, value) => {
      if (key === "scalius_checkout_data") {
        throw new Error("QuotaExceededError");
      }
      originalSetItem(key, value);
    });
    installSessionStorage(storage);

    const result = writeCheckoutTransferSession(
      {
        customerName: "Buyer",
        cartItems: "{}",
      },
      '[{"id":"cod"}]',
    );

    expect(result).toEqual({
      ok: false,
      message: CHECKOUT_TRANSFER_UNAVAILABLE_MESSAGE,
    });
    expect(sessionStorage.getItem("scalius_checkout_data")).toBeNull();
    expect(sessionStorage.getItem("scalius_checkout_gateways")).toBeNull();
  });

  it("fails closed when required checkout data cannot be read back", () => {
    const storage = createMemoryStorage();
    const originalGetItem = storage.getItem.bind(storage);
    storage.getItem = vi.fn((key) => {
      if (key === "scalius_checkout_data") return "stale";
      return originalGetItem(key);
    });
    installSessionStorage(storage);

    const result = writeCheckoutTransferSession(
      {
        customerName: "Buyer",
        cartItems: "{}",
      },
      '[{"id":"cod"}]',
    );

    expect(result).toEqual({
      ok: false,
      message: CHECKOUT_TRANSFER_UNAVAILABLE_MESSAGE,
    });
  });

  it("keeps the required checkout data when the optional gateway snapshot cannot be stored", () => {
    const storage = createMemoryStorage();
    const originalSetItem = storage.setItem.bind(storage);
    storage.setItem = vi.fn((key, value) => {
      if (key === "scalius_checkout_gateways") {
        throw new Error("QuotaExceededError");
      }
      originalSetItem(key, value);
    });
    installSessionStorage(storage);

    const result = writeCheckoutTransferSession(
      {
        customerName: "Buyer",
        cartItems: "{}",
      },
      '[{"id":"cod"}]',
    );

    expect(result).toEqual({ ok: true });
    expect(sessionStorage.getItem("scalius_checkout_data")).toContain("Buyer");
    expect(sessionStorage.getItem("scalius_checkout_gateways")).toBeNull();
  });

  it("stores a seven-day, non-secret same-browser recovery pointer with the cart identity", () => {
    const checkoutData = {
      checkoutId: "chk_session_1",
      cartItems: JSON.stringify({
        "line:1": { id: "product_1", variantId: "variant_1", quantity: 2 },
      }),
    };
    expect(
      writeHostedPaymentRecoverySession(
        "/order-success?orderId=order_1&payment=sslcommerz",
        checkoutData,
      ),
    ).toBe(true);
    expect(readHostedPaymentRecoverySession()).toMatchObject({
      href: "/order-success?orderId=order_1&payment=sslcommerz",
      gateway: "sslcommerz",
      orderId: "order_1",
      checkoutId: "chk_session_1",
      cartFingerprint: fingerprintCheckoutCart(checkoutData.cartItems),
    });
    expect(localStorage.getItem("scalius_hosted_payment_recovery")).toContain("order_1");
    expect(localStorage.getItem("scalius_hosted_payment_recovery")).not.toContain("receiptToken");
    expect(localStorage.getItem("scalius_hosted_payment_recovery")).not.toContain("customerPhone");
    expect(sessionStorage.getItem("scalius_hosted_payment_recovery")).toBeNull();
    expect(matchesCheckoutRecoveryCart(
      readHostedPaymentRecoverySession(),
      {
        "line:1": { id: "product_1", variantId: "variant_1", quantity: 2 },
      },
    )).toBe(true);
    expect(matchesCheckoutRecoveryCart(
      readHostedPaymentRecoverySession(),
      {
        "line:1": { id: "product_1", variantId: "variant_1", quantity: 3 },
      },
    )).toBe(false);

    clearHostedPaymentRecoverySession();
    expect(writeHostedPaymentRecoverySession("https://evil.test/order-success?orderId=order_1&payment=sslcommerz")).toBe(false);
    expect(writeHostedPaymentRecoverySession("/order-success?payment=sslcommerz")).toBe(false);
    expect(writeHostedPaymentRecoverySession("/order-success?orderId=order_1&payment=stripe")).toBe(true);
    clearHostedPaymentRecoverySession();
    for (const legacyProofParam of [["to", "ken"], ["receipt", "_", "token"], ["receipt", "Token"]]) {
      const url = new URL("/order-success?orderId=order_1&payment=sslcommerz", window.location.origin);
      url.searchParams.set(legacyProofParam.join(""), "receipt_1");
      expect(writeHostedPaymentRecoverySession(`${url.pathname}${url.search}`)).toBe(false);
    }
    expect(readHostedPaymentRecoverySession()).toBeNull();
  });

  it("preserves the original cart identity when receipt recovery changes gateway", () => {
    const checkoutData = {
      checkoutRequestId: "checkout_1",
      cartItems: {
        line_1: { id: "product_1", variantId: "variant_1", quantity: 2 },
      },
    };
    expect(writeHostedPaymentRecoverySession(
      "/order-success?orderId=order_1&payment=sslcommerz",
      checkoutData,
      "sslcommerz",
    )).toBe(true);

    expect(writeHostedPaymentRecoverySession(
      "/order-success?orderId=order_1&payment=polar",
      undefined,
      "polar",
    )).toBe(true);

    const recovery = readHostedPaymentRecoverySession();
    expect(recovery).toMatchObject({
      orderId: "order_1",
      gateway: "polar",
      checkoutId: "checkout_1",
    });
    expect(recovery?.cartFingerprint).toBe(fingerprintCheckoutCart(checkoutData.cartItems));
  });

  it("expires stale hosted payment receipt recovery URLs", () => {
    const createdAt = Date.now() - (7 * 24 * 60 * 60 * 1000 + 1);
    localStorage.setItem(
      "scalius_hosted_payment_recovery",
      JSON.stringify({
        href: "/order-success?orderId=order_1&payment=polar",
        gateway: "polar",
        orderId: "order_1",
        checkoutId: null,
        cartFingerprint: null,
        createdAt,
      }),
    );

    expect(readHostedPaymentRecoverySession(Date.now())).toBeNull();
    expect(localStorage.getItem("scalius_hosted_payment_recovery")).toBeNull();
  });
});
