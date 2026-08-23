// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CHECKOUT_TRANSFER_UNAVAILABLE_MESSAGE,
  clearHostedPaymentRecoverySession,
  clearCheckoutSession,
  clearCheckoutTransferSession,
  fingerprintCheckoutCart,
  matchesCheckoutRecoveryCart,
  readHostedPaymentRecoverySession,
  writeHostedPaymentRecoverySession,
  writeCheckoutTransferSession,
} from "./session-state";

const checkoutTransferKeys = [
  "scalius_checkout_data",
  "scalius_checkout_gateways",
] as const;

const legacyAnalyticsKeys = [
  "scalius_user_phone",
  "scalius_user_email",
  "scalius_user_name",
  "scalius_user_city",
] as const;

const browserSessionStorage = window.sessionStorage;
const browserLocalStorage = window.localStorage;

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

  it("writes cart-to-checkout transfer state only when storage persists both keys", () => {
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
