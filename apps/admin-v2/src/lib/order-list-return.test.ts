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

  it("keeps every list view, filter set and the abandoned tab", () => {
    for (const href of [
      "/admin/orders",
      "/admin/orders?view=unpaid",
      "/admin/orders?view=returned",
      "/admin/orders?view=delivery_failed&page=3",
      "/admin/orders?status=pending&paymentStatus=unpaid&startDate=2026-09-01&endDate=2026-09-24&sort=total",
      "/admin/orders/abandoned",
      "/admin/orders/abandoned?page=2",
    ]) {
      rememberOrderListHref(href);
      expect(orderListReturnHref()).toBe(href);
    }
  });

  it("never keeps an order page, so Back and Previous/Next never point at an order", () => {
    rememberOrderListHref("/admin/orders?view=returned");
    for (const href of [
      "/admin/orders/AGD5658QQXD0S0HA",
      "/admin/orders/AGD5658QQXD0S0HA?tab=timeline",
      "/admin/orders/AGD5658QQXD0S0HA/edit",
      "/admin/orders/new",
      "/admin/orders/abandoned/chk_123",
      "//admin/orders",
    ]) {
      rememberOrderListHref(href);
      expect(orderListReturnHref()).toBe("/admin/orders?view=returned");
    }
  });

  it("rejects an order page already stored by an older build", () => {
    window.sessionStorage.setItem("admin.orders.returnHref", "/admin/orders/AGD5658QQXD0S0HA");
    expect(orderListReturnHref()).toBe("/admin/orders");
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
