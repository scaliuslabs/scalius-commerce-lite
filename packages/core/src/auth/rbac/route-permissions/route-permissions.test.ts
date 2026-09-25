import { describe, expect, it } from "vitest";

import { hasPageAccess } from "../page-permissions";
import { PERMISSIONS } from "../permissions";
import { getRoutePermission, ROUTE_PERMISSION_MAPS } from ".";

/** Whether a signed-in staff member with exactly these permissions may make the call. */
function allowed(permissions: string[], path: string, method: "GET" | "POST" | "PUT" | "DELETE" = "GET") {
  const route = getRoutePermission(path, method);
  if (!route) return false;
  if (route.allowAnyAdmin) return permissions.length > 0;
  if (route.permission) return permissions.includes(route.permission);
  if (route.anyOf) return route.anyOf.some((permission) => permissions.includes(permission));
  return route.allOf?.every((permission) => permissions.includes(permission)) ?? false;
}

describe("route permissions", () => {
  it("maps compact abandoned-checkout summaries to order read authority", () => {
    expect(getRoutePermission(
      "/api/v1/admin/abandoned-checkouts/summaries",
      "GET",
    )).toEqual({ permission: PERMISSIONS.ORDERS_VIEW });
  });

  it("separates content edits from activation and publishing authority", () => {
    expect(getRoutePermission(
      "/api/v1/admin/analytics/analytics_1",
      "PUT",
    )).toEqual({ permission: PERMISSIONS.ANALYTICS_EDIT });
    expect(getRoutePermission(
      "/api/v1/admin/analytics/analytics_1/toggle",
      "POST",
    )).toEqual({ permission: PERMISSIONS.ANALYTICS_TOGGLE });
    expect(getRoutePermission(
      "/api/v1/admin/analytics/analytics_1/source",
      "GET",
    )).toEqual({ permission: PERMISSIONS.ANALYTICS_EDIT });
    expect(getRoutePermission(
      "/api/v1/admin/analytics/analytics_1/restore",
      "POST",
    )).toEqual({ permission: PERMISSIONS.ANALYTICS_EDIT });
    expect(getRoutePermission(
      "/api/v1/admin/analytics/analytics_1/permanent",
      "DELETE",
    )).toEqual({ permission: PERMISSIONS.ANALYTICS_EDIT });

    expect(getRoutePermission(
      "/api/v1/admin/pages/page_1",
      "PUT",
    )).toEqual({ permission: PERMISSIONS.PAGES_EDIT });
    expect(getRoutePermission(
      "/api/v1/admin/pages/bulk-publish",
      "POST",
    )).toEqual({ permission: PERMISSIONS.PAGES_PUBLISH });

    expect(getRoutePermission(
      "/api/v1/admin/discounts/promo_1",
      "PUT",
    )).toEqual({ permission: PERMISSIONS.DISCOUNTS_EDIT });
    expect(getRoutePermission(
      "/api/v1/admin/discounts/promo_1/preview",
      "POST",
    )).toEqual({ permission: PERMISSIONS.DISCOUNTS_VIEW });
    expect(getRoutePermission(
      "/api/v1/admin/discounts/promo_1/activate",
      "POST",
    )).toEqual({ permission: PERMISSIONS.DISCOUNTS_TOGGLE_STATUS });
    expect(getRoutePermission(
      "/api/v1/admin/discounts/promo_1/pause",
      "POST",
    )).toEqual({ permission: PERMISSIONS.DISCOUNTS_TOGGLE_STATUS });
  });

  it("gates the atomic normalized option matrix behind product edit permission", () => {
    expect(getRoutePermission(
      "/api/v1/admin/products/prod_1/options/matrix",
      "PUT",
    )).toEqual({ permission: PERMISSIONS.PRODUCTS_EDIT });
  });

  it("maps bounded product section reads and edits without opening other methods", () => {
    const path = "/api/v1/admin/products/prod_1/sections/media";
    expect(getRoutePermission(path, "GET")).toEqual({
      permission: PERMISSIONS.PRODUCTS_VIEW,
    });
    expect(getRoutePermission(path, "PATCH")).toEqual({
      permission: PERMISSIONS.PRODUCTS_EDIT,
    });
    expect(getRoutePermission(path, "POST")).toBeNull();
    expect(getRoutePermission(path, "DELETE")).toBeNull();
  });

  it("authorizes every normalized navigation command depth", () => {
    const permission = { permission: PERMISSIONS.SETTINGS_HEADER_EDIT };
    expect(getRoutePermission(
      "/api/v1/admin/navigation/menus/menu_1",
      "GET",
    )).toEqual(permission);
    expect(getRoutePermission(
      "/api/v1/admin/navigation/menus/menu_1/items",
      "GET",
    )).toEqual(permission);
    expect(getRoutePermission(
      "/api/v1/admin/navigation/menus/menu_1/items/item_1",
      "PATCH",
    )).toEqual(permission);
    expect(getRoutePermission(
      "/api/v1/admin/navigation/menus/menu_1/items/item_1/move",
      "POST",
    )).toEqual(permission);
  });

  it("authorizes category publication readiness and status endpoints", () => {
    expect(getRoutePermission(
      "/api/v1/admin/categories/cat_1/publish-readiness",
      "GET",
    )).toEqual({ permission: PERMISSIONS.CATEGORIES_VIEW });
    expect(getRoutePermission(
      "/api/v1/admin/categories/cat_1/status",
      "PATCH",
    )).toEqual({ permission: PERMISSIONS.CATEGORIES_EDIT });
  });

  it("authorizes administrator invitation delivery commands", () => {
    expect(getRoutePermission(
      "/api/v1/admin/auth/users/admin_2/resend-setup",
      "POST",
    )).toEqual({ permission: PERMISSIONS.TEAM_MANAGE });
  });

  it("requires read and edit inventory authority to pair a scanner device", () => {
    expect(getRoutePermission(
      "/api/v1/admin/auth/scanner-link",
      "POST",
    )).toEqual({
      allOf: [PERMISSIONS.PRODUCTS_VIEW, PERMISSIONS.PRODUCTS_EDIT],
    });
  });

  it("keeps hosted-payment recovery queue and export read-only", () => {
    expect(getRoutePermission("/api/v1/admin/orders/payment-recovery", "GET"))
      .toEqual({ permission: PERMISSIONS.ORDERS_VIEW });

    expect(getRoutePermission("/api/v1/admin/orders/payment-recovery/export", "GET"))
      .toEqual({ permission: PERMISSIONS.ORDERS_VIEW });
  });

  it("gates manual-order quotes behind order creation permission", () => {
    expect(getRoutePermission("/api/v1/admin/orders/quote", "POST"))
      .toEqual({ permission: PERMISSIONS.ORDERS_CREATE });
  });

  it("gates manual-order amendment preview and confirmation behind order edit permission", () => {
    expect(getRoutePermission(
      "/api/v1/admin/orders/order_1/amendments/preview",
      "POST",
    )).toEqual({ permission: PERMISSIONS.ORDERS_EDIT });
    expect(getRoutePermission(
      "/api/v1/admin/orders/order_1/amendments",
      "POST",
    )).toEqual({ permission: PERMISSIONS.ORDERS_EDIT });
  });

  it("gates buyer payment recovery link issuance behind order edit permission", () => {
    expect(getRoutePermission(
      "/api/v1/admin/orders/order_1/payment-recovery-link",
      "POST",
    )).toEqual({ permission: PERMISSIONS.ORDERS_EDIT });
  });

  it("keeps order notification history read-only and retry mutation gated", () => {
    expect(getRoutePermission("/api/v1/admin/orders/order_1/notifications", "GET"))
      .toEqual({ permission: PERMISSIONS.ORDERS_VIEW });

    expect(
      getRoutePermission(
        "/api/v1/admin/orders/order_1/notifications/outbox_1/retry",
        "POST",
      ),
    ).toEqual({ permission: PERMISSIONS.ORDERS_EDIT });

    expect(
      getRoutePermission(
        "/api/v1/admin/orders/order_1/notifications/outbox_1/resend",
        "POST",
      ),
    ).toEqual({ permission: PERMISSIONS.ORDERS_EDIT });
  });

  it("gates manual refund recovery behind refund permission", () => {
    expect(
      getRoutePermission(
        "/api/v1/admin/orders/order_1/refund-attempts/rfa_1/reconcile",
        "POST",
      ),
    ).toEqual({ permission: PERMISSIONS.ORDERS_REFUND });
  });

  it("allows archival but exposes no normal order hard-delete authority", () => {
    expect(getRoutePermission("/api/v1/admin/orders/archive", "POST"))
      .toEqual({ permission: PERMISSIONS.ORDERS_DELETE });
    expect(getRoutePermission("/api/v1/admin/orders/order_1", "DELETE"))
      .toBeNull();
    expect(getRoutePermission("/api/v1/admin/orders/order_1/permanent", "DELETE"))
      .toBeNull();
  });

  it("gates shipment recovery repair behind shipment management permission", () => {
    expect(
      getRoutePermission(
        "/api/v1/admin/orders/order_1/shipments/shp_1/reconcile",
        "POST",
      ),
    ).toEqual({ permission: PERMISSIONS.ORDERS_MANAGE_SHIPMENTS });
    expect(
      getRoutePermission(
        "/api/v1/admin/orders/order_1/shipments/shp_1/resolve-unknown",
        "POST",
      ),
    ).toEqual({ permission: PERMISSIONS.ORDERS_MANAGE_SHIPMENTS });
    expect(
      getRoutePermission(
        "/api/v1/admin/orders/order_1/shipments/shp_1/resolve-unknown/lookup",
        "POST",
      ),
    ).toEqual({ permission: PERMISSIONS.ORDERS_MANAGE_SHIPMENTS });
  });

  it("gates order support request resolution behind order edit permission", () => {
    expect(
      getRoutePermission(
        "/api/v1/admin/orders/order_1/support-requests/osr_1/status",
        "PUT",
      ),
    ).toEqual({ permission: PERMISSIONS.ORDERS_EDIT });

    expect(
      getRoutePermission(
        "/api/v1/admin/orders/order_1/support-requests/osr_1/status",
        "POST",
      ),
    ).toEqual({ permission: PERMISSIONS.ORDERS_EDIT });
  });

  it("separates item-return reads from lifecycle mutations", () => {
    expect(getRoutePermission("/api/v1/admin/orders/order_1/returns", "GET"))
      .toEqual({ permission: PERMISSIONS.ORDERS_VIEW });
    expect(getRoutePermission("/api/v1/admin/orders/order_1/returns", "POST"))
      .toEqual({ permission: PERMISSIONS.ORDERS_CHANGE_STATUS });
    expect(getRoutePermission(
      "/api/v1/admin/orders/order_1/returns/ret_1/receive",
      "POST",
    )).toEqual({ permission: PERMISSIONS.ORDERS_CHANGE_STATUS });
    expect(getRoutePermission(
      "/api/v1/admin/orders/order_1/returns/ret_1/reconcile",
      "POST",
    )).toEqual({ permission: PERMISSIONS.ORDERS_CHANGE_STATUS });
  });

  it("keeps invoice reads read-only and issuance behind its dedicated permission", () => {
    expect(getRoutePermission("/api/v1/admin/orders/order_1/invoice", "GET"))
      .toEqual({ permission: PERMISSIONS.ORDERS_VIEW });
    expect(getRoutePermission("/api/v1/admin/orders/order_1/invoice", "POST"))
      .toEqual({ permission: PERMISSIONS.ORDERS_ISSUE_INVOICE });
  });

  it("separates tax reads and previews from tax mutations", () => {
    expect(getRoutePermission("/api/v1/admin/taxes", "GET"))
      .toEqual({ permission: PERMISSIONS.TAXES_VIEW });
    expect(getRoutePermission("/api/v1/admin/taxes/preview", "POST"))
      .toEqual({ permission: PERMISSIONS.TAXES_VIEW });
    expect(getRoutePermission("/api/v1/admin/taxes/settings", "PUT"))
      .toEqual({ permission: PERMISSIONS.TAXES_MANAGE });
    expect(getRoutePermission("/api/v1/admin/taxes/classes/taxc_1", "DELETE"))
      .toEqual({ permission: PERMISSIONS.TAXES_MANAGE });
    expect(getRoutePermission("/api/v1/admin/taxes/rates/taxr_1", "PUT"))
      .toEqual({ permission: PERMISSIONS.TAXES_MANAGE });
    expect(getRoutePermission(
      "/api/v1/admin/taxes/classifications/variant/sku_1",
      "PUT",
    )).toEqual({ permission: PERMISSIONS.TAXES_MANAGE });
  });

  it("separates customer request policy reads from mutations", () => {
    expect(getRoutePermission(
      "/api/v1/admin/settings/customer-requests",
      "GET",
    )).toEqual({ permission: PERMISSIONS.SETTINGS_GENERAL_VIEW });
    expect(getRoutePermission(
      "/api/v1/admin/settings/customer-requests",
      "PUT",
    )).toEqual({ permission: PERMISSIONS.SETTINGS_GENERAL_EDIT });
  });

  it("separates homepage presentation reads from mutations", () => {
    expect(getRoutePermission(
      "/api/v1/admin/settings/homepage-presentation",
      "GET",
    )).toEqual({ permission: PERMISSIONS.SETTINGS_GENERAL_VIEW });
    expect(getRoutePermission(
      "/api/v1/admin/settings/homepage-presentation",
      "POST",
    )).toEqual({ permission: PERMISSIONS.SETTINGS_GENERAL_EDIT });
  });

  it("separates checkout flow reads from versioned mutations", () => {
    expect(getRoutePermission(
      "/api/v1/admin/settings/checkout-flow",
      "GET",
    )).toEqual({ permission: PERMISSIONS.SETTINGS_GENERAL_VIEW });
    expect(getRoutePermission(
      "/api/v1/admin/settings/checkout-flow",
      "PUT",
    )).toEqual({ permission: PERMISSIONS.SETTINGS_GENERAL_EDIT });
  });


  it("lets every staff member read the store's display facts but never change them", () => {
    const orderClerk = [PERMISSIONS.ORDERS_VIEW];
    for (const path of [
      "/api/v1/admin/settings/currency",
      "/api/v1/admin/settings/storefront-url",
      "/api/v1/admin/settings/seo",
    ]) {
      expect(allowed(orderClerk, path)).toBe(true);
      expect(allowed(orderClerk, path, "POST")).toBe(false);
      expect(allowed([], path)).toBe(false);
    }
    expect(allowed(orderClerk, "/api/v1/admin/settings/business")).toBe(false);
    expect(allowed(orderClerk, "/api/v1/admin/settings/general")).toBe(false);
  });

  it("opens exactly the reads a view-only product page needs", () => {
    const viewer = [PERMISSIONS.PRODUCTS_VIEW];
    expect(allowed(viewer, "/api/v1/admin/products/prod_1")).toBe(true);
    expect(allowed(viewer, "/api/v1/admin/categories/form-options")).toBe(true);
    expect(allowed(viewer, "/api/v1/admin/attributes")).toBe(true);
    expect(allowed(viewer, "/api/v1/admin/categories")).toBe(false);
    expect(allowed(viewer, "/api/v1/admin/products/prod_1", "PUT")).toBe(false);
    expect(allowed([PERMISSIONS.COLLECTIONS_VIEW], "/api/v1/admin/products/by-ids")).toBe(true);
    expect(allowed([PERMISSIONS.COLLECTIONS_VIEW], "/api/v1/admin/products")).toBe(false);
  });

  it("gives order staff the invoice header and courier list only with the matching permission", () => {
    expect(allowed([PERMISSIONS.ORDERS_ISSUE_INVOICE], "/api/v1/admin/settings/business")).toBe(true);
    expect(allowed([PERMISSIONS.ORDERS_ISSUE_INVOICE], "/api/v1/admin/settings/business", "POST")).toBe(false);
    expect(allowed([PERMISSIONS.ORDERS_MANAGE_SHIPMENTS], "/api/v1/admin/settings/delivery-providers")).toBe(true);
    expect(allowed([PERMISSIONS.ORDERS_MANAGE_SHIPMENTS], "/api/v1/admin/settings/delivery-providers/prov_1")).toBe(false);
    expect(allowed([PERMISSIONS.ORDERS_MANAGE_SHIPMENTS], "/api/v1/admin/settings/delivery-providers", "POST")).toBe(false);
    expect(allowed([PERMISSIONS.ORDERS_VIEW], "/api/v1/admin/settings/delivery-providers")).toBe(false);
  });

  it("lets any signed-in staff member read and save their own keyboard shortcuts", () => {
    expect(getRoutePermission("/api/v1/admin/auth/shortcuts", "GET")).toEqual({ allowAnyAdmin: true });
    expect(getRoutePermission("/api/v1/admin/auth/shortcuts", "PUT")).toEqual({ allowAnyAdmin: true });
    expect(allowed([PERMISSIONS.ORDERS_VIEW], "/api/v1/admin/auth/shortcuts", "PUT")).toBe(true);
    expect(allowed([], "/api/v1/admin/auth/shortcuts", "PUT")).toBe(false);
  });

  it("gates removing staff behind staff management", () => {
    expect(allowed([PERMISSIONS.TEAM_MANAGE], "/api/v1/admin/auth/users/user_2/remove", "POST")).toBe(true);
    expect(allowed([PERMISSIONS.TEAM_VIEW, PERMISSIONS.TEAM_MANAGE_ROLES], "/api/v1/admin/auth/users/user_2/remove", "POST"))
      .toBe(false);
  });

  it("keeps review moderation and gift-card money behind their own permissions", () => {
    expect(allowed([PERMISSIONS.REVIEWS_VIEW], "/api/v1/admin/reviews")).toBe(true);
    expect(allowed([PERMISSIONS.REVIEWS_VIEW], "/api/v1/admin/reviews/moderate", "POST")).toBe(false);
    expect(allowed([PERMISSIONS.REVIEWS_MODERATE], "/api/v1/admin/reviews/moderate", "POST")).toBe(true);
    expect(allowed([PERMISSIONS.REVIEWS_MODERATE], "/api/v1/admin/reviews/rev_1/conversation", "POST")).toBe(false);
    expect(allowed(
      [PERMISSIONS.REVIEWS_MODERATE, PERMISSIONS.CONVERSATIONS_REPLY],
      "/api/v1/admin/reviews/rev_1/conversation",
      "POST",
    )).toBe(true);

    expect(allowed([PERMISSIONS.GIFT_CARDS_VIEW], "/api/v1/admin/gift-cards/gc_1")).toBe(true);
    expect(allowed([PERMISSIONS.GIFT_CARDS_VIEW], "/api/v1/admin/gift-cards", "POST")).toBe(false);
    expect(allowed([PERMISSIONS.ORDERS_EDIT, PERMISSIONS.ORDERS_REFUND], "/api/v1/admin/gift-cards/gc_1/adjust", "POST"))
      .toBe(false);
    expect(allowed([PERMISSIONS.GIFT_CARDS_MANAGE], "/api/v1/admin/gift-cards/gc_1/adjust", "POST")).toBe(true);

    expect(allowed([PERMISSIONS.PRODUCTS_EDIT], "/api/v1/admin/digital-assets/dga_1/uploads/up_1/parts/1", "PUT"))
      .toBe(true);
    expect(allowed([PERMISSIONS.ORDERS_EDIT], "/api/v1/admin/digital-entitlements/de_1/reset", "POST")).toBe(true);
    expect(allowed([PERMISSIONS.ORDERS_EDIT], "/api/v1/admin/orders/ord_1/digital/resend", "POST")).toBe(true);
    expect(allowed([PERMISSIONS.ORDERS_EDIT], "/api/v1/admin/orders/ord_1/warranty-claims", "POST")).toBe(false);
    expect(allowed(
      [PERMISSIONS.ORDERS_EDIT, PERMISSIONS.CONVERSATIONS_REPLY],
      "/api/v1/admin/orders/ord_1/warranty-claims",
      "POST",
    )).toBe(true);
    expect(allowed([PERMISSIONS.PRODUCTS_VIEW], "/api/v1/admin/warranty-policies")).toBe(true);
    expect(allowed([PERMISSIONS.PRODUCTS_VIEW], "/api/v1/admin/warranty-policies", "POST")).toBe(false);
  });

  it("guards only the versioned admin API", () => {
    expect(getRoutePermission("/api/products", "GET")).toBeNull();
    expect(getRoutePermission("/api/settings/seo", "GET")).toBeNull();
  });
});

