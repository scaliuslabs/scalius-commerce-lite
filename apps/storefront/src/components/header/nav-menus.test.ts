// @vitest-environment happy-dom

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installNavMenus, setMenuOpen } from "./nav-menus";

const menu = (id: string) => document.getElementById(id) as HTMLDetailsElement;
const summary = (id: string) => menu(id).querySelector<HTMLElement>(":scope > summary")!;
const key = (target: Element, name: string) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));

function pointer(type: string, target: Element, relatedTarget: Element | null = null) {
  const event = new MouseEvent(type, { bubbles: true, relatedTarget });
  Object.defineProperty(event, "pointerType", { value: "mouse" });
  target.dispatchEvent(event);
}

beforeAll(() => {
  installNavMenus(document);
});

// A cascading bar: Laptop (link + fly-out), Phones (no link), Sale; a drill drawer.
beforeEach(() => {
  document.body.innerHTML = `
    <nav data-menu-root id="bar">
      <ul data-menu-bar>
        <li><a id="laptop" href="/laptop">Laptop</a>
          <details data-menu="popup" data-menu-hover id="m-laptop">
            <summary><span class="sr-only">Laptop submenu</span></summary>
            <div data-menu-panel><ul data-menu-list>
              <li><a id="gaming" href="/gaming">Gaming</a>
                <details data-menu="popup" data-menu-hover id="m-gaming">
                  <summary><span class="sr-only">Gaming submenu</span></summary>
                  <div data-menu-panel><ul data-menu-list><li><a id="asus" href="/asus">Asus</a></li></ul></div>
                </details>
              </li>
              <li><a id="ultrabook" href="/ultrabook">Ultrabook</a></li>
            </ul></div>
          </details>
        </li>
        <li><details data-menu="popup" id="m-phones"><summary>Phones</summary>
          <div data-menu-panel><ul data-menu-list><li><a id="android" href="/android">Android</a></li></ul></div>
        </details></li>
        <li><a id="sale" href="/sale">Sale</a></li>
      </ul>
    </nav>
    <div id="drawer" tabindex="-1">
      <div data-menu-root>
        <ul data-menu-list>
          <li><details data-menu="drill" id="d-women"><summary>Women</summary>
            <div data-menu-panel><ul data-menu-list>
              <li><a id="all-women" href="/women">All Women</a></li>
              <li><details data-menu="drill" id="d-sarees"><summary>Sarees</summary>
                <div data-menu-panel><ul data-menu-list><li><a id="silk" href="/silk">Silk</a></li></ul></div>
              </details></li>
            </ul></div>
          </details></li>
          <li><a id="men" href="/men">Men</a></li>
        </ul>
      </div>
    </div>
    <nav data-menu-root>
      <details data-menu="popup" id="m-rail"><summary>All departments</summary>
        <div data-menu-panel><ul data-menu-list><li><a id="dept" href="/dept">Dept</a></li></ul></div>
      </details>
    </nav>
    <a id="outside" href="/elsewhere">Elsewhere</a>`;
});

afterEach(() => vi.useRealTimers());

