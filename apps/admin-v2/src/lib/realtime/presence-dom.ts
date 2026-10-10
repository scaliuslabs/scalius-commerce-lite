/**
 * Fields on the page for presence: the key a focused control reports, and the
 * editor root a key marks (`data-presence-root`). Loaded with the presence view.
 */
import { isFieldKey } from "./store";

/** The field key of a focused element, or null when it has no stable name. */
export function fieldKeyOf(element: Element | null): string | null {
  if (!element) return null;
  const own = element.getAttribute("name") ?? element.getAttribute("data-field");
  if (isFieldKey(own)) return own;
  const holder = element.closest("[data-field]");
  const named = holder?.getAttribute("data-field");
  if (isFieldKey(named)) return named;
  // A custom control (select trigger, combobox) beside its hidden named input.
  const item = element.closest("[data-slot=field], [data-slot=form-item]");
  const input = item?.querySelector("[name]")?.getAttribute("name");
  return isFieldKey(input) ? input : null;
}

/** The root element of the editor on `key` (`data-presence-root`). */
export function presenceRoot(key: string): Element | null {
  if (typeof document === "undefined") return null;
  for (const root of document.querySelectorAll("[data-presence-root]")) {
    if (root.getAttribute("data-presence-root") === key) return root;
  }
  return null;
}