describe("page permissions", () => {
  const can = (permissions: string[], path: string) => hasPageAccess(new Set(permissions), false, path);

  it("opens catalog and content records read-only for view roles", () => {
    expect(can([PERMISSIONS.PRODUCTS_VIEW], "/admin/products/prod_1/edit")).toBe(true);
    expect(can([PERMISSIONS.CATEGORIES_VIEW], "/admin/categories/cat_1/edit")).toBe(true);
    expect(can([PERMISSIONS.COLLECTIONS_VIEW], "/admin/collections/col_1/edit")).toBe(true);
    expect(can([PERMISSIONS.PAGES_VIEW], "/admin/pages/page_1/edit")).toBe(true);
    expect(can([PERMISSIONS.PAGES_VIEW], "/admin/articles/post_1/edit")).toBe(true);
    expect(can([PERMISSIONS.PAGES_VIEW], "/admin/pages/new")).toBe(false);
    expect(can([PERMISSIONS.CATEGORIES_VIEW], "/admin/products/prod_1/edit")).toBe(false);
  });

  it("opens staff and role pages to the people who can change them", () => {
    expect(can([PERMISSIONS.TEAM_MANAGE_ROLES], "/admin/settings/users/roles/role_1")).toBe(true);
    expect(can([PERMISSIONS.TEAM_MANAGE], "/admin/settings/users/roles/role_1")).toBe(false);
    expect(can([PERMISSIONS.TEAM_MANAGE], "/admin/settings/users/user_2")).toBe(true);
    expect(can([PERMISSIONS.TEAM_VIEW], "/admin/settings/users/user_2")).toBe(false);
    expect(can([PERMISSIONS.SETTINGS_DELIVERY_LOCATIONS_VIEW], "/admin/settings/shipping/areas")).toBe(true);
  });

  it("gates the review, gift-card and warranty-policy pages", () => {
    expect(can([PERMISSIONS.REVIEWS_VIEW], "/admin/reviews")).toBe(true);
    expect(can([PERMISSIONS.PRODUCTS_VIEW], "/admin/reviews")).toBe(false);
    expect(can([PERMISSIONS.GIFT_CARDS_VIEW], "/admin/gift-cards/gc_1")).toBe(true);
    expect(can([PERMISSIONS.ORDERS_VIEW], "/admin/gift-cards")).toBe(false);
    expect(can([PERMISSIONS.PRODUCTS_EDIT], "/admin/settings/warranty-policies")).toBe(true);
  });
});

