import { describe, expect, it } from "vitest";

import {
  createOrderReceiptCookieHeader,
  getOrderReceiptCookieName,
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
});
