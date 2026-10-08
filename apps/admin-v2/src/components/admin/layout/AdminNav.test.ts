import { describe, expect, it } from "vitest";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { canAccessAdminPath } from "~/lib/admin-access";
import { SETTINGS_ITEM, activeNavChild, isSectionActive, visibleNav } from "./AdminNav";

const viewer = (...permissions: string[]) => (to: string) =>
  canAccessAdminPath(to, { isSuperAdmin: false, hasAdminAccess: true, permissions: new Set(permissions) });

describe("admin sidebar", () => {
  it("shows exactly the pages the page-permission map would open", () => {
    const nav = visibleNav(viewer(PERMISSIONS.CATEGORIES_VIEW, PERMISSIONS.PAGES_VIEW));

    expect(nav.map((item) => item.key)).toEqual(["products", "content"]);
    // Without products.view the section opens its first reachable page.
    expect(nav[0]).toMatchObject({ to: "/admin/categories" });
    expect(nav[0]!.children.map((child) => child.key)).toEqual(["categories", "brands"]);
    // Translations: a page viewer translates the pages they can open (MARKETS-DESIGN D9).
    expect(nav[1]!.children.map((child) => child.key)).toEqual(["pages", "blogPosts", "translations"]);
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

  it("shows a View products role neither purchasing, transfers nor Settings", () => {
    const canOpen = viewer(PERMISSIONS.PRODUCTS_VIEW);
    const [products] = visibleNav(canOpen);
    const keys = products!.children.map((child) => child.key);

    expect(keys).toContain("inventory");
    expect(keys).not.toContain("purchaseOrders");
    expect(keys).not.toContain("transfers");
    // The settings entry is shown exactly when /admin/settings opens.
    expect(canOpen(SETTINGS_ITEM.to)).toBe(false);
    expect(canOpen("/admin/settings/locations")).toBe(false);
  });

  it("lists Purchase orders and Transfers after Inventory, and marks the most specific page current", () => {
    const [products] = visibleNav(viewer(PERMISSIONS.PRODUCTS_VIEW, PERMISSIONS.INVENTORY_VIEW));
    const keys = products!.children.map((child) => child.key);

    expect(keys.slice(keys.indexOf("inventory"), keys.indexOf("inventory") + 3)).toEqual(["inventory", "purchaseOrders", "transfers"]);
    expect(activeNavChild("/admin/inventory/purchase-orders/po_1/receive", products!.children)?.key).toBe("purchaseOrders");
    expect(activeNavChild("/admin/inventory/transfers", products!.children)?.key).toBe("transfers");
    expect(activeNavChild("/admin/inventory", products!.children)?.key).toBe("inventory");
    expect(activeNavChild("/admin/inventory/labels", products!.children)?.key).toBe("inventory");
  });

  it("opens purchasing to inventory viewers and its writes to inventory managers", () => {
    const view = viewer(PERMISSIONS.PRODUCTS_VIEW, PERMISSIONS.INVENTORY_VIEW);
    const manage = viewer(PERMISSIONS.PRODUCTS_VIEW, PERMISSIONS.INVENTORY_VIEW, PERMISSIONS.INVENTORY_MANAGE, PERMISSIONS.PRODUCTS_VIEW_COSTS);

    for (const path of ["/admin/inventory/purchase-orders", "/admin/inventory/purchase-orders/po_1", "/admin/inventory/transfers", "/admin/inventory/transfers/tr_1", "/admin/inventory/suppliers"]) {
      expect(view(path)).toBe(true);
    }
    for (const path of ["/admin/inventory/purchase-orders/new", "/admin/inventory/purchase-orders/po_1/receive", "/admin/inventory/transfers/new", "/admin/inventory/transfers/tr_1/receive"]) {
      expect(view(path)).toBe(false);
      expect(manage(path)).toBe(true);
    }
    // Editing products is not running purchasing.
    expect(viewer(PERMISSIONS.PRODUCTS_VIEW, PERMISSIONS.PRODUCTS_EDIT)("/admin/inventory/purchase-orders/new")).toBe(false);
    expect(viewer(PERMISSIONS.ORDERS_VIEW)("/admin/inventory/purchase-orders")).toBe(false);
  });

  describe("apps' pages", () => {
    const pages = [
      { placement: "products", title: "Most wished", to: "/admin/apps/acme.wish/pages/most-wished" },
      { placement: "apps", title: "Hello", to: "/admin/apps/acme.hello/pages/overview" },
      { placement: "marketing", title: "Campaigns", to: "/admin/apps/acme.mail/pages/campaigns" },
      { placement: "analytics", title: "Reports", to: "/admin/apps/acme.stats/pages/reports" },
      { placement: "orders", title: "Pick lists", to: "/admin/apps/acme.pick/pages/lists" },
    ];

    it("lists each page under the section its placement names, with its own title", () => {
      const nav = visibleNav(viewer(PERMISSIONS.PRODUCTS_VIEW, PERMISSIONS.ORDERS_VIEW, PERMISSIONS.DISCOUNTS_VIEW, PERMISSIONS.APPS_VIEW), pages);
      const children = (key: string) => nav.find((item) => item.key === key)!.children.filter((child) => child.label).map((child) => [child.label, child.to]);

      expect(children("products")).toEqual([["Most wished", "/admin/apps/acme.wish/pages/most-wished"]]);
      expect(children("orders")).toEqual([["Pick lists", "/admin/apps/acme.pick/pages/lists"]]);
      // Marketing pages sit with Discounts; analytics (no section here) with Apps.
      expect(children("discounts")).toEqual([["Campaigns", "/admin/apps/acme.mail/pages/campaigns"]]);
      expect(children("apps")).toEqual([
        ["Hello", "/admin/apps/acme.hello/pages/overview"],
        ["Reports", "/admin/apps/acme.stats/pages/reports"],
      ]);
    });

    it("lists no app page without apps.view", () => {
      const nav = visibleNav(viewer(PERMISSIONS.PRODUCTS_VIEW, PERMISSIONS.ORDERS_VIEW), pages);

      expect(nav.flatMap((item) => item.children).some((child) => child.label)).toBe(false);
      expect(nav.map((item) => item.key)).not.toContain("apps");
    });

    it("marks only the listing section active on an app page", () => {
      const nav = visibleNav(viewer(PERMISSIONS.PRODUCTS_VIEW, PERMISSIONS.APPS_VIEW), pages);
      const products = nav.find((item) => item.key === "products")!;
      const apps = nav.find((item) => item.key === "apps")!;

      expect(isSectionActive("/admin/apps/acme.wish/pages/most-wished", products)).toBe(true);
      expect(isSectionActive("/admin/apps/acme.wish/pages/most-wished", apps)).toBe(false);
      expect(isSectionActive("/admin/apps/acme.hello/pages/overview", apps)).toBe(true);
      expect(isSectionActive("/admin/apps/acme.wish", apps)).toBe(true);
    });
  });
});
