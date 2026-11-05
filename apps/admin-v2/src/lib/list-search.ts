import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useNavigate } from "@tanstack/react-router";

/**
 * A list's search term lives in this tab's session, never in the URL: search
 * terms can be phone numbers, emails or codes (AGENTS.md). Lists are keyed by
 * name ("products", "customers", …), and each tab by its own key
 * (`listSearchKey`), so a term typed in one tab never filters another. To
 * open a list already searched, write the term first and then navigate:
 * `writeListSearch("customers", term)`.
 */
const PREFIX = "admin.listSearch.";
const memory = new Map<string, string>();
const listeners = new Set<() => void>();

export function readListSearch(list: string): string {
  if (memory.has(list)) return memory.get(list)!;
  let stored = "";
  try {
    stored = sessionStorage.getItem(PREFIX + list) ?? "";
  } catch {
    // Storage blocked: the term lives in memory only.
  }
  memory.set(list, stored);
  return stored;
}

export function writeListSearch(list: string, term: string): void {
  const value = term.trim() ? term : "";
  if (readListSearch(list) === value) return;
  memory.set(list, value);
  try {
    if (value) sessionStorage.setItem(PREFIX + list, value);
    else sessionStorage.removeItem(PREFIX + list);
  } catch {
    // Storage blocked: the term lives in memory only.
  }
  for (const listener of listeners) listener();
}

/**
 * A list tab's own search key, as Shopify views each keep their query:
 * "products", "products.draft", "products.trash". `viewParam` names the
 * search param holding the tab (e.g. "status"); Trash always has its own.
 */
export function listSearchKey(list: string, search: { trashed?: boolean } & Record<string, unknown>, viewParam?: string): string {
  if (search.trashed) return `${list}.trash`;
  const view = viewParam ? search[viewParam] : undefined;
  return typeof view === "string" && view ? `${list}.${view}` : list;
}

/**
 * A `?q=` deep link wins once: it becomes the list's session term (the page
 * then drops `q` from the address). Without one, the session term stays.
 * Call it from the route loader with the validated `q`.
 */
export function adoptListSearch(list: string, q: unknown): string {
  if (typeof q !== "string") return readListSearch(list);
  writeListSearch(list, q);
  return readListSearch(list);
}

/** A list validator's share of a `?q=` deep link: kept until the loader adopts it. */
export function urlSearchTerm(search: Record<string, unknown>): { q?: string } {
  return typeof search.q === "string" ? { q: search.q } : {};
}

/**
 * Drops an adopted `?q=` from the address (the term now lives in the session,
 * and the search box shows it): a reload or a shared link never carries it.
 */
export function useDropUrlSearchTerm(q: unknown): void {
  const navigate = useNavigate();
  useEffect(() => {
    if (typeof q !== "string") return;
    void navigate({ to: ".", search: ((previous: Record<string, unknown>) => ({ ...previous, q: undefined })) as never, replace: true });
  }, [q, navigate]);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The list's current search term and a setter; every reader re-renders on change. */
export function useListSearch(list: string): [string, (term: string) => void] {
  const term = useSyncExternalStore(subscribe, () => readListSearch(list), () => "");
  const setTerm = useCallback((value: string) => writeListSearch(list, value), [list]);
  return [term, setTerm];
}
