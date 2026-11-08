// Client islands: the only app JavaScript a storefront page runs. An island
// is `src/islands/<name>.ts`, declared in `storefront.islands` and placed by
// `<Island name="…">` in a component's markup. Its module loads when the
// island's `hydrate` moment comes (visible by default) and mounts on the
// server-rendered element, so the page works before and without it.
//
//   export default defineIsland<{ slides: number }>((element, props, context) => {
//     const next = element.querySelector("[data-next]");
//     …
//     return () => { /* cleanup */ };
//   });

import {
  STOREFRONT_COMPONENT_ABI,
  type StorefrontIslandContext,
  type StorefrontIslandModule,
} from "@scalius/shared/plugins/storefront-protocol";

export type { StorefrontIslandContext as IslandContext };
export type { StorefrontSearchSuggestion as SearchSuggestion } from "@scalius/shared/plugins/storefront-protocol";
export { STOREFRONT_SEARCH_SUGGESTIONS_MAX } from "@scalius/shared/plugins/storefront-protocol";
export type { StorefrontIslandEvents as IslandEvents } from "@scalius/shared/plugins/storefront-protocol";
export type { BuyerEvent, BuyerEventData, BuyerEventName, PixelEventName } from "@scalius/shared/plugins/buyer-events";
/** A visitor's variant of an experiment (`context.visitorId()`): the same answer in the island and the app's pixel. */
export { experimentVariant } from "@scalius/shared/plugins/buyer-events";

export function defineIsland<Props = unknown>(
  mount: (element: HTMLElement, props: Props, context: StorefrontIslandContext) => void | (() => void),
): StorefrontIslandModule<Props> {
  return { abi: STOREFRONT_COMPONENT_ABI, mount };
}
