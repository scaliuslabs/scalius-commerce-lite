// @vitest-environment happy-dom

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fitNavOverflow, installNavDisclosure } from "./nav-disclosure";
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
