// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { installStorefrontActions } from "./storefront-actions";

let uninstall: (() => void) | undefined;
const eventCleanups: Array<() => void> = [];
function listen(target: EventTarget, name: string) {
  const listener = vi.fn();
  target.addEventListener(name, listener);
  eventCleanups.push(() => target.removeEventListener(name, listener));
  return listener;
}
afterEach(() => {
  uninstall?.();
  for (const cleanup of eventCleanups.splice(0)) cleanup();
  document.body.replaceChildren();
  delete document.documentElement.dataset.marketPresence;
  document.cookie = "cs_auth=; Max-Age=0; path=/";
  vi.restoreAllMocks();
});

const click = (element: Element, init: MouseEventInit = {}) => {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
  element.dispatchEvent(event);
  return event;
};

function mockOpenPopover(id: string, closed: string[]) {
  const popover = document.getElementById(id)!;
  let open = true;
  const matches = popover.matches.bind(popover);
  vi.spyOn(popover, "matches").mockImplementation((selector) => selector === ":popover-open" ? open : matches(selector));
  const hide = vi.fn(() => { open = false; closed.push(id); });
  Object.defineProperty(popover, "hidePopover", { configurable: true, value: hide });
  return { popover, hide, isOpen: () => open };
}

describe("shared storefront actions", () => {
  it("handles app search markup inserted later with a single delegated listener", () => {
    uninstall = installStorefrontActions();
    expect(installStorefrontActions()).toBe(uninstall);
    document.body.innerHTML = '<a href="/search" data-search-open><span>Search</span></a>';
    const events = listen(document, "open-search-palette");
    expect(click(document.querySelector("span")!).defaultPrevented).toBe(true);
    expect(events).toHaveBeenCalledTimes(1);
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ type: "open-search-palette" }));
    uninstall();
    expect(click(document.querySelector("span")!).defaultPrevented).toBe(false);
  });

  it("accepts keyboard-generated clicks from focused search and account controls", () => {
    uninstall = installStorefrontActions();
    document.body.innerHTML = '<button data-search-open>Search</button><button data-account-link>Account</button>';
    const search = document.querySelector<HTMLButtonElement>("[data-search-open]")!;
    const account = document.querySelector<HTMLButtonElement>("[data-account-link]")!;
    const searchEvents = listen(document, "open-search-palette");
    const authEvents = listen(window, "open-auth-modal");
    search.focus();
    expect(click(search, { detail: 0 }).defaultPrevented).toBe(true);
    expect(searchEvents).toHaveBeenCalledWith(expect.objectContaining({ type: "open-search-palette" }));
    account.focus();
    expect(click(account, { detail: 0 }).defaultPrevented).toBe(true);
    expect(authEvents).toHaveBeenCalledWith(expect.objectContaining({ type: "open-auth-modal" }));
  });

  it("keeps modified links and app-owned popovers under their own control", () => {
    uninstall = installStorefrontActions();
    document.body.innerHTML = '<a href="/search" data-search-open>Search</a>';
    const link = document.querySelector("a")!;
    const events = listen(document, "open-search-palette");
    expect(click(link, { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(click(link, { button: 1 }).defaultPrevented).toBe(false);
    link.addEventListener("click", (event) => event.preventDefault());
    click(link);
    expect(events).not.toHaveBeenCalled();
  });

  it("opens inline search on a pointer press but preserves keyboard typing and unscoped submission", () => {
    uninstall = installStorefrontActions();
    document.body.innerHTML = '<form data-header-search action="/search"><input name="q" data-search-inline></form>';
    const input = document.querySelector("input")!;
    input.focus();
    input.value = "linen";
    const events = listen(document, "open-search-palette");
    const keyboard = new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "" });
    input.dispatchEvent(keyboard);
    expect(keyboard.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("linen");
    expect(events).not.toHaveBeenCalled();
    const pointer = new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "touch" });
    input.dispatchEvent(pointer);
    expect(pointer.defaultPrevented).toBe(true);
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ type: "open-search-palette" }));
    const submit = new SubmitEvent("submit", { bubbles: true, cancelable: true });
    document.querySelector("form")!.dispatchEvent(submit);
    expect(submit.defaultPrevented).toBe(false);
  });

  it.each([
    ["data-search-open", "open-search-palette", "document"],
    ["data-account-link", "open-auth-modal", "window"],
  ] as const)("closes containing native popovers before %s hands off to host UI", (attribute, name, surface) => {
    uninstall = installStorefrontActions();
    document.body.innerHTML = `<button hidden popovertarget="drawer">Hidden menu</button>
      <button id="menu" popovertarget="drawer">Menu</button>
      <div id="drawer" popover><button popovertarget="submenu">More</button>
        <div id="submenu" popover><button id="action" ${attribute}>Open</button></div></div>`;
    const closed: string[] = [];
    const outer = mockOpenPopover("drawer", closed);
    const inner = mockOpenPopover("submenu", closed);
    const menu = document.getElementById("menu")!;
    vi.spyOn(menu, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
    const action = document.getElementById("action")!;
    action.focus();
    const opened = listen(surface === "document" ? document : window, name);
    opened.mockImplementation(() => {
      // This is what AuthModal/CommandPalette capture for focus on close.
      expect(closed).toEqual(["submenu", "drawer"]);
      expect(inner.isOpen()).toBe(false);
      expect(outer.isOpen()).toBe(false);
      expect(document.activeElement).toBe(menu);
    });
    click(action);
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it("keeps a native popover open for modified/prevented actions and signed-in account navigation", () => {
    uninstall = installStorefrontActions();
    document.body.innerHTML = '<div id="drawer" popover><a href="/account" data-account-link>Account</a><button data-search-open>Search</button></div>';
    const drawer = mockOpenPopover("drawer", []);
    const account = document.querySelector("a")!;
    const search = document.querySelector("button")!;
    click(search, { ctrlKey: true });
    search.addEventListener("click", (event) => event.preventDefault());
    click(search);
    document.cookie = "cs_auth=1; path=/";
    click(account);
    expect(drawer.hide).not.toHaveBeenCalled();
    expect(drawer.isOpen()).toBe(true);
  });

  it("keeps scoped search on the buyer's market presence and encodes their query", () => {
    uninstall = installStorefrontActions();
    document.documentElement.dataset.marketPresence = "en-in";
    document.body.innerHTML = '<form data-header-search><select data-search-scope><option value="/categories/clothes">Clothes</option></select><input name="q" value=" cotton &amp; linen "></form>';
    const navigate = vi.spyOn(window.location, "assign").mockImplementation(() => {});
    const submit = new SubmitEvent("submit", { bubbles: true, cancelable: true });
    document.querySelector("form")!.dispatchEvent(submit);
    expect(submit.defaultPrevented).toBe(true);
    expect(navigate).toHaveBeenCalledWith("/en-in/categories/clothes?q=cotton+%26+linen");
  });

  it("uses the live exact auth hint for each account click without login event rebinding", () => {
    uninstall = installStorefrontActions();
    document.body.innerHTML = '<a href="/account" data-account-link><span>Account</span></a>';
    const target = document.querySelector("span")!;
    const events = listen(window, "open-auth-modal");
    expect(click(target).defaultPrevented).toBe(true);
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ type: "open-auth-modal" }));
    events.mockClear();
    document.cookie = "cs_auth=1; path=/";
    expect(click(target).defaultPrevented).toBe(false);
    expect(events).not.toHaveBeenCalled();
    document.cookie = "cs_auth=10; path=/";
    expect(click(target).defaultPrevented).toBe(true);
    expect(events).toHaveBeenCalledTimes(1);
    events.mockClear();
    expect(click(target, { metaKey: true }).defaultPrevented).toBe(false);
    expect(events).not.toHaveBeenCalled();
  });
});
