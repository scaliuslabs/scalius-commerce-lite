// App pixels on the page (packages/shared/src/plugins/buyer-events.ts): loaded
// only when the layout names at least one (BuyerPixels.astro writes the list
// and this module's script), so a store without pixel apps loads none of it.
//
// Each pixel gets a hidden frame of its own, created only once the buyer's
// consent allows the pixel's category and removed when it is withdrawn. The
// frame hears the page's events from the start (the bus keeps them), each
// projected for the app: its own app events only, and contact fields only
// with its protected data scopes. Everything after the first connect message
// goes over a private MessageChannel port, so no other window can talk to it.

import { getCurrencyCode } from "@scalius/shared/currency";
import { trackingPageUrl } from "@scalius/shared/tracking-url";
import {
  PIXEL_CONNECT_MESSAGE,
  PIXEL_CONSENT_CATEGORIES,
  isPixelEventName,
  projectBuyerEvent,
  type AnyBuyerEvent,
  type BuyerEventContext,
  type PixelHostMessage,
  type StorefrontAppPixel,
} from "@scalius/shared/plugins/buyer-events";
import { PROTECTED_CUSTOMER_DATA, type ProtectedCustomerData } from "@scalius/shared/plugins/protected-data";
import { consentAllows } from "../tracking/consent";
import { onBuyerEvents } from "./bus";
import { visitorId } from "./visitor";

/** A pixel as the page lists it: the layout's entry and its frame's URL. */
export type PagePixel = StorefrontAppPixel & { frame: string };

export const PIXELS_ELEMENT_ID = "scalius-pixels";

/** The page's pixel list, shape-checked; anything malformed is left out. */
export function readPagePixels(value: unknown): PagePixel[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): PagePixel[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const pixel = entry as Partial<PagePixel>;
    if (typeof pixel.pluginId !== "string" || typeof pixel.frame !== "string" || !pixel.frame.startsWith(`/_x/${pixel.pluginId}/`)) return [];
    if (!(PIXEL_CONSENT_CATEGORIES as readonly unknown[]).includes(pixel.consent)) return [];
    const events = Array.isArray(pixel.events) ? pixel.events.filter(isPixelEventName) : [];
    const protectedData = Array.isArray(pixel.protectedData)
      ? pixel.protectedData.filter((item): item is ProtectedCustomerData => (PROTECTED_CUSTOMER_DATA as readonly unknown[]).includes(item))
      : [];
    const settings = typeof pixel.settings === "object" && pixel.settings !== null && !Array.isArray(pixel.settings) ? pixel.settings : {};
    return [{ ...pixel, events, protectedData, settings, connect: [], release: String(pixel.release ?? "") } as PagePixel];
  });
}

function pageContext(): BuyerEventContext {
  return {
    page: {
      url: trackingPageUrl(location.href) ?? `${location.origin}/`,
      path: location.pathname,
      title: document.title.slice(0, 200),
      referrer: document.referrer ? trackingPageUrl(document.referrer) ?? "" : "",
    },
    language: document.documentElement.lang || "en",
    currency: getCurrencyCode(),
    visitorId: visitorId(),
  };
}

function consentNow() {
  return { analytics: consentAllows("analytics"), marketing: consentAllows("marketing"), saleOfData: window.__scaliusConsent?.saleOfData !== false };
}

/** One pixel's frame: mounted while consent allows it. */
class PixelFrame {
  readonly #pixel: PagePixel;
  readonly #granted: ReadonlySet<ProtectedCustomerData>;
  readonly #events: ReadonlySet<string>;
  #frame: HTMLIFrameElement | null = null;
  #port: MessagePort | null = null;
  #queue: PixelHostMessage[] | null = null;
  #stop: (() => void) | null = null;

  constructor(pixel: PagePixel) {
    this.#pixel = pixel;
    this.#granted = new Set(pixel.protectedData);
    this.#events = new Set(pixel.events);
  }

  get mounted(): boolean {
    return this.#frame !== null;
  }

  sync(): void {
    const allowed = consentAllows(this.#pixel.consent);
    if (allowed && !this.#frame) this.#mount();
    else if (!allowed && this.#frame) this.#unmount();
  }

  #send(message: PixelHostMessage): void {
    if (this.#queue) this.#queue.push(message);
    else this.#port?.postMessage(message);
  }

  #deliver(event: AnyBuyerEvent): void {
    if (!this.#events.has(event.name)) return;
    if (event.name === "app_event" && event.data.app !== this.#pixel.pluginId) return;
    const projected = projectBuyerEvent(event, this.#granted);
    this.#send({ type: "event", event: { ...projected, context: pageContext() } as Extract<PixelHostMessage, { type: "event" }>["event"] });
  }

  #mount(): void {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    frame.title = "";
    frame.hidden = true;
    frame.dataset.scaliusPixel = this.#pixel.pluginId;
    frame.src = this.#pixel.frame;
    const channel = new MessageChannel();
    this.#frame = frame;
    this.#port = channel.port1;
    this.#queue = [];
    this.#send({
      type: "init",
      pluginId: this.#pixel.pluginId,
      settings: { ...this.#pixel.settings },
      consent: consentNow(),
      visitorId: visitorId(),
      events: [...this.#pixel.events],
    });
    frame.addEventListener("load", () => {
      if (this.#frame !== frame || !frame.contentWindow) return;
      // An opaque-origin frame can only be addressed with "*"; the port it receives is the only channel after this.
      frame.contentWindow.postMessage({ type: PIXEL_CONNECT_MESSAGE }, "*", [channel.port2]);
      const queued = this.#queue ?? [];
      this.#queue = null;
      for (const message of queued) channel.port1.postMessage(message);
    }, { once: true });
    document.body.append(frame);
    this.#stop = onBuyerEvents((event) => this.#deliver(event), { replay: true });
  }

  #unmount(): void {
    this.#stop?.();
    this.#stop = null;
    this.#port?.close();
    this.#port = null;
    this.#queue = null;
    this.#frame?.remove();
    this.#frame = null;
  }
}

let frames: PixelFrame[] | null = null;

/** Starts the page's pixels (once): each mounts when consent allows it, now or when the buyer chooses. */
export function startPixels(pixels: PagePixel[] = readPagePixelsFromPage()): PixelFrame[] {
  if (frames) return frames;
  frames = pixels.map((pixel) => new PixelFrame(pixel));
  const sync = () => {
    for (const frame of frames ?? []) frame.sync();
  };
  window.addEventListener("scalius:consent", sync);
  sync();
  return frames;
}

function readPagePixelsFromPage(): PagePixel[] {
  try {
    return readPagePixels(JSON.parse(document.getElementById(PIXELS_ELEMENT_ID)?.textContent ?? "[]"));
  } catch {
    return [];
  }
}

/** Test seam. */
export function resetPixelsForTest(): void {
  frames = null;
}
