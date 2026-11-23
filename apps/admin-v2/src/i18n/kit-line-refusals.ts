import { isKitLineRefusalReason, kitLineRefusalOf, type KitLineRefusalReason } from "~/lib/kit-line-refusal-reason";
import { defineMessages, translate } from "./index";

/**
 * The two bundle (kit) refusals a screen that writes stock or amends an
 * order meets: a stock count on a bundle, and a bundle's lines changed in
 * part. A leaf the order form, bulk edit, inventory and scanner import
 * without the product editor's whole catalog (`product-kit-refusals.ts`
 * spreads these same sentences, so each is worded once).
 */
export const kitLineRefusalMessages = defineMessages({
  en: {
    kit_stock_movement: "This SKU is a bundle, so it has no stock of its own. Change its items' stock instead.",
    kit_amended_in_part: "This is a bundle: change all its items together, in whole bundles, or remove all of them.",
  },
  bn: {
    kit_stock_movement: "এই SKU একটি বান্ডেল, তাই এর নিজের কোনো স্টক নেই। এর আইটেমগুলোর স্টক বদলান।",
    kit_amended_in_part: "এটি একটি বান্ডেল: এর সব আইটেম একসাথে, পুরো বান্ডেল ধরে বদলান, অথবা সবগুলো সরান।",
  },
});

/** The sentence for a reason (a row's `code`, a refusal's `details.reason`) when it is one of the two, else null. */
export function kitLineRefusalMessage(reason: unknown): string | null {
  return isKitLineRefusalReason(reason) ? translate(kitLineRefusalMessages, reason) : null;
}

/** A failed write refused with one of the two reasons, in the dashboard's words, with the lines it names; else null. */
export function readKitLineRefusal(error: unknown): { reason: KitLineRefusalReason; message: string; orderItemIds: string[] } | null {
  const refusal = kitLineRefusalOf(error);
  return refusal ? { ...refusal, message: translate(kitLineRefusalMessages, refusal.reason) } : null;
}
