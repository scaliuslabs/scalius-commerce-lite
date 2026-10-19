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
const schema = parsed.manifest.storefront.skins.find((skin) => skin.id === "noor-header")!.settings;
const menu = (count: number): StorefrontMenuItem[] => Array.from({ length: count }, (_, index) => ({
  title: `Category ${index}`, url: `/categories/root-${index}`,
  children: [{ title: `Group ${index}`, url: `/categories/group-${index}`, children: [{ title: `Leaf ${index}`, url: `/categories/leaf-${index}`, children: [] }] }],
}));
const urls = (items: StorefrontMenuItem[]): string[] => items.flatMap((item) => [item.url, ...urls(item.children)]);

function render(items: StorefrontMenuItem[], layout: "center" | "start", language: "en" | "bn" = "en", style = "mega") {
  const settings = resolveStorefrontSettings(schema, { layout, menu_style: style }, { image: () => null, products: () => [] });
  const context = fixtureContext();
  context.store.language = language;
  const html = storefrontShown(renderHeader(storefront, "noor-header", settings, { menu: items }, { context }), "scalius.noor");
  expect(html.dropped).toBe(0);
  const template = document.createElement("template");
  template.innerHTML = html.html;
  return template.content;
}

describe("Noor bounded desktop navigation", () => {
  for (const layout of ["center", "start"] as const) {
    it.each([0, 1, 4, 6, 7, 50])(`${layout} layout keeps the first roots and a native route to the rest (%i roots)`, (count) => {
      const items = menu(count);
      const limit = layout === "center" ? 6 : 4;
      const fragment = render(items, layout);
      const links = [...fragment.querySelectorAll<HTMLAnchorElement>(".noor-nav-list > li > a")];
      expect(links.map((link) => link.getAttribute("href"))).toEqual(items.slice(0, limit).map((item) => item.url));
      expect(Boolean(fragment.querySelector(".noor-nav"))).toBe(count > 0);
      const more = fragment.querySelector<HTMLButtonElement>(".noor-nav-more");
      expect(Boolean(more)).toBe(count > limit);
      if (more) {
        expect(more.getAttribute("type")).toBe("button");
        expect(more.getAttribute("popovertarget")).toBe("noor-drawer");
        expect(fragment.querySelector("#noor-drawer")?.getAttribute("popover")).toBe("auto");
      }
      expect([...fragment.querySelectorAll(".noor-drawer-list a")].map((link) => link.getAttribute("href"))).toEqual(urls(items));
      expect(fragment.querySelectorAll(".noor-drawer-list details")).toHaveLength(count * 2);
    });
  }

  it.each(["mega", "simple"])("keeps nested desktop links reachable with %s menus", (style) => {
    const items = menu(50);
    const fragment = render(items, "center", "en", style);
    const desktopUrls = [...fragment.querySelectorAll(".noor-nav-list a")].map((link) => link.getAttribute("href"));
    for (const url of urls(items.slice(0, 6))) expect(desktopUrls).toContain(url);
    expect(desktopUrls).not.toContain(items[6]!.url);
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
