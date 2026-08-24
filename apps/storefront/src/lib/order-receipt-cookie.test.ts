import { describe, expect, it } from "vitest";

import {
  clearOrderReceiptFinalizeCookieHeader,
  createOrderReceiptFinalizeCookieHeader,
  createOrderReceiptCookieHeader,
  getOrderReceiptFinalizeCookieName,
  getOrderReceiptCookieName,
  hasOrderReceiptFinalizeCookie,
  readOrderReceiptFinalizeCookie,
  readOrderReceiptCookie,
} from "./order-receipt-cookie";

describe("order receipt cookie", () => {
  it("creates a host-only HttpOnly receipt cookie scoped to the order", () => {
    const cookieName = getOrderReceiptCookieName("order_1");
    const header = createOrderReceiptCookieHeader("order_1", "chk_secret");

    expect(header).toContain(`${cookieName}=chk_secret`);
    expect(header).toContain("Max-Age=604800");
    expect(header).toContain("Path=/");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Lax");
    expect(header).not.toContain("Domain=");
    expect(readOrderReceiptCookie(`other=value; ${cookieName}=chk_secret`, "order_1")).toBe("chk_secret");
    expect(readOrderReceiptCookie(`${cookieName}=chk_secret`, "order_2")).toBe("");
  });

  it("creates and consumes a short-lived order-specific finalization marker", () => {
    const cookieName = getOrderReceiptFinalizeCookieName("order_1");
    const header = createOrderReceiptFinalizeCookieHeader("order_1");
    const clearHeader = clearOrderReceiptFinalizeCookieHeader("order_1");

    expect(header).toContain(`${cookieName}=1`);
    expect(header).toContain("Max-Age=600");
    expect(header).toContain("Path=/order-success");
    expect(header).toContain("HttpOnly");
    expect(header).not.toContain("Domain=");
    expect(hasOrderReceiptFinalizeCookie(`other=value; ${cookieName}=1`, "order_1")).toBe(true);
    expect(hasOrderReceiptFinalizeCookie(`${cookieName}=1`, "order_2")).toBe(false);
    expect(clearHeader).toContain(`${cookieName}=`);
    expect(clearHeader).toContain("Max-Age=0");
  });

  it("binds a direct checkout finalization marker to the checkout and cart snapshot", () => {
    const cookieName = getOrderReceiptFinalizeCookieName("order_1");
    const header = createOrderReceiptFinalizeCookieHeader("order_1", {
      checkoutId: "chk_session_checkout_1",
      cartFingerprintHash: `cartfp_${"a".repeat(43)}`,
    });

    expect(header).toContain(
      `${cookieName}=v1.chk_session_checkout_1.cartfp_${"a".repeat(43)}`,
    );
    expect(readOrderReceiptFinalizeCookie(header, "order_1")).toEqual({
      checkoutId: "chk_session_checkout_1",
      cartFingerprintHash: `cartfp_${"a".repeat(43)}`,
    });
    expect(readOrderReceiptFinalizeCookie(`${cookieName}=malformed`, "order_1"))
      .toBeNull();
  });
});
