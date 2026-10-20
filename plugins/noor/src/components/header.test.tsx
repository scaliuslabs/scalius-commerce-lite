// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { parsePluginManifest } from "@scalius/plugin-sdk/manifest";
import { resolveStorefrontSettings } from "@scalius/shared/plugins/storefront-components";
import { fixtureContext, renderHeader, storefrontShown } from "@scalius/plugin-sdk/storefront/testing";
import type { StorefrontMenuItem } from "@scalius/plugin-sdk/storefront";
import { manifest } from "../index";
import storefront from "../storefront";

const parsed = parsePluginManifest(manifest);
if (!parsed.ok) throw new Error("Invalid Noor manifest");
const schema = parsed.manifest.storefront.skins.find((skin) => skin.id === "noor_header")!.settings;
const menu = (count: number): StorefrontMenuItem[] => Array.from({ length: count }, (_, index) => ({
  title: `Category ${index}`, url: `/categories/root-${index}`,
  children: [{ title: `Group ${index}`, url: `/categories/group-${index}`, children: [{ title: `Leaf ${index}`, url: `/categories/leaf-${index}`, children: [] }] }],
}));
const urls = (items: StorefrontMenuItem[]): string[] => items.flatMap((item) => [item.url, ...urls(item.children)]);

function render(items: StorefrontMenuItem[], layout: "center" | "start", language: "en" | "bn" = "en", style = "mega", path = "/") {
  const settings = resolveStorefrontSettings(schema, { layout, menu_style: style }, { image: () => null, products: () => [] });
  const context = fixtureContext({ page: { kind: "listing", path } });
  context.store.language = language;
  const html = storefrontShown(renderHeader(storefront, "noor_header", settings, { menu: items }, { context }), "scalius.noor");
  expect(html.dropped).toBe(0);
  const template = document.createElement("template");
  template.innerHTML = html.html;
  return template.content;
}

