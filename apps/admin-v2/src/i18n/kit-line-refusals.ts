import { readAdminApiError } from "~/lib/admin-api-error";
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

export type KitLineRefusalReason = keyof typeof kitLineRefusalMessages.en;

const isKitLineRefusalReason = (reason: unknown): reason is KitLineRefusalReason =>
  reason === "kit_stock_movement" || reason === "kit_amended_in_part";

/** The sentence for a reason (a row's `code`, a refusal's `details.reason`) when it is one of the two, else null. */
export function kitLineRefusalMessage(reason: unknown): string | null {
  return isKitLineRefusalReason(reason) ? translate(kitLineRefusalMessages, reason) : null;
}

/**
 * A failed write the server refused with one of the two reasons (`details.reason`),
 * with the order lines it names (`details.orderItemIds`, an amendment's), or null
 * for any other failure.
 */
export function readKitLineRefusal(error: unknown): { reason: KitLineRefusalReason; message: string; orderItemIds: string[] } | null {
  const details = readAdminApiError(error)?.details as { reason?: unknown; orderItemIds?: unknown } | null | undefined;
  if (!details || typeof details !== "object" || !isKitLineRefusalReason(details.reason)) return null;
  return {
    reason: details.reason,
    message: translate(kitLineRefusalMessages, details.reason),
    orderItemIds: Array.isArray(details.orderItemIds) ? details.orderItemIds.filter((id): id is string => typeof id === "string") : [],
  };
}
