// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CHECKOUT_TRANSFER_UNAVAILABLE_MESSAGE,
  clearCheckoutFormDraft,
  clearCheckoutAttemptSession,
  clearHostedPaymentRecoverySession,
  clearCheckoutSession,
  clearCheckoutTransferSession,
  discardCheckoutFormDraftOfOtherOwner,
  fingerprintCheckoutCart,
  hashCheckoutCartFingerprint,
  matchesCheckoutRecoveryCart,
  matchesCheckoutRecoverySession,
  readCheckoutFormDraft,
  readCheckoutPaymentSelection,
  readHostedPaymentRecoverySession,
  reconcileCheckoutAfterSignIn,
  setCheckoutFormDraftOwner,
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
    setCheckoutFormDraftOwner("guest");
  });

  it("clears private checkout state on a verified account switch even after the old draft was discarded", () => {
    setCheckoutFormDraftOwner("cust_a");
    writeCheckoutFormDraft({ customerName: "Previous buyer", shippingAddress: "Previous address" });
    // Existing checkouts have no owner marker yet: preserve the draft's identity before clearing it.
    sessionStorage.setItem("checkoutId", "attempt_a");
    sessionStorage.setItem("scalius_checkout_data", '{"customerName":"Previous buyer"}');
    sessionStorage.setItem("scalius_submitted_cart", "submitted lines");
    sessionStorage.setItem("scalius_last_order", "order_a");
    const cart = '{"items":{"line_a":{"quantity":2}}}';
    localStorage.setItem("cart:v3", cart);
    writeHostedPaymentRecoverySession("/order-success?orderId=order_a&payment=stripe");
    expect(discardCheckoutFormDraftOfOtherOwner("guest")).toBe(true);
    expect(readCheckoutFormDraft()).toBeNull();

    expect(reconcileCheckoutAfterSignIn("cust_b")).toBe(true);

    for (const key of [...checkoutTransferKeys, "checkoutId", "scalius_submitted_cart", "scalius_last_order"]) {
      expect(sessionStorage.getItem(key)).toBeNull();
    }
    expect(readHostedPaymentRecoverySession()).toBeNull();
    expect(localStorage.getItem("cart:v3")).toBe(cart);
    expect(sessionStorage.getItem("scalius_checkout_owner")).toBe("cust_b");
  });

  it.each(["cust_a", "guest", null])("preserves an uncertain checkout when signing in from %s", (previousOwner) => {
    if (previousOwner) setCheckoutFormDraftOwner(previousOwner);
    sessionStorage.setItem("checkoutId", "uncertain_attempt");
    if (previousOwner) writeCheckoutFormDraft({ customerName: "Buyer" });
    const transfer = { customerName: "Buyer", cartItems: "{}" };
    writeCheckoutTransferSession(transfer, "[]");
    if (!previousOwner) sessionStorage.removeItem("scalius_checkout_owner");
    writeHostedPaymentRecoverySession("/order-success?orderId=order_a&payment=stripe");

    expect(reconcileCheckoutAfterSignIn("cust_a")).toBe(false);
    expect(sessionStorage.getItem("checkoutId")).toBe("uncertain_attempt");
    expect(JSON.parse(sessionStorage.getItem("scalius_checkout_data")!)).toEqual(transfer);
    expect(readHostedPaymentRecoverySession()?.orderId).toBe("order_a");
  });

  it("binds a transferred checkout to its account even when its form draft is gone", () => {
    setCheckoutFormDraftOwner("cust_a");
    writeCheckoutTransferSession({ customerName: "Previous buyer", cartItems: "{}" }, "[]");
    clearCheckoutFormDraft();
    expect(reconcileCheckoutAfterSignIn("cust_b")).toBe(true);
    expect(sessionStorage.getItem("scalius_checkout_data")).toBeNull();
  });

  it("clears cart-to-checkout transfer state without rotating the active checkout id", () => {
    const keys = [
      ...checkoutTransferKeys,
      "checkoutId",
    ];

    for (const key of keys) {
      sessionStorage.setItem(key, `${key}-value`);
    }

    clearCheckoutTransferSession();

    for (const key of checkoutTransferKeys) {
      expect(sessionStorage.getItem(key)).toBeNull();
    }
    expect(sessionStorage.getItem("checkoutId")).toBe("checkoutId-value");
  });

  it("removes checkout transfer state and the active checkout id", () => {
    const keys = [
      ...checkoutTransferKeys,
      "checkoutId",
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
    writeCheckoutPaymentSelection("stripe");
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
    expect(readCheckoutPaymentSelection()).toBe("stripe");
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

  it("hashes the canonical cart identity without exposing product or variant ids", async () => {
    const cartItems = {
      line_b: { id: "product_b", variantId: "variant_b", quantity: 2 },
      line_a: { id: "product_a", variantId: "variant_a", quantity: 1 },
    };
    const reordered = {
      line_a: cartItems.line_a,
      line_b: cartItems.line_b,
    };

    const first = await hashCheckoutCartFingerprint(cartItems);
    const second = await hashCheckoutCartFingerprint(reordered);

    expect(first).toMatch(/^cartfp_[A-Za-z0-9_-]{43}$/);
    expect(second).toBe(first);
    expect(first).not.toContain("product_a");
    expect(await hashCheckoutCartFingerprint({})).toBeNull();
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

  it("recovers an app wallet's payment from its URL-encoded qualified id", () => {
    const href = `/order-success?${new URLSearchParams({ orderId: "order_1", payment: "scalius.bangladesh:bkash" })}`;
    expect(href).toBe("/order-success?orderId=order_1&payment=scalius.bangladesh%3Abkash");
    expect(writeHostedPaymentRecoverySession(href, { cartItems: "{}" })).toBe(true);
    expect(readHostedPaymentRecoverySession()).toMatchObject({ href, gateway: "scalius.bangladesh:bkash", orderId: "order_1" });
    clearHostedPaymentRecoverySession();
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
      "/order-success?orderId=order_1&payment=stripe",
      undefined,
      "stripe",
    )).toBe(true);

    const recovery = readHostedPaymentRecoverySession();
    expect(recovery).toMatchObject({
      orderId: "order_1",
      gateway: "stripe",
      checkoutId: "checkout_1",
    });
    expect(recovery?.cartFingerprint).toBe(fingerprintCheckoutCart(checkoutData.cartItems));
  });

  it("expires stale hosted payment receipt recovery URLs", () => {
    const createdAt = Date.now() - (7 * 24 * 60 * 60 * 1000 + 1);
    localStorage.setItem(
      "scalius_hosted_payment_recovery",
      JSON.stringify({
        href: "/order-success?orderId=order_1&payment=sslcommerz",
        gateway: "sslcommerz",
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
