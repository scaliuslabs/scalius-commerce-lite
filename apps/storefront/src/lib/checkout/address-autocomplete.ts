/**
 * Address autocomplete at checkout (a progressive enhancement): when an active
 * app completes addresses (layout `appServices.address`) and the buyer ships to
 * a country it serves, the street line suggests addresses as the buyer types.
 * Choosing one fills the free-text fields the form shows (street, apartment,
 * suburb, city, region, postal code) and the form's own validation runs on
 * them as on typed text. The Bangladesh City, Thana and Area pickers are never
 * filled. Without JavaScript, or on any failure, the form is as it was: the
 * buyer types the address.
 *
 * The typed words are buyer data: they travel in a POST body only, never a
 * URL, and are never logged. The module loads only when the layout names an
 * address app (pages/cart.astro).
 */
import { serviceCoversCountry, type AddressAutocompleteService } from "@/lib/app-services";
import { LOCATION_COUNTRY, shippingCountryOf } from "./shipping-country";

export const ADDRESS_AUTOCOMPLETE_MIN_CHARS = 3;
export const ADDRESS_AUTOCOMPLETE_DEBOUNCE_MS = 250;
const MAX_SUGGESTIONS = 8;
const MAX_QUERY_LENGTH = 200;

export interface AddressSuggestion {
  id: string;
  text: string;
  secondaryText?: string;
}

/** The canonical fields a chosen suggestion fills (`@scalius/shared/address`). */
export interface ResolvedAddress {
  countryCode: string;
  line1?: string;
  line2?: string;
  dependentLocality?: string;
  locality?: string;
  adminArea?: string;
  postalCode?: string;
}

/** The form field each canonical address field fills. */
const FIELD_NAMES = {
  line1: "shippingAddress",
  line2: "shippingAddressLine2",
  dependentLocality: "shippingDependentLocality",
  locality: "shippingLocality",
  adminArea: "shippingAdminArea",
  postalCode: "shippingPostalCode",
} as const satisfies Record<Exclude<keyof ResolvedAddress, "countryCode">, string>;
const FIELD_KEYS = Object.keys(FIELD_NAMES) as Array<keyof typeof FIELD_NAMES>;

const COPY = {
  en: {
    suggestions: (count: number) => `${count} address ${count === 1 ? "suggestion" : "suggestions"} available. Use the up and down arrow keys to choose.`,
    filled: "Address filled in. Check it before you continue.",
  },
  bn: {
    suggestions: (count: number) => `${count}টি ঠিকানার পরামর্শ আছে। বেছে নিতে উপরে ও নিচের তীর কী ব্যবহার করুন।`,
    filled: "ঠিকানা পূরণ হয়েছে। এগিয়ে যাওয়ার আগে দেখে নিন।",
  },
} as const;

type Post = (path: string, body: Record<string, string>, signal: AbortSignal) => Promise<unknown>;

export interface AddressAutocompleteOptions {
  /** The checkout form (or any ancestor of its address fields). */
  root: ParentNode;
  /** The street line the buyer types in. */
  input: HTMLInputElement | HTMLTextAreaElement;
  service: AddressAutocompleteService;
  /** The page language, two letters. */
  locale: string;
  /** Sends a JSON POST to the API and returns the parsed response; throws on failure. */
  post: Post;
  signal?: AbortSignal;
  debounceMs?: number;
}

export interface AddressAutocomplete {
  /** Closes the list and stops listening. */
  destroy(): void;
}

/** 32 base64url characters from the browser's random source: one per form, never the buyer's data. */
export function newSessionToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The country the form posts: its select or hidden field, else Bangladesh. */
function readCountry(root: ParentNode): string {
  const control = root.querySelector<HTMLInputElement | HTMLSelectElement>('[name="shippingCountryCode"]');
  return shippingCountryOf(control?.value);
}

/** Suggestions only where an app serves the country, and never for the Bangladesh pickers. */
export function autocompleteCountry(root: ParentNode, service: AddressAutocompleteService): string | null {
  const country = readCountry(root);
  return country !== LOCATION_COUNTRY && serviceCoversCountry(service, country) ? country : null;
}

/** The typed words as one query line, or null while they are too short. */
export function autocompleteQuery(value: string): string | null {
  const query = value.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_LENGTH);
  return query.length >= ADDRESS_AUTOCOMPLETE_MIN_CHARS ? query : null;
}

function readEnvelopeData(response: unknown): Record<string, unknown> | null {
  if (!response || typeof response !== "object") return null;
  const envelope = response as { success?: unknown; data?: unknown };
  if (envelope.success !== true || !envelope.data || typeof envelope.data !== "object") return null;
  return envelope.data as Record<string, unknown>;
}

export function readSuggestions(response: unknown): AddressSuggestion[] {
  const list = readEnvelopeData(response)?.suggestions;
  if (!Array.isArray(list)) return [];
  const suggestions: AddressSuggestion[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const { id, text, secondaryText } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !id || typeof text !== "string" || !text.trim()) continue;
    suggestions.push({
      id,
      text: text.trim(),
      ...(typeof secondaryText === "string" && secondaryText.trim() ? { secondaryText: secondaryText.trim() } : {}),
    });
    if (suggestions.length >= MAX_SUGGESTIONS) break;
  }
  return suggestions;
}