describe("per-domain route maps", () => {
  const patterns = ROUTE_PERMISSION_MAPS.flatMap((map, index) => Object.keys(map).map((pattern) => ({ pattern, index })));

  it("defines every path pattern in exactly one domain map", () => {
    const counts = new Map<string, number>();
    for (const { pattern } of patterns) counts.set(pattern, (counts.get(pattern) ?? 0) + 1);
    expect([...counts].filter(([, count]) => count > 1).map(([pattern]) => pattern)).toEqual([]);
  });

  it("never needs the map merge order to choose between two domains", () => {
    // Lookups sort by segment count, then wildcard count; only equally specific
    // patterns that can match the same path fall back to key order.
    const segments = (pattern: string) => pattern.split("/");
    const wildcards = (pattern: string) => pattern.split("*").length - 1;
    const overlap = (a: string, b: string) => {
      const x = segments(a);
      const y = segments(b);
      return x.length === y.length && x.every((segment, i) => segment === y[i] || segment === "*" || y[i] === "*");
    };
    const ties: string[] = [];
    for (const a of patterns) {
      for (const b of patterns) {
        if (a.index < b.index && wildcards(a.pattern) === wildcards(b.pattern) && overlap(a.pattern, b.pattern)) {
          ties.push(`${a.pattern} <> ${b.pattern}`);
        }
      }
    }
    expect(ties).toEqual([]);
  });
});
