// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { createInboxShortcutGuard } from "./use-inbox-shortcuts";
import { matchesShortcut, typingIn } from "../layout/shortcuts";
afterEach(() => { document.body.innerHTML = ""; vi.restoreAllMocks(); });
const key = (key: string, options: KeyboardEventInit = {}) => new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
it("never treats composing Enter as send, including the legacy 229 event", () => {
  expect(matchesShortcut("submit", key("Enter", { ctrlKey: true, isComposing: true }))).toBe(false);
  const legacy = key("Enter", { ctrlKey: true });
  Object.defineProperty(legacy, "keyCode", { value: 229 });
  expect(matchesShortcut("submit", legacy)).toBe(false);
  expect(matchesShortcut("submit", key("Enter", { ctrlKey: true }))).toBe(true);
});
it("reserves G sequences and ignores consumed, repeating, typing and modal keys", () => {
  const allowed = createInboxShortcutGuard();
  expect(allowed(key("g"))).toBe(false);
  expect(allowed(key("r"))).toBe(false);
  expect(allowed(key("r"))).toBe(true);
  expect(allowed(key("r", { repeat: true }))).toBe(false);
  const consumed = key("r"); consumed.preventDefault(); expect(allowed(consumed)).toBe(false);
  for (const tag of ["input", "textarea", "select"]) {
    const input = document.createElement(tag); document.body.append(input);
    const event = key("r"); input.dispatchEvent(event); expect(allowed(event)).toBe(false); input.remove();
  }
  const menu = document.createElement("div"); menu.setAttribute("role", "menu"); document.body.append(menu);
  expect(allowed(key("r"))).toBe(false);
});

it("handles window, document and non-element keyboard targets without treating them as editable", () => {
  expect(typingIn(window)).toBe(false);
  expect(typingIn(document)).toBe(false);
  expect(typingIn(document.createTextNode("text"))).toBe(false);
  expect(typingIn(null)).toBe(false);
  const input = document.createElement("input");
  expect(typingIn(input)).toBe(true);
});
