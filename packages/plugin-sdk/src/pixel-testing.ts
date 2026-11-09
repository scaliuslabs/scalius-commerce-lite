// A pixel test harness (`createPixelTestHarness` in `@scalius/plugin-sdk/testing`):
// the store's pixel frame (apps/storefront/src/lib/buyer-events/pixel-frame.ts)
// in memory. It starts the pixel only when the buyer's consent allows its
// category, hands it the settings its manifest names and only the events it
// subscribes to, each as the store projects it for the app's scopes (no email
// without read_customer_emails), and records every request it makes. A
// request to a host outside `storefront.connect` is blocked, as the frame's
// policy blocks it in the browser.
//
//   const pixel = createPixelTestHarness(app, pixelModule, { settings: { account_id: "acc_1" } });
//   pixel.emit(fixtures.buyerEvent("checkout_completed"));
//   expect(pixel.requests).toEqual([{ via: "beacon", url: "https://collect.example.com/e", body: expect.any(String) }]);

import {
  PIXEL_EVENT_NAMES,
  projectBuyerEvent,
  type AnyBuyerEvent,
  type AnyPixelEvent,
  type BuyerConsent,
  type BuyerEvent,
  type BuyerEventContext,
  type PixelApi,
  type PixelEventName,
  type PixelModule,
} from "@scalius/shared/plugins/buyer-events";
import { isPluginHostAllowed, parsePluginManifest, type PluginManifest } from "@scalius/shared/plugins";
import { PLUGIN_SCOPES, type PluginScope, type PluginScopeDefinition } from "@scalius/shared/plugins/scopes";
import type { ProtectedCustomerData } from "@scalius/shared/plugins/protected-data";

export interface PixelTestHarnessOptions {
  /** The merchant's settings; the pixel gets only those `storefront.pixel.settings` names (defaults fill the rest). */
  settings?: Record<string, string | number | boolean | null>;
  /** The buyer's consent (default: everything allowed). The pixel starts only when its category is allowed. */
  consent?: Partial<BuyerConsent>;
  /** The visitor id with analytics consent (default `vis_test_1`); null without it, as on the store. */
  visitorId?: string;
  /** The page every event happens on, merged over a product page of a BDT store in English. */
  context?: Partial<Omit<BuyerEventContext, "visitorId">>;
}

/** One request the pixel made: `blocked` when its host is not one of the app's `storefront.connect` hosts. */
export interface PixelTestRequest {
  via: "beacon" | "fetch" | "image";
  url: string;
  body: string | null;
  blocked: boolean;
}

const DEFAULT_CONTEXT: Omit<BuyerEventContext, "visitorId"> = {
  page: { url: "https://shop.example/products/t-shirt", path: "/products/t-shirt", title: "T-shirt", referrer: "" },
  language: "en",
  currency: "BDT",
};

function bodyText(body: unknown): string | null {
  if (body === undefined || body === null) return null;
  return typeof body === "string" ? body : String(body);
}

/**
 * Runs an app's pixel the way the store's frame does. `app` is the app module
 * (or its manifest holder) and `pixel` its `src/pixel.ts` default export.
 */
