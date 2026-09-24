// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { orderListReturnHref, rememberOrderListHref } from "./order-list-return";

describe("order list Back target", () => {
  afterEach(() => window.sessionStorage.clear());

  it("returns to the plain list until a list was visited", () => {
    expect(orderListReturnHref()).toBe("/admin/orders");
  });

  it("returns to the tab, filters and page the merchant left", () => {
    rememberOrderListHref("/admin/orders?view=returned&page=2&startDate=2026-09-01");
    expect(orderListReturnHref()).toBe("/admin/orders?view=returned&page=2&startDate=2026-09-01");
    rememberOrderListHref("/admin/orders/abandoned");
    expect(orderListReturnHref()).toBe("/admin/orders/abandoned");
  });

  it("never keeps a phone, email, search term or another page", () => {
    rememberOrderListHref("/admin/orders?view=unpaid");
    for (const href of [
      "/admin/orders?search=01712345678",
      "/admin/orders?view=unpaid&q=rahim",
      "/admin/orders?note=%2B880%201712%20345678",
      "/admin/orders?x=rahim@example.com",
      "/admin/products",
      "https://evil.test/admin/orders",
      "/admin/ordersx",
    ]) {
      rememberOrderListHref(href);
      expect(orderListReturnHref()).toBe("/admin/orders?view=unpaid");
    }
  });
});
