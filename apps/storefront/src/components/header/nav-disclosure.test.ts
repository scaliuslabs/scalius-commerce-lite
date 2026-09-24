// @vitest-environment happy-dom

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildNavMoreEntries, cloneCompactMenus, fitNavOverflow, installNavDisclosure } from "./nav-disclosure";
import { ariaCurrent, navigationCurrent, navigationPathname } from "./navigation-state";

const button = (id: string) => document.querySelector<HTMLButtonElement>(`[aria-controls="${id}"]`)!;
const panel = (id: string) => document.getElementById(id)!;

function pointer(type: string, target: Element, relatedTarget: Element | null = null) {
  const event = new MouseEvent(type, { bubbles: true, relatedTarget });
  Object.defineProperty(event, "pointerType", { value: "mouse" });
  target.dispatchEvent(event);
}

beforeAll(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {} }));
  installNavDisclosure(document);
});

beforeEach(() => {
  document.body.innerHTML = `
    <ul>
      <li data-disclosure-item>
        <a href="/women">Women</a>
        <button type="button" aria-expanded="false" aria-controls="p-women" data-disclosure="popup">Women submenu</button>
        <div id="p-women" hidden><a href="/sarees">Sarees</a></div>
      </li>
      <li data-disclosure-item>
        <button type="button" aria-expanded="false" aria-controls="p-men" data-disclosure="popup">Men</button>
        <div id="p-men" hidden><a href="/panjabi">Panjabi</a></div>
      </li>
    </ul>
    <button type="button" aria-expanded="true" aria-controls="t-kids" data-disclosure="tree">Kids</button>
    <div id="t-kids"><a href="/toys">Toys</a></div>
    <a id="outside" href="/sale">Sale</a>`;
});

afterEach(() => vi.useRealTimers());

describe("nav disclosures", () => {
  it("toggles tree levels independently", () => {
    button("t-kids").click();
    expect(button("t-kids").getAttribute("aria-expanded")).toBe("false");
    expect(panel("t-kids").hidden).toBe(true);
    button("p-women").click();
    button("t-kids").click();
    expect(panel("t-kids").hidden).toBe(false);
    expect(panel("p-women").hidden).toBe(false);
  });

  it("keeps one popup open, closes on Escape and returns focus", () => {
    button("p-women").click();
    expect(panel("p-women").hidden).toBe(false);
    button("p-men").click();
    expect(panel("p-women").hidden).toBe(true);
    expect(button("p-women").getAttribute("aria-expanded")).toBe("false");
    expect(panel("p-men").hidden).toBe(false);

    panel("p-men").querySelector("a")!.focus();
    document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(panel("p-men").hidden).toBe(true);
    expect(document.activeElement).toBe(button("p-men"));
  });

  it("closes on a press outside and when focus leaves the item", () => {
    button("p-women").click();
    document.getElementById("outside")!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(panel("p-women").hidden).toBe(true);

    button("p-women").click();
    const link = panel("p-women").querySelector("a")!;
    link.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: document.getElementById("outside") }));
    expect(panel("p-women").hidden).toBe(true);
  });

  it("opens on mouse hover intent; a click then keeps it open", () => {
    vi.useFakeTimers();
    const item = button("p-women").closest("li")!;
    pointer("pointerover", item);
    expect(panel("p-women").hidden).toBe(true);
    vi.advanceTimersByTime(100);
    expect(panel("p-women").hidden).toBe(false);

    button("p-women").click();
    expect(panel("p-women").hidden).toBe(false);
    pointer("pointerout", item, document.getElementById("outside"));
    vi.advanceTimersByTime(300);
    expect(panel("p-women").hidden).toBe(false);

    button("p-women").click();
    pointer("pointerover", item);
    vi.advanceTimersByTime(100);
    pointer("pointerout", item, document.getElementById("outside"));
    vi.advanceTimersByTime(300);
    expect(panel("p-women").hidden).toBe(true);
  });
});

describe("menu overflow", () => {
  it("moves the items that don't fit into More", () => {
    document.body.innerHTML = `
      <ul data-nav-overflow>
        ${[0, 1, 2, 3].map((index) => `<li data-nav-index="${index}">Item ${index}</li>`).join("")}
        <li data-nav-more hidden>
          <ul>${[0, 1, 2, 3].map((index) => `<li data-nav-more-index="${index}" hidden>Item ${index}</li>`).join("")}</ul>
        </li>
      </ul>`;
    const list = document.querySelector<HTMLElement>("[data-nav-overflow]")!;
    const width = (element: Element, value: number) =>
      Object.defineProperty(element, "offsetWidth", { configurable: true, value });
    Object.defineProperty(list, "clientWidth", { configurable: true, value: 300 });
    list.querySelectorAll(":scope > [data-nav-index]").forEach((item) => width(item, 100));
    width(list.querySelector("[data-nav-more]")!, 80);

    fitNavOverflow(list);
    const shown = (selector: string) =>
      Array.from(list.querySelectorAll<HTMLElement>(selector)).map((element) => !element.hidden);
    expect(shown(":scope > [data-nav-index]")).toEqual([true, true, false, false]);
    expect(shown("[data-nav-more-index]")).toEqual([false, false, true, true]);
    expect(list.querySelector<HTMLElement>("[data-nav-more]")!.hidden).toBe(false);

    Object.defineProperty(list, "clientWidth", { configurable: true, value: 400 });
    fitNavOverflow(list);
    expect(shown(":scope > [data-nav-index]")).toEqual([true, true, true, true]);
    expect(list.querySelector<HTMLElement>("[data-nav-more]")!.hidden).toBe(true);
  });
});

