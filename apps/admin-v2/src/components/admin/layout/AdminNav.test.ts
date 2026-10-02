import { describe, expect, it } from "vitest";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { canAccessAdminPath } from "~/lib/admin-access";
import { activeNavChild, isSectionActive, visibleNav } from "./AdminNav";

const viewer = (...permissions: string[]) => (to: string) =>
  canAccessAdminPath(to, { isSuperAdmin: false, hasAdminAccess: true, permissions: new Set(permissions) });

describe("admin sidebar", () => {
  it("shows exactly the pages the page-permission map would open", () => {
    const nav = visibleNav(viewer(PERMISSIONS.CATEGORIES_VIEW, PERMISSIONS.PAGES_VIEW));

    expect(nav.map((item) => item.key)).toEqual(["products", "content"]);
    // Without products.view the section opens its first reachable page.
    expect(nav[0]).toMatchObject({ to: "/admin/categories" });
    expect(nav[0]!.children.map((child) => child.key)).toEqual(["categories", "brands"]);
    expect(nav[1]!.children.map((child) => child.key)).toEqual(["pages", "blogPosts"]);
  });

  it("lists Reviews under Products", () => {
    const [products] = visibleNav(viewer(PERMISSIONS.PRODUCTS_VIEW, PERMISSIONS.REVIEWS_VIEW, PERMISSIONS.GIFT_CARDS_VIEW));

    expect(products!.children.find((child) => child.key === "reviews")).toMatchObject({ to: "/admin/reviews", badge: "reviews" });
  });

  it("shows Gift cards under Products only to staff who can view gift cards", () => {
    const [withGiftCards] = visibleNav(viewer(PERMISSIONS.PRODUCTS_VIEW, PERMISSIONS.GIFT_CARDS_VIEW));
    const [withoutGiftCards] = visibleNav(viewer(PERMISSIONS.PRODUCTS_VIEW));

    expect(withGiftCards!.children.map((child) => child.key)).toContain("giftCards");
    expect(withoutGiftCards!.children.map((child) => child.key)).not.toContain("giftCards");
  });

  it("lists Segments under Customers and keeps Customers open on a segment", () => {
    const [customers] = visibleNav(viewer(PERMISSIONS.CUSTOMERS_VIEW));

    expect(customers).toMatchObject({ key: "customers", to: "/admin/customers" });
    expect(customers!.children).toEqual([{ key: "segments", to: "/admin/customers/segments" }]);
    expect(isSectionActive("/admin/customers/segments/seg_abc", customers!)).toBe(true);
  });

  it("keeps a section active on its sub-pages and detail routes", () => {
    const [products] = visibleNav(viewer(PERMISSIONS.PRODUCTS_VIEW, PERMISSIONS.COLLECTIONS_VIEW));

    expect(isSectionActive("/admin/products/p1/edit", products!)).toBe(true);
    expect(isSectionActive("/admin/collections/c1/edit", products!)).toBe(true);
    expect(isSectionActive("/admin/customers", products!)).toBe(false);
  });

  it("lists Purchase orders and Transfers after Inventory, and marks the most specific page current", () => {
    const [products] = visibleNav(viewer(PERMISSIONS.PRODUCTS_VIEW));
    const keys = products!.children.map((child) => child.key);

    expect(keys.slice(keys.indexOf("inventory"), keys.indexOf("inventory") + 3)).toEqual(["inventory", "purchaseOrders", "transfers"]);
    expect(activeNavChild("/admin/inventory/purchase-orders/po_1/receive", products!.children)?.key).toBe("purchaseOrders");
    expect(activeNavChild("/admin/inventory/transfers", products!.children)?.key).toBe("transfers");
    expect(activeNavChild("/admin/inventory", products!.children)?.key).toBe("inventory");
    expect(activeNavChild("/admin/inventory/labels", products!.children)?.key).toBe("inventory");
  });

  it("opens purchasing to viewers and its writes to editors", () => {
    const view = viewer(PERMISSIONS.PRODUCTS_VIEW);
    const edit = viewer(PERMISSIONS.PRODUCTS_VIEW, PERMISSIONS.PRODUCTS_EDIT);

    for (const path of ["/admin/inventory/purchase-orders", "/admin/inventory/purchase-orders/po_1", "/admin/inventory/transfers", "/admin/inventory/transfers/tr_1", "/admin/inventory/suppliers"]) {
      expect(view(path)).toBe(true);
    }
    for (const path of ["/admin/inventory/purchase-orders/new", "/admin/inventory/purchase-orders/po_1/receive", "/admin/inventory/transfers/new", "/admin/inventory/transfers/tr_1/receive"]) {
      expect(view(path)).toBe(false);
      expect(edit(path)).toBe(true);
    }
    expect(viewer(PERMISSIONS.ORDERS_VIEW)("/admin/inventory/purchase-orders")).toBe(false);
  });
});
