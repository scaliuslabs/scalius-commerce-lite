import { describe, expect, it } from "vitest";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { canAccessAdminPath } from "~/lib/admin-access";
import { isSectionActive, visibleNav } from "./AdminNav";

const viewer = (...permissions: string[]) => (to: string) =>
  canAccessAdminPath(to, { isSuperAdmin: false, hasAdminAccess: true, permissions: new Set(permissions) });

describe("admin sidebar", () => {
  it("shows exactly the pages the page-permission map would open", () => {
    const nav = visibleNav(viewer(PERMISSIONS.CATEGORIES_VIEW, PERMISSIONS.PAGES_VIEW));

    expect(nav.map((item) => item.key)).toEqual(["products", "content"]);
    // Without products.view the section opens its first reachable page.
    expect(nav[0]).toMatchObject({ to: "/admin/categories" });
    expect(nav[0]!.children.map((child) => child.key)).toEqual(["categories"]);
    expect(nav[1]!.children.map((child) => child.key)).toEqual(["pages", "blogPosts"]);
  });

  it("keeps Reviews out of the menu until its page ships", () => {
    const [products] = visibleNav(viewer(PERMISSIONS.PRODUCTS_VIEW, PERMISSIONS.REVIEWS_VIEW, PERMISSIONS.GIFT_CARDS_VIEW));

    expect(products!.children.map((child) => child.key)).not.toContain("reviews");
  });

  it("shows Gift cards under Products only to staff who can view gift cards", () => {
    const [withGiftCards] = visibleNav(viewer(PERMISSIONS.PRODUCTS_VIEW, PERMISSIONS.GIFT_CARDS_VIEW));
    const [withoutGiftCards] = visibleNav(viewer(PERMISSIONS.PRODUCTS_VIEW));

    expect(withGiftCards!.children.map((child) => child.key)).toContain("giftCards");
    expect(withoutGiftCards!.children.map((child) => child.key)).not.toContain("giftCards");
  });

  it("keeps a section active on its sub-pages and detail routes", () => {
    const [products] = visibleNav(viewer(PERMISSIONS.PRODUCTS_VIEW, PERMISSIONS.COLLECTIONS_VIEW));

    expect(isSectionActive("/admin/products/p1/edit", products!)).toBe(true);
    expect(isSectionActive("/admin/collections/c1/edit", products!)).toBe(true);
    expect(isSectionActive("/admin/customers", products!)).toBe(false);
  });
});
