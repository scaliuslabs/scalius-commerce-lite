import type { RouterHistory } from "@tanstack/react-router";
import { onPopStateBeforeRouter } from "~/lib/popstate-before-router";

/*
 * Back (the browser's button, Android's back gesture) closes the open modal
 * overlay instead of changing the page under it: the navigation drawer, the
 * search palette, a dialog or a sheet.
 *
 * The usual history-entry pattern. While any overlay is open the history has
 * one extra entry for the same address (pushed with the native method, so the
 * router never sees it). Back leaves that entry: the top overlay gets Escape,
 * so it closes exactly as Escape closes it (an overlay that refuses Escape,
 * such as a one-time secret, refuses Back too, and a menu open inside it
 * closes first), and the page stays. Closing the last overlay any other way
 * takes the entry back off. A page opened from inside an overlay (a drawer
 * link, a search result) replaces the entry, so history never keeps it: Back
 * from that page returns to the page under the overlay. Deep links and reloads
 * are untouched: the entry only exists while something is open.
 *
 * An overlay kept in the address (`?review=`) already has the router's own
 * entry, so Back closes it without help: it carries `data-url-overlay` and is
 * left alone. Stepping back over our entry while the router writes the address
 * its close asked for would land on the old address and open it again.
 */

let open = 0;
/** The overlay's entry is the current history entry. */
let marked = false;
/** The address of that entry, which a replace while it is current may change. */
let markedHref = "";
/** The router's state for that address (a replace changes it with the address). */
let markedState: unknown = null;
/** Our own `history.back()` that takes the entry off is on its way. */
let leaving = false;
let release = 0;
let restore: (() => void) | null = null;
let routerHistory: RouterHistory | undefined;
let unsubscribe: (() => void) | undefined;
let reconcile = 0;

/** A blocked traversal changes the browser address before the router accepts it. */
function onAcceptedPage(): boolean {
  if (!routerHistory) return true;
  const current = routerHistory.location;
  return current.href === location.pathname + location.search + location.hash &&
    historyKey(current.state) === historyKey(history.state);
}

function scheduleSync() {
  window.clearTimeout(reconcile);
  reconcile = window.setTimeout(sync);
}

function historyKey(state: unknown): unknown {
  const value = state as { __TSR_key?: unknown; key?: unknown } | null;
  return value?.__TSR_key ?? value?.key;
}

/** While the entry is current, the app's own history calls must step over it. */
function patch() {
  const { pushState, replaceState, go, back } = history;
  const unpatch = () => {
    if (history.pushState === patchedPush) history.pushState = pushState;
    if (history.replaceState === patchedReplace) history.replaceState = replaceState;
    if (history.go === patchedGo) history.go = go;
    if (history.back === patchedBack) history.back = back;
  };
  // A navigation from inside the overlay takes the entry's place (one that stays open gets a new one).
  const patchedPush: History["pushState"] = (data, unused, url) => {
    unmark();
    history.replaceState(data, unused, url);
    scheduleSync();
  };
  const patchedReplace: History["replaceState"] = (data, unused, url) => {
    replaceState.call(history, data, unused, url);
    markedHref = location.href;
    markedState = history.state;
  };
  // "Back to where settings were opened from" counts the pages the router knows.
  const patchedGo: History["go"] = (delta = 0) => go.call(history, delta < 0 ? delta - 1 : delta);
  const patchedBack: History["back"] = () => go.call(history, -2);
  history.pushState = patchedPush;
  history.replaceState = patchedReplace;
  history.go = patchedGo;
  history.back = patchedBack;
  restore = unpatch;
}

function mark() {
  // Pushing at a proposed Back destination would erase the forward entry a
  // dirty editor needs when the merchant chooses Stay. The router owns that
  // decision; only its accepted page may acquire an overlay entry.
  if (marked || leaving || !onAcceptedPage()) return;
  History.prototype.pushState.call(history, history.state, "");
  marked = true;
  markedHref = location.href;
  markedState = history.state;
  patch();
}

function unmark() {
  marked = false;
  restore?.();
  restore = null;
}

function closeTop() {
  const target = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
  target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
}

function onPopState(event: PopStateEvent) {
  if (leaving) {
    leaving = false;
    // Taking our entry off never navigates: the router keeps the address it shows. An
    // overlay whose own close rewrote the address (a sheet kept in the URL, such as
    // ?review=) left the old address on the entry below, so that entry takes the new one,
    // or the router would read the old address and open the overlay again.
    if (location.href !== markedHref) History.prototype.replaceState.call(history, markedState, "", markedHref);
    event.stopImmediatePropagation();
    return;
  }
  if (!marked) {
    // A cancelled page traversal is restored by a later native popstate.
    scheduleSync();
    return;
  }
  unmark();
  // A multi-step jump to another page is the router's; the overlay stays.
  if (location.href !== markedHref || historyKey(history.state) !== historyKey(markedState)) {
    scheduleSync();
    return;
  }
  event.stopImmediatePropagation();
  closeTop();
  // Still open (Escape refused, or another overlay below): Back closes it next time.
  scheduleSync();
}

/**
 * The overlays Back closes: a `Dialog` (the search palette too), a `Sheet` and
 * the navigation drawer, never an `AlertDialog` (a decision, such as "Leave
 * page?", which can itself be on screen because Back was pressed) and never a
 * popover or menu. Radix portals each into its own child of <body>.
 */
const OVERLAY = ':is([data-slot="dialog-content"], [data-slot="sheet-content"], [role="dialog"][data-nav])[data-state="open"]:not([data-url-overlay])';

function sync() {
  const was = open;
  open = document.querySelectorAll(OVERLAY).length;
  if (open > 0) {
    window.clearTimeout(release);
    mark();
  } else if (was > 0) {
    // After the click that closed it has run: a link inside may be navigating, and a new overlay may be opening.
    window.clearTimeout(release);
    release = window.setTimeout(() => {
      if (open > 0 || !marked) return;
      unmark();
      leaving = true;
      History.prototype.back.call(history);
    });
  }
}

let watching: MutationObserver | null = null;

/**
 * Starts once, after the dashboard's first paint: overlays are noticed as
 * their portals come and go. Popstate reaches it through the listener added
 * before the router's (`popstate-before-router.ts`), so a Back that only
 * closes an overlay, or takes its entry off, never reaches the router.
 */
export function watchOverlaysForBack(routeHistory?: RouterHistory): void {
  if (watching) return;
  routerHistory = routeHistory;
  // Successful navigation and a rejected traversal both notify. A rejected
  // traversal still waits for its restoring popstate before onAcceptedPage.
  unsubscribe = routeHistory?.subscribe(scheduleSync);
  onPopStateBeforeRouter(onPopState);
  watching = new MutationObserver(sync);
  watching.observe(document.body, { childList: true });
  sync();
}

/** For tests: forget everything between cases. */
export function resetBackClosesForTest() {
  watching?.disconnect();
  watching = null;
  onPopStateBeforeRouter(undefined);
  window.clearTimeout(release);
  window.clearTimeout(reconcile);
  unsubscribe?.();
  unsubscribe = undefined;
  routerHistory = undefined;
  unmark();
  open = 0;
  leaving = false;
}
