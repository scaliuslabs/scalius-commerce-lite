import { defineMessages, translate } from "./index";
import { kitLineRefusalMessages } from "./kit-line-refusals";

/**
 * The server's bundle (kit) and page-offer refusals (`details.reason`), as a
 * sentence a merchant reads beside the control that caused it. A leaf module:
 * the order, bulk-edit and product screens import it without the editor.
 */
export const productKitRefusalMessages = defineMessages({
  en: {
    kit_component_limit: "A bundle holds at most 20 different items. Remove one, or make a second bundle.",
    kit_component_duplicate: "An item is in this bundle twice. Keep it once and set its quantity.",
    kit_component_self: "A bundle can't include itself. Choose items of other SKUs.",
    kit_component_missing: "An item you chose was deleted. Choose another SKU.",
    kit_component_gift_card: "A gift card can't be in a bundle. Sell it on its own.",
    kit_component_nested: "A bundle can't include another bundle. Add that bundle's items instead.",
    kit_is_component: "This SKU is an item in another bundle, so it can't be a bundle itself. Take it out of that bundle first.",
    kit_gift_card: "A gift card can't be a bundle.",
    kit_has_stock: "A bundle has no stock of its own: its items carry it. Set this SKU's stock to 0 first.",
    kit_stock_movement: kitLineRefusalMessages.en.kit_stock_movement,
    kit_product_gift_card: "A SKU of this product is a bundle or in one, so the product can't be a gift card. Take it out of the bundle first.",
    kit_order_line: "A bundle is sold as its items. Add it to a staff order, which lists its items.",
    kit_variant_not_found: "This SKU is no longer part of this product. Reload the page.",
    kit_amended_in_part: kitLineRefusalMessages.en.kit_amended_in_part,
    kit_split_unsettled: "A bundle couldn't be priced right now. Remove it and add it again.",
    page_offer_limit: "A product page shows at most 20 offers from other products.",
    page_offer_duplicate: "An offer is listed twice. Keep it once.",
    page_offer_missing: "An offer you chose was deleted. Choose another SKU.",
    page_offer_own_sku: "This product's own SKUs already show on its page. Choose SKUs of other products.",
  },
  bn: {
    kit_component_limit: "একটি বান্ডেলে সর্বোচ্চ ২০টি আলাদা আইটেম থাকতে পারে। একটি সরান, অথবা আরেকটি বান্ডেল বানান।",
    kit_component_duplicate: "একটি আইটেম এই বান্ডেলে দুবার আছে। একবার রাখুন এবং তার পরিমাণ ঠিক করুন।",
    kit_component_self: "বান্ডেল নিজেকে ধারণ করতে পারে না। অন্য SKU-র আইটেম বেছে নিন।",
    kit_component_missing: "আপনার বেছে নেওয়া একটি আইটেম মুছে ফেলা হয়েছে। অন্য একটি SKU বেছে নিন।",
    kit_component_gift_card: "গিফট কার্ড বান্ডেলে রাখা যায় না। এটি আলাদাভাবে বিক্রি করুন।",
    kit_component_nested: "এক বান্ডেলে আরেকটি বান্ডেল রাখা যায় না। তার বদলে সেই বান্ডেলের আইটেমগুলো যোগ করুন।",
    kit_is_component: "এই SKU অন্য একটি বান্ডেলের আইটেম, তাই এটি নিজে বান্ডেল হতে পারে না। আগে সেই বান্ডেল থেকে এটি সরান।",
    kit_gift_card: "গিফট কার্ড বান্ডেল হতে পারে না।",
    kit_has_stock: "বান্ডেলের নিজের কোনো স্টক নেই: স্টক থাকে এর আইটেমগুলোর। আগে এই SKU-র স্টক ০ করুন।",
    kit_stock_movement: kitLineRefusalMessages.bn.kit_stock_movement,
    kit_product_gift_card: "এই পণ্যের একটি SKU বান্ডেল বা কোনো বান্ডেলের অংশ, তাই পণ্যটি গিফট কার্ড হতে পারে না। আগে বান্ডেল থেকে সরান।",
    kit_order_line: "বান্ডেল এর আইটেম হিসেবে বিক্রি হয়। স্টাফ অর্ডারে যোগ করুন, সেখানে এর আইটেমগুলো দেখা যায়।",
    kit_variant_not_found: "এই SKU আর এই পণ্যের অংশ নয়। পেজটি আবার লোড করুন।",
    kit_amended_in_part: kitLineRefusalMessages.bn.kit_amended_in_part,
    kit_split_unsettled: "এখন একটি বান্ডেলের দাম হিসাব করা গেল না। এটি সরিয়ে আবার যোগ করুন।",
    page_offer_limit: "একটি পণ্যের পেজে অন্য পণ্যের সর্বোচ্চ ২০টি অফার দেখানো যায়।",
    page_offer_duplicate: "একটি অফার দুবার আছে। একবার রাখুন।",
    page_offer_missing: "আপনার বেছে নেওয়া একটি অফার মুছে ফেলা হয়েছে। অন্য একটি SKU বেছে নিন।",
    page_offer_own_sku: "এই পণ্যের নিজের SKU আগে থেকেই এর পেজে দেখায়। অন্য পণ্যের SKU বেছে নিন।",
  },
});

export type ProductKitRefusalReason = keyof typeof productKitRefusalMessages.en;

/** True for a reason this catalog words. */
export function isProductKitRefusalReason(reason: unknown): reason is ProductKitRefusalReason {
  return typeof reason === "string" && Object.hasOwn(productKitRefusalMessages.en, reason);
}

/**
 * The refusal of a bundle or page-offer write (`details.reason`) with the
 * SKU it names (`details.variantId`), or null when the error is another kind.
 */
export function readProductKitRefusal(error: unknown): { reason: ProductKitRefusalReason; variantId: string | null; message: string } | null {
  const details = findDetails(error);
  if (!details || !isProductKitRefusalReason(details.reason)) return null;
  return {
    reason: details.reason,
    variantId: typeof details.variantId === "string" ? details.variantId : null,
    message: translate(productKitRefusalMessages, details.reason),
  };
}

function findDetails(value: unknown, depth = 0): { reason?: unknown; variantId?: unknown } | null {
  if (!value || typeof value !== "object" || depth > 3) return null;
  const candidate = value as { details?: unknown; cause?: unknown };
  if (candidate.details && typeof candidate.details === "object") return candidate.details as { reason?: unknown; variantId?: unknown };
  return findDetails(candidate.cause, depth + 1);
}
