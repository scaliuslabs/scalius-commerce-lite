// App pixels: an app's code that hears what buyers do (the buyer event
// catalog), on every page of the store, checkout and the receipt included.
// It is `src/pixel.ts`, declared by `storefront.pixel` in the manifest and
// built to `storefront/pixel.js`. The store runs it in a hidden sandboxed
// frame of its own: it cannot touch the page, the store's cookies or storage,
// or the buyer's account, and it reaches only the app's `storefront.connect`
// hosts (with `fetch`, `navigator.sendBeacon` or an image). It starts only
// once the buyer's consent allows its category, then hears the page's events
// from the start.
//
//   export default definePixel((pixel) => {
//     pixel.on("checkout_completed", (event) => {
//       navigator.sendBeacon("https://collect.example.com/e", JSON.stringify({
//         order: event.data.order.id,
//         total: event.data.checkout.total,
//         visitor: event.context.visitorId,
//       }));
//     });
//   });

import type { PixelApi, PixelModule } from "@scalius/shared/plugins/buyer-events";

export type {
  AnyBuyerEvent,
  AnyPixelEvent,
  BuyerAddress,
  BuyerCheckout,
  BuyerConsent,
  BuyerContact,
  BuyerEvent,
  BuyerEventContext,
  BuyerEventData,
  BuyerEventName,
  BuyerLine,
  BuyerMerchandise,
  BuyerMoney,
  PixelApi,
  PixelConsentCategory,
  PixelEvent,
  PixelEventName,
  PixelModule,
} from "@scalius/shared/plugins/buyer-events";
export { BUYER_EVENT_NAMES, PIXEL_EVENT_NAMES, experimentVariant } from "@scalius/shared/plugins/buyer-events";

/** A pixel's module: `setup` runs once in its frame, with the events it may hear. */
export function definePixel(setup: (pixel: PixelApi) => void): PixelModule {
  return { abi: 1, setup };
}
