import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BadgePercent,
  Bot,
  Boxes,
  CircleDollarSign,
  GalleryHorizontalEnd,
  LibraryBig,
  Megaphone,
  Package,
  Settings,
  ShieldAlert,
  ShoppingBasket,
  ShoppingCart,
} from "lucide-react";
import { describe, expect, it } from "vitest";
import {
  allNavSections,
  MetaCapiNavIcon,
  type NavItem,
  type NavSubItem,
} from "./AdminNav";
import {
  findSettingsNavItem,
  SETTINGS_NAV_ITEMS,
  type SettingsNavRouteItem,
} from "../settings/settings-navigation";
import { ADMIN_PERMISSIONS } from "../../../lib/admin-permissions";

const topLevelItems = allNavSections.flatMap((section) => section.items);
const leafItems = topLevelItems.flatMap((item) => item.subItems ?? [item]);

function topLevelItem(name: string): NavItem {
  const item = topLevelItems.find((candidate) => candidate.name === name);
  if (!item) throw new Error(`Missing top-level navigation item: ${name}`);
  return item;
}

function leafItem(href: string): NavSubItem | NavItem {
  const item = leafItems.find((candidate) => candidate.href === href);
  if (!item) throw new Error(`Missing navigation route: ${href}`);
  return item;
}

/**
 * Settings destinations moved out of the sidebar and into the settings area's
 * own navigation, so their icon/permission contract is asserted against that
 * module instead of against a sidebar sub-item.
 */
function settingsRoute(href: string): SettingsNavRouteItem {
  const item = SETTINGS_NAV_ITEMS.find(
    (candidate): candidate is SettingsNavRouteItem =>
      candidate.kind === "route" && candidate.href === href,
  );
  if (!item) throw new Error(`Missing settings destination: ${href}`);
  return item;
}

describe("AdminNav icon taxonomy", () => {
  it("uses distinct, familiar meanings for navigation groups and critical routes", () => {
    expect(topLevelItem("Catalog").icon).toBe(Boxes);
    expect(topLevelItem("Content").icon).toBe(LibraryBig);
    expect(topLevelItem("Sales").icon).toBe(CircleDollarSign);

    expect(leafItem("/admin/products").icon).toBe(Package);
    expect(leafItem("/admin/abandoned-checkouts").icon).toBe(ShoppingCart);
    expect(leafItem("/admin/abandoned-checkouts").name).toBe("Checkouts");
    expect(leafItem("/admin/discounts").icon).toBe(BadgePercent);
    expect(leafItem("/admin/promotions").icon).toBe(Megaphone);
    expect(leafItem("/admin/discounts").name).toBe("Discounts");
    expect(leafItem("/admin/promotions").name).toBe("Promotions");
  });

  it("does not reuse a visual meaning across leaf routes", () => {
    const icons = leafItems.map((item) => item.icon);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it("keeps one Settings entry and no duplicate settings sub-menu", () => {
    const settings = topLevelItem("Settings");
    expect(settings.href).toBe("/admin/settings");
    expect(settings.icon).toBe(Settings);
    expect(settings.subItems).toBeUndefined();
    // Every operator can reach their own account section, so the entry itself
    // stays ungated exactly as the old "Account" sub-item was.
    expect(settings.requiredPermission).toBeUndefined();
    expect(settings.anyOfPermissions).toBeUndefined();

    const settingsHrefs = leafItems
      .map((item) => item.href)
      .filter((href) => href.startsWith("/admin/settings/"));
    expect(settingsHrefs).toEqual([]);
  });

  it("keeps the settings destinations' icons and permissions in the settings navigation", () => {
    expect(settingsRoute("/admin/settings/hero-sliders").icon).toBe(
      GalleryHorizontalEnd,
    );
    expect(settingsRoute("/admin/settings/checkout").icon).toBe(ShoppingBasket);
    expect(settingsRoute("/admin/settings/agent-access").icon).toBe(Bot);
    expect(
      settingsRoute("/admin/settings/agent-access").requiredPermission,
    ).toBe(ADMIN_PERMISSIONS.AGENT_ACCESS_VIEW);
    expect(settingsRoute("/admin/settings/fraud-checker").icon).toBe(
      ShieldAlert,
    );
    expect(findSettingsNavItem("cache")?.requiredPermission).toBe(
      ADMIN_PERMISSIONS.SETTINGS_CACHE_VIEW,
    );
    expect(findSettingsNavItem("taxes")?.requiredPermission).toBe(
      ADMIN_PERMISSIONS.TAXES_VIEW,
    );
    expect(findSettingsNavItem("notifications")?.requiredPermission).toBe(
      ADMIN_PERMISSIONS.SETTINGS_NOTIFICATIONS_EDIT,
    );
    expect(
      findSettingsNavItem("delivery-providers")?.requiredPermission,
    ).toBe(ADMIN_PERMISSIONS.SETTINGS_DELIVERY_PROVIDERS_VIEW);
  });

  it("uses the official Meta silhouette without breaking sidebar color states", () => {
    expect(settingsRoute("/admin/settings/meta-conversion").icon).toBe(
      MetaCapiNavIcon,
    );

    const markup = renderToStaticMarkup(
      createElement(MetaCapiNavIcon, { className: "size-4" }),
    );

    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain("/provider-marks/meta.svg");
    expect(markup).toContain("background-color:currentColor");
  });
});