export function createPixelTestHarness(app: unknown, pixel: PixelModule, options: PixelTestHarnessOptions = {}) {
  const definition = (app as { default?: { manifest?: unknown } })?.default ?? (app as { manifest?: unknown });
  const parsed = parsePluginManifest(definition?.manifest);
  if (!parsed.ok) throw new Error(`Invalid manifest: ${parsed.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
  const manifest: PluginManifest = parsed.manifest;
  const declared = manifest.storefront.pixel;
  if (!declared) throw new Error("The manifest declares no storefront.pixel.");
  if (pixel?.abi !== 1 || typeof pixel.setup !== "function") throw new Error("The pixel module has no definePixel(...) default export.");

  const consent: BuyerConsent = { analytics: true, marketing: true, saleOfData: true, ...options.consent };
  const visitorId = consent.analytics ? options.visitorId ?? "vis_test_1" : null;
  const events = new Set<PixelEventName>(declared.events ?? PIXEL_EVENT_NAMES);
  const granted = new Set((manifest.scopes as PluginScope[])
    .map((scope) => (PLUGIN_SCOPES[scope] as PluginScopeDefinition | undefined)?.protects)
    .filter((data): data is ProtectedCustomerData => data !== undefined));
  const settings = Object.fromEntries(declared.settings.map((key) => {
    const field = manifest.settings.find((setting) => setting.key === key);
    const value = options.settings?.[key] ?? (field && "default" in field ? field.default as string | number | boolean | null | undefined : undefined) ?? null;
    return [key, value];
  }));
  const context: BuyerEventContext = { ...DEFAULT_CONTEXT, ...options.context, page: { ...DEFAULT_CONTEXT.page, ...options.context?.page }, visitorId };

  const requests: PixelTestRequest[] = [];
  const errors: unknown[] = [];
  const listeners = new Map<string, Array<(event: AnyPixelEvent) => void>>();
  const allowed = (url: string) => {
    try {
      const parsedUrl = new URL(url);
      return parsedUrl.protocol === "https:" && isPluginHostAllowed(parsedUrl.hostname, manifest.storefront.connect, parsedUrl.port);
    } catch {
      return false;
    }
  };
  const record = (via: PixelTestRequest["via"], url: unknown, body: unknown) => {
    const href = String(url);
    const blocked = !allowed(href);
    requests.push({ via, url: href, body: bodyText(body), blocked });
    return !blocked;
  };

  /** Runs `work` with the frame's network: beacons, fetch and images reach only the connect hosts, and every one is recorded. */
  const inFrame = (work: () => void) => {
    const scope = globalThis as Record<string, unknown>;
    const saved = { navigator: Object.getOwnPropertyDescriptor(scope, "navigator"), fetch: scope.fetch, Image: scope.Image };
    Object.defineProperty(scope, "navigator", {
      configurable: true,
      value: { ...(saved.navigator?.value as object | undefined), sendBeacon: (url: unknown, body?: unknown) => record("beacon", url, body) },
    });
    scope.fetch = (input: unknown, init?: { body?: unknown }) => {
      const url = typeof input === "string" || input instanceof URL ? String(input) : String((input as { url?: unknown })?.url);
      return record("fetch", url, init?.body)
        ? Promise.resolve(new Response(null, { status: 204 }))
        : Promise.reject(new TypeError(`Refused to connect to ${url}: not one of the app's storefront.connect hosts.`));
    };
    scope.Image = class {
      set src(url: string) {
        record("image", url, null);
      }
    };
    try {
      work();
    } finally {
      if (saved.navigator) Object.defineProperty(scope, "navigator", saved.navigator);
      else delete scope.navigator;
      scope.fetch = saved.fetch;
      scope.Image = saved.Image;
    }
  };

  const running = consent[declared.consent];
  if (running) {
    const api: PixelApi = Object.freeze({
      pluginId: manifest.id,
      settings: Object.freeze({ ...settings }),
      consent: Object.freeze({ ...consent }),
      visitorId: () => visitorId,
      on: (name: string, listener: (event: AnyPixelEvent) => void) => {
        if (typeof listener !== "function") return () => undefined;
        listeners.set(name, [...(listeners.get(name) ?? []), listener]);
        return () => listeners.set(name, (listeners.get(name) ?? []).filter((entry) => entry !== listener));
      },
    }) as PixelApi;
    inFrame(() => {
      try {
        pixel.setup(api);
      } catch (error) {
        errors.push(error);
      }
    });
  }

  return {
    manifest,
    /** Whether the pixel started: the buyer's consent allows its `storefront.pixel.consent` category. */
    running,
    /** The settings it got: only the ones `storefront.pixel.settings` names, never a secret. */
    settings,
    /** Every beacon, fetch and image request it made, in order; `blocked` ones never left the frame. */
    requests,
    /** What its setup or a listener threw (the frame logs it and goes on). */
    errors,
    /**
     * Hands it one buyer event (build one with `fixtures.buyerEvent`), as
     * the store does: only an event its manifest subscribes to, with the
     * page's context, without the contact fields its scopes do not reveal.
     * Returns whether a listener heard it.
     */
    emit(event: BuyerEvent | AnyBuyerEvent): boolean {
      if (!running || !events.has(event.name)) return false;
      const delivered = { ...projectBuyerEvent(event as BuyerEvent, granted), context } as AnyPixelEvent;
      const heard = [...(listeners.get(event.name) ?? []), ...(listeners.get("*") ?? [])];
      inFrame(() => {
        for (const listener of heard) {
          try {
            listener(delivered);
          } catch (error) {
            errors.push(error);
          }
        }
      });
      return heard.length > 0;
    },
  };
}