describe("Noor bounded desktop navigation", () => {
  for (const layout of ["center", "start"] as const) {
    it.each([0, 1, 4, 6, 7, 50])(`${layout} layout keeps the first roots and a More dropdown of only the rest (%i roots)`, (count) => {
      const items = menu(count);
      const limit = layout === "center" ? 6 : 4;
      const fragment = render(items, layout);
      const links = [...fragment.querySelectorAll<HTMLAnchorElement>(".noor-nav-list > li > a")];
      expect(links.map((link) => link.getAttribute("href"))).toEqual(items.slice(0, limit).map((item) => item.url));
      expect(Boolean(fragment.querySelector(".noor-nav"))).toBe(count > 0);
      const moreItem = fragment.querySelector<HTMLElement>(".noor-nav-list > li[data-nav-more]");
      expect(Boolean(moreItem)).toBe(count > 0);
      if (moreItem) {
        // Shown only with roots past the row (the store's script also shows it for a row that does not fit).
        expect(moreItem.hidden).toBe(count <= limit);
        expect(moreItem.hasAttribute("data-disclosure-item")).toBe(true);
        const more = moreItem.querySelector<HTMLButtonElement>(":scope > button.noor-nav-more")!;
        expect(more.getAttribute("type")).toBe("button");
        // A dropdown on computers, not the phone drawer.
        expect(more.hasAttribute("popovertarget")).toBe(false);
        expect(more.getAttribute("data-disclosure")).toBe("popup");
        expect(more.getAttribute("aria-expanded")).toBe("false");
        const panel = fragment.getElementById(more.getAttribute("aria-controls")!)!;
        expect(panel.hidden).toBe(true);
        expect(moreItem.contains(panel)).toBe(true);
        // Only the rest of the menu, every level of it, each link once.
        expect(panel.querySelector("[data-nav-more-list]")).not.toBeNull();
        expect([...panel.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual(urls(items.slice(limit)));
      }
      expect(fragment.querySelector("#noor-drawer")?.getAttribute("popover")).toBe("auto");
      expect([...fragment.querySelectorAll(".noor-drawer-list a")].map((link) => link.getAttribute("href"))).toEqual(urls(items));
      expect(fragment.querySelectorAll(".noor-drawer-list details")).toHaveLength(count * 2);
    });
  }

  it.each(["mega", "simple"])("keeps every nested desktop link reachable once, in the row or More, with %s menus", (style) => {
    const items = menu(50);
    const fragment = render(items, "center", "en", style);
    // (A mega panel's closing "All" link repeats its own root.)
    const desktopUrls = [...fragment.querySelectorAll(".noor-nav-list a:not(.noor-mega-all)")].map((link) => link.getAttribute("href"));
    expect([...desktopUrls].sort()).toEqual([...urls(items)].sort());
  });

  it.each(["mega", "simple"])("draws a heading-only item as a heading over its links (%s menus)", (style) => {
    const items: StorefrontMenuItem[] = [
      { title: "Something", url: "#", children: [
        { title: "dfghdfhhf", url: "/pages/x", children: [] },
        { title: "Footwear", url: "/categories/footwear", children: [{ title: "Sandals", url: "/categories/sandals", children: [] }] },
      ] },
      ...menu(8),
    ];
    const fragment = render(items, "center", "en", style);
    // No link to "#" anywhere: the heading is a button on the row and plain text in the drawer.
    expect(fragment.querySelectorAll('a[href="#"]')).toHaveLength(0);
    const heading = fragment.querySelector<HTMLButtonElement>(".noor-nav-list > li > button.noor-nav-heading")!;
    expect(heading.getAttribute("type")).toBe("button");
    const desktop = [...heading.parentElement!.querySelectorAll("a")].map((link) => link.getAttribute("href"));
    expect(desktop).toEqual(["/pages/x", "/categories/footwear", "/categories/sandals"]);
    const drawer = fragment.querySelector(".noor-drawer-list > li > details")!;
    expect(drawer.querySelector("summary")?.textContent).toBe("Something");
    expect([...drawer.querySelectorAll("a")].map((link) => link.getAttribute("href")))
      .toEqual(["/pages/x", "/categories/footwear", "/categories/sandals"]);
  });

  it.each(["mega", "simple"])("gives every menu the store's disclosure pattern (%s menus)", (style) => {
    const items: StorefrontMenuItem[] = [{ title: "Heading", url: "#", children: menu(1)[0]!.children }, ...menu(3)];
    const fragment = render(items, "center", "en", style);
    const row = fragment.querySelector<HTMLElement>(".noor-nav-list[data-nav-overflow]")!;
    const buttons = [...row.querySelectorAll<HTMLButtonElement>('[data-nav-index] > button[data-disclosure="popup"]')];
    expect(buttons).toHaveLength(4);
    // More follows the same pattern (hidden here: nothing is past the row).
    expect(row.querySelectorAll('[data-nav-more] > button[data-disclosure="popup"]')).toHaveLength(1);
    for (const button of buttons) {
      expect(button.getAttribute("aria-expanded")).toBe("false");
      const panel = fragment.getElementById(button.getAttribute("aria-controls")!)!;
      expect(panel.hidden).toBe(true);
      expect(panel.id).toMatch(/^noor-/);
      // The button and its panel share their item, which the script answers for.
      expect(button.closest("[data-disclosure-item]")).toBe(panel.closest("[data-disclosure-item]"));
    }
    // The heading is its own button; a linked item keeps its link and gets a labelled toggle.
    expect(buttons[0]!.classList.contains("noor-nav-heading")).toBe(true);
    expect(buttons[1]!.textContent).toContain("Category 0 menu");
    expect([...row.querySelectorAll("[data-nav-index] > [data-nav-link]")].map((control) => control.tagName)).toEqual(["BUTTON", "A", "A", "A"]);
  });

  it("follows the theme's phone navigation: a marked drawer, drilled into one level at a time when asked", () => {
    const settings = resolveStorefrontSettings(schema, { layout: "center" }, { image: () => null, products: () => [] });
    const draw = (phoneNavigation?: { menu: "accordion" | "drill"; tabBar: boolean }) => {
      const template = document.createElement("template");
      template.innerHTML = renderHeader(storefront, "noor_header", settings, { menu: menu(2), ...(phoneNavigation ? { phoneNavigation } : {}) }, { context: fixtureContext() });
      return template.content.querySelector<HTMLElement>("#noor-drawer")!;
    };
    expect(draw().hasAttribute("data-menu-drawer")).toBe(true);
    expect(draw().classList.contains("is-drill")).toBe(false);
    expect(draw({ menu: "drill", tabBar: true }).classList.contains("is-drill")).toBe(true);
    expect(draw({ menu: "accordion", tabBar: true }).classList.contains("is-drill")).toBe(false);
  });

  it.each([
    [true, undefined], [true, { menu: "accordion", tabBar: true }], [true, { menu: "drill", tabBar: false }],
    [false, undefined], [false, { menu: "accordion", tabBar: true }],
  ] as const)("gives phones one search (header search %s, phone navigation %j)", (showSearch, phoneNavigation) => {
    const settings = resolveStorefrontSettings(schema, { layout: "center", show_search: showSearch }, { image: () => null, products: () => [] });
    const template = document.createElement("template");
    template.innerHTML = renderHeader(storefront, "noor_header", settings, { menu: menu(2), ...(phoneNavigation ? { phoneNavigation } : {}) }, { context: fixtureContext() });
    const header = template.content;
    // The header's own search button (with or without the store's tab bar, which has no Search tab), else the drawer's field.
    expect(header.querySelectorAll('.noor-header-end [popovertarget="noor-search"]')).toHaveLength(showSearch ? 1 : 0);
    expect(header.querySelectorAll('#noor-drawer form[role="search"]')).toHaveLength(showSearch ? 0 : 1);
  });

  it.each(["mega", "simple"])("marks the current page and its section in every %s menu, More and the drawer", (style) => {
    const items = menu(8);
    const current = (fragment: DocumentFragment, selector: string) =>
      [...fragment.querySelectorAll(`${selector} [aria-current]`)].map((link) => [link.getAttribute("href"), link.getAttribute("aria-current")]);
    // A leaf: its link is the page; its group and root are the section.
    const leaf = render(items, "center", "en", style, "/categories/leaf-1/");
    expect(current(leaf, ".noor-nav-list > [data-nav-index]")).toEqual([
      ["/categories/root-1", "true"], ["/categories/group-1", "true"], ["/categories/leaf-1", "page"],
    ]);
    // The drawer names a parent in its summary; its "All" link is marked only on its own page.
    expect(current(leaf, ".noor-drawer-list")).toEqual([["/categories/leaf-1", "page"]]);
    // A root: its own link and every "All" link to it are the page.
    const root = render(items, "center", "en", style, "/categories/root-1");
    const rootLinks = current(root, ".noor-nav-list > [data-nav-index]");
    expect(rootLinks[0]).toEqual(["/categories/root-1", "page"]);
    expect(rootLinks.every(([href, value]) => href === "/categories/root-1" && value === "page")).toBe(true);
    expect(current(root, ".noor-drawer-list")).toEqual([["/categories/root-1", "page"]]);
    // A root past the row is marked in More.
    expect(current(render(items, "center", "en", style, "/categories/leaf-7"), "[data-nav-more-list]")).toEqual([
      ["/categories/root-7", "true"], ["/categories/group-7", "true"], ["/categories/leaf-7", "page"],
    ]);
    // Elsewhere nothing is current.
    expect(render(items, "center", "en", style, "/search").querySelectorAll("[aria-current]")).toHaveLength(0);
  });

  it("keeps full long labels and translated More text available before hydration", () => {
    const items = menu(50);
    items[0]!.title = "Collection".repeat(10);
    items[1]!.title = "হাতে বোনা শাড়ির বিশেষ সংগ্রহ ".repeat(4);
    const fragment = render(items, "start", "bn");
    for (const item of items.slice(0, 2)) {
      const link = fragment.querySelector<HTMLAnchorElement>(`.noor-nav-list > li > a[href="${item.url}"]`)!;
      expect(link.title).toBe(item.title);
      expect(link.querySelector("span")?.textContent).toBe(item.title);
    }
    expect(fragment.querySelector(".noor-nav-more")?.textContent).toBe("আরও");
    expect(fragment.querySelector(".noor-nav-more")?.getAttribute("aria-label")).toBe("আরও মেনু আইটেম");
  });
});