export function readResolvedAddress(response: unknown): ResolvedAddress | null {
  const address = readEnvelopeData(response)?.address;
  if (!address || typeof address !== "object") return null;
  const raw = address as Record<string, unknown>;
  if (typeof raw.countryCode !== "string") return null;
  const resolved: ResolvedAddress = { countryCode: raw.countryCode };
  for (const key of FIELD_KEYS) {
    const value = raw[key];
    if (typeof value === "string" && value.trim()) resolved[key] = value.trim();
  }
  return resolved;
}

/** The POST sender the checkout uses: the public API, no cookies, no caching. */
export function apiPost(createUrl: (path: string) => string): Post {
  return async (path, body, signal) => {
    const response = await fetch(createUrl(path), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      credentials: "omit",
      signal,
    });
    if (!response.ok) throw new Error("address autocomplete unavailable");
    return response.json();
  };
}

let listCount = 0;

export function enhanceAddressAutocomplete(options: AddressAutocompleteOptions): AddressAutocomplete {
  const { root, input, service, locale, post, signal } = options;
  const debounceMs = options.debounceMs ?? ADDRESS_AUTOCOMPLETE_DEBOUNCE_MS;
  const doc = input.ownerDocument;
  const copy = locale === "bn" ? COPY.bn : COPY.en;
  const sessionToken = newSessionToken();
  const listId = `${input.id || "address"}-suggestions-${++listCount}`;
  const label = input.id ? doc.querySelector<HTMLLabelElement>(`label[for="${input.id}"]`) : null;
  if (label && !label.id) label.id = `${listId}-label`;

  const host = input.parentElement;
  const list = doc.createElement("ul");
  list.id = listId;
  list.hidden = true;
  list.setAttribute("role", "listbox");
  if (label) list.setAttribute("aria-labelledby", label.id);
  list.className = "absolute inset-x-0 z-30 mt-1 max-h-64 overflow-y-auto overscroll-contain rounded-lg border border-border bg-background py-1 shadow-lg";
  const status = doc.createElement("p");
  status.className = "sr-only";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  if (host) {
    host.classList.add("relative");
    input.after(list, status);
  }

  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-controls", listId);
  input.setAttribute("aria-haspopup", "listbox");

  let shown: AddressSuggestion[] = [];
  let active = -1;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Suggestions and the chosen address are separate requests: leaving the field keeps a choice loading.
  let suggestRequest: AbortController | null = null;
  let suggestId = 0;
  let resolveRequest: AbortController | null = null;
  let resolveId = 0;
  let filling = false;
  // What the last choice wrote, so a later choice clears what it replaces and the buyer's own edits stay.
  const filled = new Map<string, string>();

  const setActive = (index: number) => {
    active = index >= 0 && index < shown.length ? index : -1;
    const items = list.children;
    for (let i = 0; i < items.length; i++) {
      const item = items[i] as HTMLElement;
      const on = i === active;
      item.setAttribute("aria-selected", String(on));
      item.classList.toggle("bg-muted", on);
      if (on) item.scrollIntoView?.({ block: "nearest" });
    }
    if (active >= 0) input.setAttribute("aria-activedescendant", `${listId}-${active}`);
    else input.removeAttribute("aria-activedescendant");
  };

  const close = () => {
    shown = [];
    list.hidden = true;
    list.replaceChildren();
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    active = -1;
  };

  const cancelSuggest = () => {
    clearTimeout(timer);
    timer = undefined;
    suggestRequest?.abort();
    suggestRequest = null;
    suggestId += 1;
  };

  const cancelResolve = () => {
    resolveRequest?.abort();
    resolveRequest = null;
    resolveId += 1;
  };

  const open = (suggestions: AddressSuggestion[]) => {
    shown = suggestions;
    list.replaceChildren(...suggestions.map((suggestion, index) => {
      const item = doc.createElement("li");
      item.id = `${listId}-${index}`;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", "false");
      item.dataset.index = String(index);
      item.className = "flex min-h-11 cursor-pointer flex-col justify-center px-4 py-1.5 text-start text-foreground sm:px-3 sm:hover:bg-muted/60";
      const main = doc.createElement("span");
      main.className = "text-sm font-medium";
      main.textContent = suggestion.text;
      item.append(main);
      if (suggestion.secondaryText) {
        const secondary = doc.createElement("span");
        secondary.className = "text-xs text-muted-foreground";
        secondary.textContent = suggestion.secondaryText;
        item.append(secondary);
      }
      return item;
    }));
    // Just below the field, wherever the textarea ends.
    list.style.top = `${input.offsetTop + input.offsetHeight}px`;
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    status.textContent = copy.suggestions(suggestions.length);
    setActive(-1);
  };

  const fire = (field: HTMLInputElement | HTMLTextAreaElement) => {
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const fieldFor = (name: string): HTMLInputElement | HTMLTextAreaElement | null => {
    const field = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`);
    // A field the country's rules hide, or a disabled one, is not the form's.
    if (!field || field.disabled || field.closest("[hidden]")) return null;
    return field;
  };

  const write = (name: string, value: string) => {
    const field = fieldFor(name);
    if (!field) return;
    const next = field.maxLength > 0 ? value.slice(0, field.maxLength) : value;
    if (field.value === next) {
      filled.set(name, next);
      return;
    }
    field.value = next;
    filled.set(name, next);
    fire(field);
  };

  const fill = (address: ResolvedAddress) => {
    filling = true;
    try {
      const written = new Set<string>();
      for (const key of FIELD_KEYS) {
        const value = address[key];
        if (!value) continue;
        write(FIELD_NAMES[key], value);
        written.add(FIELD_NAMES[key]);
      }
      // A field the last choice filled that this one has no value for was that address's: clear it unless the buyer changed it.
      for (const [name, previous] of [...filled]) {
        if (written.has(name)) continue;
        filled.delete(name);
        const field = fieldFor(name);
        if (field && field.value === previous) {
          field.value = "";
          fire(field);
        }
      }
    } finally {
      filling = false;
    }
    status.textContent = copy.filled;
  };

  const choose = async (suggestion: AddressSuggestion | undefined) => {
    if (!suggestion) return;
    const country = autocompleteCountry(root, service);
    close();
    cancelSuggest();
    cancelResolve();
    if (!country) return;
    const controller = new AbortController();
    resolveRequest = controller;
    const id = resolveId;
    try {
      const response = await post(
        "/address-rules/autocomplete/resolve",
        { provider: service.id, country, locale, sessionToken, id: suggestion.id },
        controller.signal,
      );
      if (controller.signal.aborted || id !== resolveId) return;
      const address = readResolvedAddress(response);
      // The buyer may have changed the country while it loaded; an answer for another country is not this form's.
      if (!address || address.countryCode !== country || autocompleteCountry(root, service) !== country) return;
      fill(address);
    } catch {
      // The buyer types the address as usual.
    }
  };

  const suggest = async (query: string, country: string) => {
    suggestRequest?.abort();
    const controller = new AbortController();
    suggestRequest = controller;
    const id = ++suggestId;
    try {
      const response = await post(
        "/address-rules/autocomplete/suggest",
        { provider: service.id, country, locale, sessionToken, query },
        controller.signal,
      );
      if (controller.signal.aborted || id !== suggestId) return;
      // Out of date when the words or the country changed while it loaded.
      if (autocompleteQuery(input.value) !== query || autocompleteCountry(root, service) !== country) return;
      const suggestions = readSuggestions(response);
      if (suggestions.length > 0 && doc.activeElement === input) open(suggestions);
      else close();
    } catch {
      close();
    }
  };

  const onInput = () => {
    if (filling) return;
    cancelSuggest();
    cancelResolve();
    const country = autocompleteCountry(root, service);
    const query = autocompleteQuery(input.value);
    if (!country || !query) {
      close();
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      void suggest(query, country);
    }, debounceMs);
  };

  const onKeydown = (raw: Event) => {
    const event = raw as KeyboardEvent;
    if (list.hidden) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      // Down from the field enters the list at the top, Up at the bottom; past either end returns to the field.
      const position = (active + 1 + step + shown.length + 1) % (shown.length + 1);
      setActive(position - 1);
    } else if (event.key === "Enter" && active >= 0) {
      event.preventDefault();
      void choose(shown[active]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Tab") {
      close();
    }
  };

  const listen = { signal };
  input.addEventListener("input", onInput, listen);
  input.addEventListener("keydown", onKeydown, listen);
  // Keep the focus in the field while pressing an option, then choose it.
  list.addEventListener("pointerdown", (event) => event.preventDefault(), listen);
  list.addEventListener("click", (event) => {
    const item = (event.target as Element | null)?.closest<HTMLElement>("[role=option]");
    if (item) void choose(shown[Number(item.dataset.index)]);
  }, listen);
  input.addEventListener("blur", () => {
    cancelSuggest();
    close();
  }, listen);
  // Another country has no suggestions here (or this one's list is for the old words).
  const country = root.querySelector('select[name="shippingCountryCode"]');
  country?.addEventListener("change", () => {
    cancelSuggest();
    cancelResolve();
    close();
  }, listen);

  const destroy = () => {
    cancelSuggest();
    cancelResolve();
    close();
    input.removeEventListener("input", onInput);
    input.removeEventListener("keydown", onKeydown);
    for (const name of ["role", "aria-autocomplete", "aria-expanded", "aria-controls", "aria-haspopup", "aria-activedescendant"]) {
      input.removeAttribute(name);
    }
    list.remove();
    status.remove();
  };
  signal?.addEventListener("abort", destroy, { once: true });
  return { destroy };
}
