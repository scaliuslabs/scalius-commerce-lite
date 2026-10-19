// @vitest-environment happy-dom

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fitNavOverflow, installNavDisclosure, placeCompactMenus } from "./nav-disclosure";
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
  const width = (element: Element, value: number) =>
    Object.defineProperty(element, "offsetWidth", { configurable: true, value });

  function row(extras: string) {
    document.body.innerHTML = `
      <ul data-nav-overflow>
        ${[0, 1, 2, 3].map((index) => `<li data-nav-index="${index}"><a href="/i${index}">Item ${index}</a></li>`).join("")}
        <li data-nav-more hidden><ul data-nav-more-list>${extras}</ul></li>
      </ul>`;
    const list = document.querySelector<HTMLElement>("[data-nav-overflow]")!;
    list.querySelectorAll(":scope > [data-nav-index]").forEach((item) => width(item, 100));
    width(list.querySelector("[data-nav-more]")!, 80);
    return list;
  }
  const inRow = (list: HTMLElement) =>
    Array.from(list.querySelectorAll<HTMLElement>(":scope > [data-nav-index]")).map((item) => item.dataset.navIndex);
  const inMore = (list: HTMLElement) =>
    Array.from(list.querySelectorAll<HTMLElement>("[data-nav-more-list] > li")).map((item) => item.dataset.navIndex ?? item.textContent);

  it("moves the items that don't fit into More, each link once, and back", () => {
    const list = row("");
    Object.defineProperty(list, "clientWidth", { configurable: true, value: 300 });
    fitNavOverflow(list);
    expect(inRow(list)).toEqual(["0", "1"]);
    expect(inMore(list)).toEqual(["2", "3"]);
    expect(list.querySelector<HTMLElement>("[data-nav-more]")!.hidden).toBe(false);
    expect(list.querySelectorAll("a")).toHaveLength(4);

    Object.defineProperty(list, "clientWidth", { configurable: true, value: 400 });
    fitNavOverflow(list);
    expect(inRow(list)).toEqual(["0", "1", "2", "3"]);
    expect(inMore(list)).toEqual([]);
    expect(list.querySelector<HTMLElement>("[data-nav-more]")!.hidden).toBe(true);
  });

  it("keeps More for the server's extras, after the moved items", () => {
    const list = row('<li><a href="/i4">Item 4</a></li><li><a href="/categories">All categories</a></li>');
    Object.defineProperty(list, "clientWidth", { configurable: true, value: 500 });
    fitNavOverflow(list);
    // Everything fits, but the extras still need "More".
    expect(inRow(list)).toEqual(["0", "1", "2", "3"]);
    expect(list.querySelector<HTMLElement>("[data-nav-more]")!.hidden).toBe(false);
    Object.defineProperty(list, "clientWidth", { configurable: true, value: 450 });
    fitNavOverflow(list);
    expect(inRow(list)).toEqual(["0", "1", "2"]);
    expect(inMore(list)).toEqual(["3", "Item 4", "All categories"]);
  });

  it("moves a long category and its nested menu into More without duplicating links", () => {
    document.body.innerHTML = `
      <ul data-nav-overflow>
        <li data-nav-index="0"><a href="/categories/laptop">Laptop</a></li>
        <li data-nav-index="1"><a href="/categories/components"><span class="nav-label">Components and Peripherals for Professional Creators</span></a>
          <details data-menu="popup"><summary>Components submenu</summary><div><a href="/categories/processors">Processors</a></div></details>
        </li>
        <li data-nav-more hidden><details><summary>More</summary><ul data-nav-more-list>
          <li><a href="/categories">All categories</a></li>
        </ul></details></li>
      </ul>`;
    const list = document.querySelector<HTMLElement>("[data-nav-overflow]")!;
    Object.defineProperty(list, "clientWidth", { configurable: true, value: 250 });
    width(list.querySelector('[data-nav-index="0"]')!, 100);
    width(list.querySelector('[data-nav-index="1"]')!, 208);
    width(list.querySelector("[data-nav-more]")!, 80);
    fitNavOverflow(list);

    expect(inRow(list)).toEqual(["0"]);
    expect(inMore(list)[0]).toBe("1");
    expect(list.querySelectorAll('a[href="/categories/components"]')).toHaveLength(1);
    expect(list.querySelector('[data-nav-more-list] a[href="/categories/components"]')!.textContent)
      .toBe("Components and Peripherals for Professional Creators");
    expect(list.querySelector('[data-nav-more-list] details a[href="/categories/processors"]')).not.toBeNull();
  });

  it("moves a visually clipped category into More before fitting later short categories", () => {
    document.body.innerHTML = `
      <nav class="cnav" data-cnav-layout="bar"><ul data-nav-overflow>
        <li data-nav-index="0"><a href="/categories/air-conditioning"><span class="nav-label">Air Conditioner, Air Cooler & Ceiling Fan (Inverter / Non-Inverter)</span></a></li>
        <li data-nav-index="1"><a href="/categories/camera">Camera</a></li>
        <li data-nav-index="2"><a href="/categories/desktop">Desktop PC</a></li>
        <li data-nav-more hidden><details><summary>More</summary><ul data-nav-more-list><li><a href="/categories">All categories</a></li></ul></details></li>
      </ul></nav>`;
    const list = document.querySelector<HTMLElement>("[data-nav-overflow]")!;
    Object.defineProperty(list, "clientWidth", { configurable: true, value: 350 });
    const items = list.querySelectorAll(":scope > [data-nav-index]");
    [208, 100, 100].forEach((value, index) => width(items[index]!, value));
    width(list.querySelector("[data-nav-more]")!, 80);
    const label = list.querySelector(".nav-label")!;
    Object.defineProperty(label, "clientWidth", { configurable: true, value: 208 });
    Object.defineProperty(label, "scrollWidth", { configurable: true, value: 460 });

    fitNavOverflow(list);
    expect(inRow(list)).toEqual(["1", "2"]);
    expect(inMore(list)[0]).toBe("0");
    expect(list.querySelector('[data-nav-more-list] a[href="/categories/air-conditioning"]')!.textContent)
      .toBe("Air Conditioner, Air Cooler & Ceiling Fan (Inverter / Non-Inverter)");
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

  it("answers keys in More for the moved items, never their own popups", () => {
    const list = document.querySelector<HTMLElement>("[data-nav-overflow]")!;
    const more = list.querySelector<HTMLElement>("[data-nav-more]")!;
    more.hidden = false;
    more.querySelector("[data-nav-more-list]")!.append(list.querySelector('[data-nav-index="2"]')!);
    button("desktop-nav-more").click();
    document.querySelector<HTMLElement>('#desktop-nav-more a[href="/sale"]')!.focus();
    key("ArrowDown");
    expect(panel("desktop-nav-more").hidden).toBe(false);
    key("Escape");
    expect(panel("desktop-nav-more").hidden).toBe(true);
    expect(document.activeElement).toBe(button("desktop-nav-more"));
  });

  it("walks a moved parent's own links in More, which lists them in place", () => {
    const list = document.querySelector<HTMLElement>("[data-nav-overflow]")!;
    const more = list.querySelector<HTMLElement>("[data-nav-more]")!;
    more.hidden = false;
    const moreList = more.querySelector("[data-nav-more-list]")!;
    moreList.append(list.querySelector('[data-nav-index="0"]')!, list.querySelector('[data-nav-index="1"]')!);
    button("desktop-nav-more").focus();
    key("ArrowDown");
    expect(document.activeElement!.getAttribute("href")).toBe("/women");
    key("ArrowDown");
    expect(document.activeElement!.getAttribute("href")).toBe("/sarees");
    key("ArrowDown");
    expect(document.activeElement!.getAttribute("href")).toBe("/kurtis");
    key("ArrowDown");
    // "Men" has no link of its own: its links follow.
    expect(document.activeElement!.getAttribute("href")).toBe("/panjabi");
  });

  it("runs an app header's row by its data-nav-link controls", () => {
    document.body.innerHTML = `
      <ul class="noor-nav-list" data-nav-overflow>
        <li data-nav-index="0" data-disclosure-item>
          <button type="button" class="noor-nav-link" data-nav-link data-disclosure="popup" aria-expanded="false" aria-controls="noor-nav-panel-0">Heading</button>
          <div id="noor-nav-panel-0" hidden><ul><li><a href="/x">X</a></li></ul></div>
        </li>
        <li data-nav-index="1" data-disclosure-item>
          <a class="noor-nav-link" data-nav-link href="/shoes">Shoes</a>
          <button type="button" class="noor-nav-toggle" data-disclosure="popup" aria-expanded="false" aria-controls="noor-nav-panel-1">Shoes menu</button>
          <div id="noor-nav-panel-1" hidden><ul><li><a href="/sandals">Sandals</a></li></ul></div>
        </li>
      </ul>`;
    button("noor-nav-panel-0").focus();
    key("ArrowRight");
    expect(document.activeElement!.getAttribute("href")).toBe("/shoes");
    key("ArrowDown");
    expect(panel("noor-nav-panel-1").hidden).toBe(false);
    expect(document.activeElement!.getAttribute("href")).toBe("/sandals");
    key("Escape");
    expect(panel("noor-nav-panel-1").hidden).toBe(true);
    expect(document.activeElement).toBe(button("noor-nav-panel-1"));
    button("noor-nav-panel-0").click();
    expect(panel("noor-nav-panel-0").hidden).toBe(false);
    expect(document.documentElement.hasAttribute("data-nav-disclosure")).toBe(true);
  });

  it("moves the menu itself into the condensed bar and back", () => {
    document.body.insertAdjacentHTML("afterbegin", '<div id="main-header"><div data-nav-compact-home="desktop-nav"></div></div>');
    const header = document.getElementById("main-header")!;
    const home = header.querySelector<HTMLElement>("[data-nav-compact-home]")!;
    const slot = document.querySelector<HTMLElement>("[data-nav-compact-from]")!;
    header.append(slot);
    home.append(document.getElementById("desktop-nav")!);
    button("desktop-nav-panel-0").click();
    header.classList.add("is-scrolled");
    placeCompactMenus(document);
    expect(document.getElementById("desktop-nav")!.parentElement).toBe(slot);
    // One copy, closed on the move.
    expect(document.querySelectorAll("#desktop-nav")).toHaveLength(1);
    expect(panel("desktop-nav-panel-0").hidden).toBe(true);
    header.classList.remove("is-scrolled");
    placeCompactMenus(document);
    expect(document.getElementById("desktop-nav")!.parentElement).toBe(home);
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
