import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Boxes,
  CircleDollarSign,
  GalleryHorizontalEnd,
  LibraryBig,
  Package,
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

describe("AdminNav icon taxonomy", () => {
  it("uses distinct, familiar meanings for navigation groups and critical routes", () => {
    expect(topLevelItem("Catalog").icon).toBe(Boxes);
    expect(topLevelItem("Content").icon).toBe(LibraryBig);
    expect(topLevelItem("Sales").icon).toBe(CircleDollarSign);

    expect(leafItem("/admin/products").icon).toBe(Package);
    expect(leafItem("/admin/abandoned-checkouts").icon).toBe(ShoppingCart);
    expect(leafItem("/admin/settings/hero-sliders").icon).toBe(
      GalleryHorizontalEnd,
    );
    expect(leafItem("/admin/settings/checkout").icon).toBe(ShoppingBasket);
    expect(leafItem("/admin/settings/fraud-checker").icon).toBe(ShieldAlert);
  });

  it("does not reuse a visual meaning across leaf routes", () => {
    const icons = leafItems.map((item) => item.icon);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it("uses the official Meta silhouette without breaking sidebar color states", () => {
    expect(leafItem("/admin/settings/meta-conversion").icon).toBe(
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
