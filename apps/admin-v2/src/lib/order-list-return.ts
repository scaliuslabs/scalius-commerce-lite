import { useSyncExternalStore } from "react";

/**
 * Where the order page's Back arrow returns to: the orders list exactly as the
 * merchant left it (tab, filters, page). Kept in this tab's session, never in
 * the URL. The search term is never part of it: it lives in `list-search`.
 */
const KEY = "admin.orders.returnHref";
const DEFAULT_HREF = "/admin/orders";
/** Only the list itself: never an order, an abandoned checkout sheet or any other page. */
const LIST_PATHS = new Set(["/admin/orders", "/admin/orders/abandoned"]);
const PRIVATE_PARAMS = new Set(["search", "q", "query", "term", "phone", "email"]);

function isSafeListHref(href: string): boolean {
  if (!href.startsWith("/") || href.startsWith("//")) return false;
  let url: URL;
  try {
    url = new URL(href, "http://admin.invalid");
  } catch {
    return false;
  }
  if (url.origin !== "http://admin.invalid") return false;
  if (!LIST_PATHS.has(url.pathname.replace(/\/+$/, ""))) return false;
  for (const [name, value] of url.searchParams) {
    if (PRIVATE_PARAMS.has(name.toLowerCase())) return false;
    // A phone number or email must never be kept, whatever the param is called.
    if (value.includes("@") || /\d{7,}/.test(value.replace(/[\s+]/g, ""))) return false;
  }
  return true;
}

export function rememberOrderListHref(href: string): void {
  if (!isSafeListHref(href)) return;
  try {
    sessionStorage.setItem(KEY, href);
  } catch {
    // Storage blocked: Back falls back to the plain list.
  }
}

export function orderListReturnHref(): string {
  try {
    const stored = sessionStorage.getItem(KEY);
    if (stored && isSafeListHref(stored)) return stored;
  } catch {
    // Storage blocked: fall through to the plain list.
  }
  return DEFAULT_HREF;
}

const subscribe = () => () => undefined;

/** The Back target for render: the plain list on the server, the remembered list after hydration. */
export function useOrderListReturnHref(): string {
  return useSyncExternalStore(subscribe, orderListReturnHref, () => DEFAULT_HREF);
}
