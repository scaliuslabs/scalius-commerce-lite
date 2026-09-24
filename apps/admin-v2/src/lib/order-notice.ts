import { useSyncExternalStore } from "react";

/**
 * The one page banner of the order page: why the last action without its own
 * dialog failed (e.g. "This order changed. Reload to see the latest.").
 * Dialogs show their own errors; this is for the status menu, the next-step
 * button, message retries and similar one-click actions.
 */
const notices = new Map<string, string>();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function showOrderNotice(orderId: string, message: string): void {
  notices.set(orderId, message);
  emit();
}

export function clearOrderNotice(orderId: string): void {
  if (notices.delete(orderId)) emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useOrderNotice(orderId: string): string | null {
  return useSyncExternalStore(
    subscribe,
    () => notices.get(orderId) ?? null,
    () => null,
  );
}
