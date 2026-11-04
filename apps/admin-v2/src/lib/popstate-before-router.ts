import { createBrowserHistory, type RouterHistory } from "@tanstack/react-router";

/*
 * Chrome calls a window's own listeners in the order they were added, capture
 * or not. Back that only closes an overlay (`components/ui/back-closes.ts`) must
 * be heard before the router's listener, or the router takes the overlay's
 * history entry for a page move: a dirty editor asks "Leave page?" and then
 * reloads (`history.go(0)`). So this listener is added before the router's
 * history exists, and the code loaded after the first paint hands it its
 * handler, which may stop the event from reaching the router.
 */

let handler: ((event: PopStateEvent) => void) | undefined;
let listening = false;

function listenBeforeRouter(): void {
  if (listening) return;
  listening = true;
  window.addEventListener("popstate", (event) => handler?.(event));
}

/** The dashboard router's history, created after the listener that must hear Back first. */
export function createDashboardHistory(): RouterHistory {
  listenBeforeRouter();
  return createBrowserHistory();
}

export function onPopStateBeforeRouter(next: ((event: PopStateEvent) => void) | undefined): void {
  listenBeforeRouter();
  handler = next;
}
