// The page's buyer event bus (packages/shared/src/plugins/buyer-events.ts).
// Each event is emitted once, where it happens; the store's own tags, app
// islands and app pixels hear the same events. The bus keeps the page's
// events, so a listener that starts later (the store's tags once their code
// loads, a pixel once consent allows it) hears what already happened.
//
// It costs nothing to hear nothing: `page_viewed` is recorded only once
// something listens or emits, and the store's tags load only when a
// destination is on the page (lib/analytics.ts).

import {
  BUYER_EVENT_LIMITS,
  type AnyBuyerEvent,
  type BuyerEventData,
  type PixelEventName,
} from "@scalius/shared/plugins/buyer-events";

type Listener = (event: AnyBuyerEvent) => void;

const history: AnyBuyerEvent[] = [];
const listeners = new Set<Listener>();
let pageViewed = false;
let tagsLoading = false;
let consentWatched = false;

function newEventId(): string {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === "function") return webCrypto.randomUUID();
  const values = webCrypto.getRandomValues(new Uint32Array(4));
  return Array.from(values, (value) => value.toString(16).padStart(8, "0")).join("");
}

function keep(event: AnyBuyerEvent): void {
  history.push(event);
  if (history.length > BUYER_EVENT_LIMITS.history) history.splice(0, history.length - BUYER_EVENT_LIMITS.history);
}

/** Every page is viewed: the fact is recorded the first time it is needed, at the page's start. */
function recordPageView(): void {
  if (pageViewed) return;
  pageViewed = true;
  const start = typeof performance !== "undefined" && performance.timeOrigin ? performance.timeOrigin : Date.now();
  history.unshift({ id: newEventId(), name: "page_viewed", timestamp: new Date(start).toISOString(), data: {} });
}

/** Whether the page has a destination the store's own tags send to (a pixel, a tag manager, Zaraz or the server relay). */
function hasStoreDestination(): boolean {
  const page = window as Window & { fbq?: unknown; ttq?: unknown; dataLayer?: unknown; zaraz?: unknown };
  return typeof page.fbq === "function" || Boolean(page.ttq) || Array.isArray(page.dataLayer)
    || Boolean(page.zaraz) || window.__META_CAPI_BROWSER_EVENTS_ENABLED__ === true;
}

/** The store's tags (lib/analytics.ts) load on the first event a destination can hear, and hear the page's events from the start. */
function loadStoreTags(): void {
  if (!consentWatched) {
    // A tag the buyer's choice starts later (Meta, TikTok) still hears this page's events.
    consentWatched = true;
    window.addEventListener?.("scalius:consent", loadStoreTags);
  }
  if (tagsLoading || !hasStoreDestination()) return;
  tagsLoading = true;
  void import("../analytics").then(({ startStoreTags }) => startStoreTags(), () => {
    tagsLoading = false;
  });
}

/** Emits an event to every listener and keeps it for later ones. */
export function emitBuyerEvent<N extends PixelEventName>(name: N, data: BuyerEventData[N]): AnyBuyerEvent | null {
  if (typeof window === "undefined") return null;
  recordPageView();
  const event = { id: newEventId(), name, timestamp: new Date().toISOString(), data } as AnyBuyerEvent;
  keep(event);
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch (error) {
      console.warn("A buyer event listener failed", error);
    }
  }
  try {
    loadStoreTags();
  } catch (error) {
    // Hearing an event never breaks what the buyer did.
    console.warn("The store's tags did not load", error);
  }
  return event;
}

/** Calls `listener` for each event from now on (`replay`: the page's earlier events first); returns the unsubscribe. */
export function onBuyerEvents(listener: Listener, options: { replay?: boolean } = {}): () => void {
  if (typeof window === "undefined") return () => {};
  recordPageView();
  listeners.add(listener);
  if (options.replay) {
    for (const event of [...history]) {
      if (!listeners.has(listener)) break;
      try {
        listener(event);
      } catch (error) {
        console.warn("A buyer event listener failed", error);
      }
    }
  }
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam: forgets the page's events and listeners. */
export function resetBuyerEventsForTest(): void {
  history.length = 0;
  listeners.clear();
  pageViewed = false;
  tagsLoading = false;
}
