/**
 * Turns a server-rendered location `<select>` into a search-or-scroll
 * combobox (the WAI-ARIA editable combobox with a list popup). The select
 * stays in the form, hidden, as the value that is submitted; its options are
 * the list. Tap or click opens the list, typing filters it (Bangla or
 * English, best match first), arrow keys and Enter choose, Escape closes.
 * On a phone the list opens as a full-height sheet with the search box on
 * top. Choosing closes the list and fires `change` on the select.
 */
import { rankPlaces } from "./location-search";

export interface LocationComboboxCopy {
  /** "No match for {query}". */
  noMatchText: string;
  closeText: string;
}

export interface LocationCombobox {
  /** Re-reads the select's options, value, disabled and busy state. */
  sync(): void;
  focus(): void;
}

interface Choice {
  id: string;
  name: string;
}

const PHONE_QUERY = "(max-width: 639px)";
let comboboxCount = 0;

export function enhanceLocationCombobox(
  select: HTMLSelectElement,
  copy: LocationComboboxCopy,
  signal?: AbortSignal,
): LocationCombobox {
  const doc = select.ownerDocument;
  const id = select.id || `location-combobox-${++comboboxCount}`;
  const listId = `${id}-list`;
  const label = select.id ? doc.querySelector<HTMLLabelElement>(`label[for="${select.id}"]`) : null;
  if (label && !label.id) label.id = `${id}-label`;
  const phone = doc.defaultView?.matchMedia?.(PHONE_QUERY);
  const isPhone = () => phone?.matches === true;

  // The visible field takes over the select's id, so its label, error
  // messages and validation focus land on it.
  const input = doc.createElement("input");
  input.type = "text";
  input.id = id;
  select.id = `${id}-native`;
  input.className = `${select.className} cursor-pointer pr-9 text-ellipsis`;
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-controls", listId);
  input.autocomplete = select.getAttribute("autocomplete") || "off";
  input.spellcheck = false;
  for (const name of ["aria-describedby", "aria-required", "aria-invalid"]) {
    const value = select.getAttribute(name);
    if (value !== null) input.setAttribute(name, value);
  }
  // The hidden select cannot take the browser's required prompt; the page validates.
  if (select.required) {
    input.setAttribute("aria-required", "true");
    select.required = false;
  }

  const chevron = doc.createElement("span");
  chevron.setAttribute("aria-hidden", "true");
  chevron.className = "pointer-events-none absolute inset-y-0 right-3 flex items-center text-muted-foreground";
  chevron.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';

  // Below the field on a wide screen; a full-height sheet on a phone.
  const popup = doc.createElement("div");
  popup.hidden = true;
  popup.className = "fixed inset-0 z-50 flex flex-col bg-background sm:absolute sm:inset-x-0 sm:bottom-auto sm:top-full sm:z-30 sm:mt-1 sm:block sm:rounded-lg sm:border sm:border-border sm:shadow-lg";

  const sheetHead = doc.createElement("div");
  sheetHead.className = "flex items-center gap-2 border-b border-border p-3 sm:hidden";
  const search = doc.createElement("input");
  search.type = "search";
  search.className = `${select.className} min-w-0 flex-1`;
  search.autocomplete = "off";
  search.spellcheck = false;
  search.enterKeyHint = "search";
  search.setAttribute("role", "combobox");
  search.setAttribute("aria-autocomplete", "list");
  search.setAttribute("aria-expanded", "true");
  search.setAttribute("aria-controls", listId);
  if (label) search.setAttribute("aria-labelledby", label.id);
  const close = doc.createElement("button");
  close.type = "button";
  close.className = "inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-foreground hover:bg-muted";
  close.setAttribute("aria-label", copy.closeText);
  close.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  sheetHead.append(search, close);

  const list = doc.createElement("ul");
  list.id = listId;
  list.setAttribute("role", "listbox");
  if (label) list.setAttribute("aria-labelledby", label.id);
  list.className = "min-h-0 flex-1 overflow-y-auto overscroll-contain py-1 sm:max-h-72";
  const empty = doc.createElement("p");
  empty.className = "px-4 py-3 text-sm text-muted-foreground";
  empty.setAttribute("role", "status");
  empty.hidden = true;
  popup.append(sheetHead, list, empty);

  const wrapper = doc.createElement("div");
  wrapper.className = "relative";
  select.before(wrapper);
  wrapper.append(input, chevron, popup, select);
  select.hidden = true;
  select.tabIndex = -1;
  select.setAttribute("aria-hidden", "true");

  let shown: Choice[] = [];
  let active = -1;
  let open = false;

  const choices = (): Choice[] =>
    Array.from(select.options)
      .filter((option) => option.value && !option.disabled)
      .map((option) => ({ id: option.value, name: option.text }));
  const selectedName = () => (select.value ? select.options[select.selectedIndex]?.text ?? "" : "");
  const typing = () => (isPhone() ? search : input);

  const setActive = (index: number) => {
    active = shown.length ? Math.max(0, Math.min(index, shown.length - 1)) : -1;
    const items = list.children;
    for (let i = 0; i < items.length; i++) {
      const item = items[i] as HTMLElement;
      const on = i === active;
      item.classList.toggle("bg-muted", on);
      if (on) item.scrollIntoView?.({ block: "nearest" });
    }
    const current = active >= 0 ? `${listId}-${active}` : "";
    for (const field of [input, search]) {
      if (current) field.setAttribute("aria-activedescendant", current);
      else field.removeAttribute("aria-activedescendant");
    }
  };

  const render = (query: string) => {
    shown = rankPlaces(choices(), query);
    list.replaceChildren(...shown.map((choice, index) => {
      const item = doc.createElement("li");
      item.id = `${listId}-${index}`;
      item.setAttribute("role", "option");
      const selected = choice.id === select.value;
      item.setAttribute("aria-selected", String(selected));
      item.dataset.value = choice.id;
      item.className = `flex min-h-11 cursor-pointer items-center justify-between gap-3 px-4 text-base text-foreground sm:min-h-10 sm:px-3 sm:text-sm sm:hover:bg-muted/60 ${selected ? "font-semibold" : ""}`;
      item.textContent = choice.name;
      if (selected) {
        const check = doc.createElement("span");
        check.setAttribute("aria-hidden", "true");
        check.className = "text-primary";
        check.textContent = "✓";
        item.append(check);
      }
      return item;
    }));
    const busy = select.getAttribute("aria-busy") === "true";
    empty.textContent = busy
      ? select.options[0]?.text ?? ""
      : shown.length === 0
        ? copy.noMatchText.replace("{query}", query.trim())
        : "";
    empty.hidden = !empty.textContent;
    const selectedIndex = query ? -1 : shown.findIndex((choice) => choice.id === select.value);
    setActive(selectedIndex >= 0 ? selectedIndex : query ? 0 : -1);
  };

  const lockPage = (locked: boolean) => {
    doc.documentElement.style.overflow = locked ? "hidden" : "";
  };

  const openList = () => {
    if (open || input.disabled) return;
    open = true;
    popup.hidden = false;
    input.setAttribute("aria-expanded", "true");
    if (isPhone()) {
      lockPage(true);
      search.value = "";
      search.focus();
    }
    render("");
  };

  const closeList = (refocus = true) => {
    if (!open) return;
    open = false;
    popup.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    input.value = selectedName();
    if (isPhone()) {
      lockPage(false);
      if (refocus) input.focus();
    }
  };

  const choose = (choice: Choice | undefined) => {
    if (!choice) return;
    const changed = choice.id !== select.value;
    select.value = choice.id;
    closeList();
    input.value = choice.name;
    if (changed) select.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const onType = (field: HTMLInputElement) => {
    if (!open) openList();
    render(field.value);
  };

  const onKey = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        openList();
        return;
      }
      setActive(active < 0 ? 0 : active + (event.key === "ArrowDown" ? 1 : -1));
    } else if (event.key === "Enter") {
      // Enter chooses; it never submits the checkout from this field.
      event.preventDefault();
      if (open) choose(shown[active]);
      else openList();
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      closeList();
    } else if (event.key === "Tab" && open) {
      closeList(false);
    }
  };

  const listen = { signal };
  input.addEventListener("click", () => {
    if (open) return closeList();
    openList();
    // Typing replaces the chosen name instead of adding to it.
    if (!isPhone()) input.select();
  }, listen);
  input.addEventListener("input", () => onType(input), listen);
  input.addEventListener("keydown", onKey, listen);
  // A browser autofill types the name: take it when it names one place.
  input.addEventListener("change", () => {
    if (open) return;
    const typed = input.value.trim().toLocaleLowerCase();
    const match = choices().filter((choice) => choice.name.trim().toLocaleLowerCase() === typed);
    if (match.length === 1) choose(match[0]);
    else input.value = selectedName();
  }, listen);
  search.addEventListener("input", () => onType(search), listen);
  search.addEventListener("keydown", onKey, listen);
  close.addEventListener("click", () => closeList(), listen);
  // Keep focus in the field while pressing an option, then choose it.
  list.addEventListener("pointerdown", (event) => event.preventDefault(), listen);
  list.addEventListener("click", (event) => {
    const item = (event.target as Element | null)?.closest<HTMLElement>("[role=option]");
    if (item) choose(shown.find((choice) => choice.id === item.dataset.value));
  }, listen);
  wrapper.addEventListener("focusout", (event) => {
    const next = event.relatedTarget as Node | null;
    if (open && !isPhone() && !(next && wrapper.contains(next))) closeList(false);
  }, listen);
  // A phone turned to landscape (or a resized window) swaps sheet and dropdown.
  phone?.addEventListener?.("change", () => {
    closeList(false);
    sync();
  }, listen);
  signal?.addEventListener("abort", () => lockPage(false));

  const sync = () => {
    const busy = select.getAttribute("aria-busy") === "true";
    input.disabled = select.disabled && !busy;
    input.readOnly = isPhone();
    input.inputMode = isPhone() ? "none" : "text";
    input.placeholder = select.options[0] && !select.options[0].value ? select.options[0].text : "";
    search.placeholder = input.placeholder;
    if (busy) input.setAttribute("aria-busy", "true");
    else input.removeAttribute("aria-busy");
    if (input.disabled) closeList(false);
    if (open) render(typing().value);
    else input.value = selectedName();
  };
  sync();

  return {
    sync,
    focus: () => input.focus(),
  };
}
