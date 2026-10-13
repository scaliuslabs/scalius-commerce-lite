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
export const CART_SHARE_COPY = {
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
} as const;

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
