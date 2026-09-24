import { useCallback, useSyncExternalStore } from "react";

/**
 * A list's search term lives in this tab's session, never in the URL: search
 * terms can be phone numbers, emails or codes (AGENTS.md). Lists are keyed by
 * name ("products", "customers", …). To open a list already searched, write
 * the term first and then navigate: `writeListSearch("customers", term)`.
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