describe("menu row keys", () => {
  const key = (name: string) =>
    document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));

  beforeEach(() => {
    document.body.innerHTML = `
      <nav id="desktop-nav">
        <ul data-nav-overflow>
          <li data-nav-index="0" data-disclosure-item>
            <a class="desktop-nav-link" href="/women">Women</a>
            <button type="button" aria-expanded="false" aria-controls="desktop-nav-panel-0" data-disclosure="popup"><span class="sr-only">Women submenu</span></button>
            <div id="desktop-nav-panel-0" hidden><ul><li><a class="nav-dropdown-link" href="/sarees">Sarees</a></li><li><a class="nav-dropdown-link" href="/kurtis">Kurtis</a></li></ul></div>
          </li>
          <li data-nav-index="1" data-disclosure-item>
            <button type="button" class="desktop-nav-link" aria-expanded="false" aria-controls="desktop-nav-panel-1" data-disclosure="popup">Men</button>
            <div id="desktop-nav-panel-1" hidden><ul><li><a class="nav-dropdown-link" href="/panjabi">Panjabi</a></li></ul></div>
          </li>
          <li data-nav-index="2"><a class="desktop-nav-link" href="/sale">Sale</a></li>
          <li data-nav-more data-disclosure-item hidden>
            <button type="button" class="desktop-nav-link" aria-expanded="false" aria-controls="desktop-nav-more" data-disclosure="popup">More</button>
            <div id="desktop-nav-more" hidden><ul data-nav-more-list></ul></div>
          </li>
        </ul>
        <template data-nav-more-template>
          <li data-nav-more-index="" hidden><ul class="nav-dropdown-list"><li><a class="nav-dropdown-link nav-dropdown-link--parent" href="#">More</a><ul class="nav-dropdown-list nav-dropdown-sublist"><li><a class="nav-dropdown-link" href="#">More</a></li></ul></li></ul></li>
        </template>
      </nav>
      <div data-nav-compact-from="desktop-nav"></div>`;
  });

  it("moves along the row and into an open popup", () => {
    document.querySelector<HTMLElement>('a[href="/women"]')!.focus();
    key("ArrowRight");
    expect(document.activeElement!.textContent).toBe("Men");
    key("ArrowRight");
    expect(document.activeElement!.getAttribute("href")).toBe("/sale");
    key("Home");
    expect(document.activeElement!.getAttribute("href")).toBe("/women");
    key("ArrowDown");
    expect(panel("desktop-nav-panel-0").hidden).toBe(false);
    expect(document.activeElement!.getAttribute("href")).toBe("/sarees");
    key("ArrowDown");
    expect(document.activeElement!.getAttribute("href")).toBe("/kurtis");
    key("ArrowUp");
    key("ArrowUp");
    expect(document.activeElement).toBe(button("desktop-nav-panel-0"));
  });

  it("builds More entries from the row, with the menu's own markup", () => {
    const list = document.querySelector<HTMLElement>("[data-nav-overflow]")!;
    buildNavMoreEntries(list);
    const entries = Array.from(list.querySelectorAll<HTMLElement>("[data-nav-more-index]"));
    expect(entries.map((entry) => entry.dataset.navMoreIndex)).toEqual(["0", "1", "2"]);
    expect(entries[0]!.querySelector(".nav-dropdown-link--parent")!.getAttribute("href")).toBe("/women");
    expect(Array.from(entries[0]!.querySelectorAll(".nav-dropdown-sublist a")).map((link) => link.getAttribute("href"))).toEqual([
      "/sarees",
      "/kurtis",
    ]);
    // A parent without a link is text; a leaf is a plain row.
    expect(entries[1]!.querySelector("span.nav-dropdown-link--parent")!.textContent).toBe("Men");
    expect(entries[2]!.querySelector(".nav-dropdown-sublist")).toBeNull();
    buildNavMoreEntries(list);
    expect(list.querySelectorAll("[data-nav-more-index]")).toHaveLength(3);
  });

  it("copies the row for the condensed header with its own ids", () => {
    button("desktop-nav-panel-0").click();
    cloneCompactMenus(document);
    const copy = document.getElementById("desktop-nav-compact")!;
    expect(copy.parentElement!.hasAttribute("data-nav-compact-from")).toBe(true);
    expect(copy.querySelector('[aria-controls="desktop-nav-compact-panel-0"]')!.getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById("desktop-nav-compact-panel-0")!.hidden).toBe(true);
    const ids = Array.from(document.querySelectorAll("[id]")).map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    cloneCompactMenus(document);
    expect(document.querySelectorAll("#desktop-nav-compact")).toHaveLength(1);
  });
});

describe("navigation state", () => {
  const page = new URL("https://shop.test/categories/silk-sarees/");
  const women = {
    title: "Women",
    href: "/categories/women",
    subMenu: [{ title: "Sarees", href: "https://shop.test/categories/sarees", subMenu: [{ title: "Silk", href: "/categories/silk-sarees?sort=new" }] }],
  };

  it("marks the page and the sections above it", () => {
    expect(navigationCurrent(women.subMenu[0]!.subMenu[0]!, page)).toBe("page");
    expect(navigationCurrent(women, page)).toBe("section");
    expect(ariaCurrent(navigationCurrent(women, page))).toBe("true");
    expect(navigationCurrent({ title: "Sale", href: "/sale" }, page)).toBeNull();
  });

  it("only reads same-origin links", () => {
    expect(navigationPathname("https://other.test/categories/silk-sarees", page)).toBeNull();
    expect(navigationPathname("#top", page)).toBeNull();
    expect(navigationPathname("/", page)).toBe("/");
    expect(navigationPathname(undefined, page)).toBeNull();
  });
});