describe("details menus", () => {
  it("keeps one menu open per root, ancestors included", () => {
    setMenuOpen(menu("m-laptop"), true);
    setMenuOpen(menu("m-gaming"), true);
    expect(menu("m-laptop").open).toBe(true);
    setMenuOpen(menu("m-phones"), true);
    expect(menu("m-laptop").open).toBe(false);
    expect(menu("m-gaming").open).toBe(false);
    expect(menu("m-phones").open).toBe(true);
  });

  it("moves along the bar with Left/Right/Home/End and opens with Down", () => {
    document.getElementById("laptop")!.focus();
    key(document.activeElement!, "ArrowRight");
    expect(document.activeElement).toBe(summary("m-phones"));
    key(document.activeElement!, "ArrowRight");
    expect(document.activeElement!.id).toBe("sale");
    key(document.activeElement!, "ArrowRight");
    expect(document.activeElement!.id).toBe("laptop");
    key(document.activeElement!, "End");
    expect(document.activeElement!.id).toBe("sale");
    key(document.activeElement!, "Home");
    expect(document.activeElement!.id).toBe("laptop");
    key(document.activeElement!, "ArrowDown");
    expect(menu("m-laptop").open).toBe(true);
    expect(document.activeElement!.id).toBe("gaming");
  });

  it("moves in a column, flies out with Right, comes back with Left", () => {
    setMenuOpen(menu("m-laptop"), true);
    document.getElementById("gaming")!.focus();
    key(document.activeElement!, "ArrowDown");
    expect(document.activeElement!.id).toBe("ultrabook");
    key(document.activeElement!, "ArrowDown");
    expect(document.activeElement!.id).toBe("gaming");
    key(document.activeElement!, "ArrowRight");
    expect(menu("m-gaming").open).toBe(true);
    expect(document.activeElement!.id).toBe("asus");
    key(document.activeElement!, "ArrowLeft");
    expect(menu("m-gaming").open).toBe(false);
    expect(document.activeElement).toBe(summary("m-gaming"));
  });

  it("closes the innermost menu on Escape and returns focus to its summary", () => {
    setMenuOpen(menu("m-laptop"), true);
    setMenuOpen(menu("m-gaming"), true);
    document.getElementById("asus")!.focus();
    key(document.activeElement!, "Escape");
    expect(menu("m-gaming").open).toBe(false);
    expect(menu("m-laptop").open).toBe(true);
    expect(document.activeElement).toBe(summary("m-gaming"));
    key(document.activeElement!, "Escape");
    expect(menu("m-laptop").open).toBe(false);
    expect(document.activeElement).toBe(summary("m-laptop"));
  });

  it("closes popups on a press outside and when focus leaves the root", () => {
    setMenuOpen(menu("m-laptop"), true);
    document.getElementById("outside")!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(menu("m-laptop").open).toBe(false);

    setMenuOpen(menu("m-laptop"), true);
    document.getElementById("gaming")!.dispatchEvent(
      new FocusEvent("focusout", { bubbles: true, relatedTarget: document.getElementById("outside") }),
    );
    expect(menu("m-laptop").open).toBe(false);
  });

  it("opens on mouse hover intent and closes when the pointer leaves", () => {
    vi.useFakeTimers();
    const item = menu("m-laptop");
    pointer("pointerover", item);
    expect(item.open).toBe(false);
    vi.advanceTimersByTime(100);
    expect(item.open).toBe(true);
    pointer("pointerout", item, document.getElementById("outside"));
    vi.advanceTimersByTime(300);
    expect(item.open).toBe(false);
  });

  it("drills one level per Escape and leaves the top level's Escape to the drawer", () => {
    const drawerKeys: string[] = [];
    document.getElementById("drawer")!.addEventListener("keydown", (event) => drawerKeys.push(event.key));
    setMenuOpen(menu("d-women"), true);
    setMenuOpen(menu("d-sarees"), true);
    document.getElementById("silk")!.focus();
    key(document.activeElement!, "Escape");
    expect(menu("d-sarees").open).toBe(false);
    expect(menu("d-women").open).toBe(true);
    expect(drawerKeys).toEqual([]);
    key(document.activeElement!, "Escape");
    expect(menu("d-women").open).toBe(false);
    expect(document.activeElement).toBe(summary("d-women"));
    // Nothing left to close: the drawer gets it.
    key(document.activeElement!, "Escape");
    expect(drawerKeys).toEqual(["Escape"]);
  });

  it("opens a menu of its own with Down and enters it", () => {
    summary("m-rail").focus();
    key(document.activeElement!, "ArrowDown");
    expect(menu("m-rail").open).toBe(true);
    expect(document.activeElement!.id).toBe("dept");
    key(document.activeElement!, "Escape");
    expect(menu("m-rail").open).toBe(false);
    expect(document.activeElement).toBe(summary("m-rail"));
  });

  it("drills in with Right and back with Left in a drawer", () => {
    summary("d-women").focus();
    key(document.activeElement!, "ArrowRight");
    expect(menu("d-women").open).toBe(true);
    expect(document.activeElement!.id).toBe("all-women");
    key(document.activeElement!, "ArrowDown");
    expect(document.activeElement).toBe(summary("d-sarees"));
    key(document.activeElement!, "ArrowLeft");
    expect(menu("d-women").open).toBe(false);
    expect(document.activeElement).toBe(summary("d-women"));
    key(document.activeElement!, "ArrowDown");
    expect(document.activeElement!.id).toBe("men");
  });
});
