import { storefrontLanguage } from "./storefront-copy";
import { pageLanguage } from "./store-time-zone";

/** Private cart consent snapshots. Names are display-only; only identities and quantities are sent. */
export interface SharedCartLine { productId: string; skuId: string; quantity: number }
export interface SharedCartProduct {
  productId: string;
  skuId: string;
  title: string;
  variantLabel: string | null;
  status: "available" | "sold_out" | "unavailable";
}
export interface ConversationCartShare {
  lines: SharedCartLine[];
  products?: SharedCartProduct[];
  sharedAt: number;
  withdrawnAt: number | null;
  version: number;
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;
export const CART_SHARE_LIMIT = 99;
const CART_SHARE_COPY_EN = {
  share: "Share my cart",
  consent: "Staff in this conversation will see these items and quantities. This won't update if your cart changes.",
  sent: "Cart shared. Staff aren't notified. Send a message if you'd like a reply.",
  empty: "Your cart is empty. Add items to share them.",
  emptyUpdate: "Your cart is empty. Stop sharing your previous cart?",
  limits: "You can share up to 99 products, with up to 99 of each. Adjust your cart to share it.",
  unchanged: "No changes since you last shared.",
  conflict: "Your shared cart changed in another window. Review and share again.",
  shareUnconfirmed: "Couldn't confirm your cart was shared.",
  stopUnconfirmed: "Couldn't confirm sharing stopped.",
  unavailable: "Some items can't be shared right now. Remove them from your cart and try again.",
  loadFailed: "Couldn't load your shared cart. Try again.",
  accountChanged: "Your account changed. Reload this conversation to share your cart.",
  dialogTitle: "Share your cart",
  update: "Update",
  stopSharing: "Stop sharing",
  snapshot: "Snapshot. Doesn't update with your cart.",
  tryAgain: "Try again",
  cancel: "Cancel",
  shareCart: "Share cart",
  updateShared: "Update shared cart",
  checking: "Checking…",
  checkingShared: "Checking shared cart…",
  notAvailable: "This conversation isn't available. Reload to check your access.",
  noLongerAvailable: "No longer available",
  quantity: "Qty {count}",
  stopped: "You stopped sharing your cart · {time}",
  shared: "Shared cart · {products} · {time}",
  products: { one: "{count} product", other: "{count} products" },
  items: { one: "{count} item", other: "{count} items" },
  confirmShare: "Share {products} ({items})?",
  confirmUpdate: "Update shared cart: {products} ({items})?",
  replaces: "This replaces what you shared at {time}.",
};

export type CartShareCopy = typeof CART_SHARE_COPY_EN;

const CART_SHARE_COPY_BN: CartShareCopy = {
  share: "আমার কার্ট শেয়ার করুন",
  consent: "এই কথোপকথনের স্টাফরা এই পণ্য ও পরিমাণগুলো দেখতে পাবেন। আপনার কার্ট বদলালেও এটি বদলাবে না।",
  sent: "কার্ট শেয়ার হয়েছে। স্টাফদের জানানো হয় না। উত্তর চাইলে একটি মেসেজ পাঠান।",
  empty: "আপনার কার্ট খালি। শেয়ার করতে পণ্য যোগ করুন।",
  emptyUpdate: "আপনার কার্ট খালি। আগের শেয়ার করা কার্টটি বন্ধ করবেন?",
  limits: "সর্বোচ্চ ৯৯টি পণ্য শেয়ার করা যায়, প্রতিটি ৯৯টি পর্যন্ত। শেয়ার করতে কার্টটি ঠিক করুন।",
  unchanged: "শেষবার শেয়ার করার পর কিছু বদলায়নি।",
  conflict: "অন্য একটি উইন্ডোতে আপনার শেয়ার করা কার্ট বদলেছে। দেখে আবার শেয়ার করুন।",
  shareUnconfirmed: "কার্ট শেয়ার হয়েছে কিনা নিশ্চিত করা যায়নি।",
  stopUnconfirmed: "শেয়ার বন্ধ হয়েছে কিনা নিশ্চিত করা যায়নি।",
  unavailable: "কিছু পণ্য এখন শেয়ার করা যাচ্ছে না। কার্ট থেকে সেগুলো সরিয়ে আবার চেষ্টা করুন।",
  loadFailed: "আপনার শেয়ার করা কার্ট লোড করা যায়নি। আবার চেষ্টা করুন।",
  accountChanged: "আপনার অ্যাকাউন্ট বদলেছে। কার্ট শেয়ার করতে কথোপকথনটি আবার লোড করুন।",
  dialogTitle: "আপনার কার্ট শেয়ার করুন",
  update: "আপডেট করুন",
  stopSharing: "শেয়ার বন্ধ করুন",
  snapshot: "এটি একটি স্ন্যাপশট। আপনার কার্টের সাথে বদলায় না।",
  tryAgain: "আবার চেষ্টা করুন",
  cancel: "বাতিল",
  shareCart: "কার্ট শেয়ার করুন",
  updateShared: "শেয়ার করা কার্ট আপডেট করুন",
  checking: "যাচাই করা হচ্ছে…",
  checkingShared: "শেয়ার করা কার্ট যাচাই করা হচ্ছে…",
  notAvailable: "এই কথোপকথনটি পাওয়া যাচ্ছে না। আপনার অ্যাক্সেস দেখতে পেজটি আবার লোড করুন।",
  noLongerAvailable: "আর পাওয়া যাচ্ছে না",
  quantity: "পরিমাণ {count}",
  stopped: "আপনি কার্ট শেয়ার বন্ধ করেছেন · {time}",
  shared: "শেয়ার করা কার্ট · {products} · {time}",
  products: { one: "{count}টি পণ্য", other: "{count}টি পণ্য" },
  items: { one: "{count}টি আইটেম", other: "{count}টি আইটেম" },
  confirmShare: "{products} ({items}) শেয়ার করবেন?",
  confirmUpdate: "শেয়ার করা কার্ট আপডেট করবেন: {products} ({items})?",
  replaces: "এটি {time}-এ শেয়ার করা কার্টের জায়গা নেবে।",
};

/** A shared cart's words in the page's language (Bangla on a Bangla page). */
export function cartShareCopy(language: string = pageLanguage()): CartShareCopy {
  return storefrontLanguage(language) === "bn" ? CART_SHARE_COPY_BN : CART_SHARE_COPY_EN;
}

export function validSharedCartLines(value: unknown): value is SharedCartLine[] {
  return Array.isArray(value) && value.length <= CART_SHARE_LIMIT && value.every((line) =>
    line && typeof line === "object" && typeof line.productId === "string" && ID.test(line.productId)
    && typeof line.skuId === "string" && ID.test(line.skuId)
    && Number.isInteger(line.quantity) && line.quantity >= 1 && line.quantity <= CART_SHARE_LIMIT,
  ) && new Set(value.map((line) => line.skuId)).size === value.length;
}

/** undefined is malformed/unavailable, while null is an authoritative never-shared answer. */
export function parseConversationCartShare(value: unknown): ConversationCartShare | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== "object") return undefined;
  const share = value as ConversationCartShare;
  if (!validSharedCartLines(share.lines) || !Number.isSafeInteger(share.version) || share.version < 1
    || !Number.isSafeInteger(share.sharedAt) || share.sharedAt < 0
    || (share.withdrawnAt !== null && (!Number.isSafeInteger(share.withdrawnAt) || share.withdrawnAt < 0 || share.lines.length > 0))) return undefined;
  const products = Array.isArray(share.products) ? share.products.filter((product) =>
    product && typeof product === "object" && typeof product.productId === "string" && ID.test(product.productId)
    && typeof product.skuId === "string" && ID.test(product.skuId)
    && typeof product.title === "string" && product.title.length <= 2_000
    && (product.variantLabel === null || (typeof product.variantLabel === "string" && product.variantLabel.length <= 2_000))
    && ["available", "sold_out", "unavailable"].includes(product.status)
    && share.lines.some((line) => line.productId === product.productId && line.skuId === product.skuId),
  ).slice(0, CART_SHARE_LIMIT).map(({ productId, skuId, title, variantLabel, status }) => ({ productId, skuId, title, variantLabel, status })) : undefined;
  return {
    lines: share.lines.map(({ productId, skuId, quantity }) => ({ productId, skuId, quantity })),
    ...(products ? { products } : {}), sharedAt: share.sharedAt, withdrawnAt: share.withdrawnAt, version: share.version,
  };
}

export function sameSharedCartLines(a: readonly SharedCartLine[], b: readonly SharedCartLine[]): boolean {
  return a.length === b.length && a.every((line) => b.some((other) =>
    line.productId === other.productId && line.skuId === other.skuId && line.quantity === other.quantity,
  ));
}
