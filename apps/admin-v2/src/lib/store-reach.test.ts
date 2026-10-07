/**
 * The sidebar lists Price lists and Translate & adapt only once the store
 * uses them; every other page, and the section a lone advanced page belongs
 * to, stays.
 */
import { describe, expect, it } from "vitest";
import { Tag, FileText } from "lucide-react";
import type { VisibleNavItem } from "~/components/admin/layout/AdminNav";
import { withoutUnusedPages } from "./store-reach";

const nav: VisibleNavItem[] = [
  {
    key: "products", to: "/admin/products", icon: Tag,
    children: [
      { key: "collections", to: "/admin/collections" },
      { key: "priceLists", to: "/admin/price-lists" },
    ],
  },
  {
    key: "content", to: "/admin/pages", icon: FileText,
    children: [
      { key: "pages", to: "/admin/pages" },
      { key: "translations", to: "/admin/translations" },
    ],
  },
];

const keys = (items: VisibleNavItem[], section: string) => items.find((item) => item.key === section)!.children.map((child) => child.key);

describe("sidebar pages by use", () => {
  it("hides Price lists and Translate & adapt until the store uses them", () => {
    const hidden = withoutUnusedPages(nav, { priceLists: false, translations: false });
    expect(keys(hidden, "products")).toEqual(["collections"]);
    expect(keys(hidden, "content")).toEqual(["pages"]);
  });

  it("shows each one as soon as its use is known", () => {
    expect(keys(withoutUnusedPages(nav, { priceLists: true, translations: false }), "products")).toEqual(["collections", "priceLists"]);
    expect(keys(withoutUnusedPages(nav, { priceLists: false, translations: true }), "content")).toEqual(["pages", "translations"]);
  });

  it("keeps a section whose only page is an unused one", () => {
    const lone: VisibleNavItem[] = [{ key: "content", to: "/admin/translations", icon: FileText, children: [{ key: "translations", to: "/admin/translations" }] }];
    expect(withoutUnusedPages(lone, { priceLists: false, translations: false })).toEqual(lone);
  });
});
