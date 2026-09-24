import { map } from "nanostores";
import {
  normalizeCartItemOptions,
  type CartItemOption,
} from "@/lib/cart/item-options";

export type { CartItemOption } from "@/lib/cart/item-options";

export type CartItem = {
  id: string;
  slug?: string;
  name: string;
  price: number;
  quantity: number;
  image?: string;
  /** Actual image/poster Media asset identity; never a video asset. */
  imageMediaId?: string;
  variantId?: string;
  options?: CartItemOption[];
  freeDelivery?: boolean;
};

export type VariantCartItem = CartItem & { variantId: string };

export type CartStore = {
  items: Record<string, VariantCartItem>;
  totalItems: number;
  totalAmount: number;
  /**
   * Discount codes the buyer applied. Only codes live here: every amount comes
   * from the server quote, so codes survive cart edits and are re-checked.
   */
  discountCodes: string[];
};

type CartAbsoluteQuantityPatch = {
  lineKey: string;
  productId: string;
  variantId: string;
  quantity: number;
  /** Required only when the exact line does not yet exist. */
  item?: Omit<CartItem, "quantity">;
};

type CartLinePatchFailureCode =
  | "invalid_patch_count"
  | "duplicate_line_key"
  | "invalid_line_key"
  | "line_not_found"
  | "invalid_product"
  | "invalid_variant"
  | "invalid_quantity"
  | "item_not_allowed"
  | "item_required";

type CartLinePatchFailure = {
  ok: false;
  code: CartLinePatchFailureCode;
};

type CartLinePatchSuccess = {
  ok: true;
  state: CartStore;
};

type CartLinePatchResult = CartLinePatchFailure | CartLinePatchSuccess;

export type CartLineItemUpdate = {
  lineKey: string;
  updates: Partial<
    Pick<CartItem, "name" | "price" | "quantity" | "image" | "imageMediaId" | "freeDelivery">
  >;
};

export const MAX_CART_QUANTITY = 99;
/** Mirrors the API's `MAX_SUBMITTED_DISCOUNT_CODES`. */
export const MAX_DISCOUNT_CODES = 5;
const DISCOUNT_CODE_PATTERN = /^[A-Z0-9_-]{1,50}$/;
const MAX_CART_LINE_PATCHES = 100;

const MAX_CART_ID_LENGTH = 160;
const MAX_CART_LINE_KEY_LENGTH = 512;

const EMPTY_CART_STATE: CartStore = {
  items: {},
  totalItems: 0,
  totalAmount: 0,
  discountCodes: [],
};

let hasHydratedFromStorage = false;
let canPersistToStorage = false;

export const cartStore = map<CartStore>({ ...EMPTY_CART_STATE });

type ShippingFeeCartItem = Pick<CartItem, "freeDelivery"> & Partial<Pick<CartItem, "price" | "quantity">>;

export function cartHasFreeDeliveryItem(
  items: Record<string, ShippingFeeCartItem>,
): boolean {
  return Object.values(items).some((item) => item.freeDelivery === true);
}

/** The items subtotal before discounts, which a rate's free-over threshold is measured against. */
export function cartItemsSubtotal(items: Record<string, ShippingFeeCartItem>): number {
  const total = Object.values(items).reduce(
    (sum, item) => sum + (Number(item.price) || 0) * (Number(item.quantity) || 0),
    0,
  );
  return Math.round(total * 100) / 100;
}

/**
 * What the buyer pays for the chosen rate: nothing when a cart item waives
 * delivery or the items subtotal reaches the rate's free-over threshold
 * (the checkout applies the same rule authoritatively).
 */
export function getEffectiveCartShippingFee(
  items: Record<string, ShippingFeeCartItem>,
  methodFee: number,
  freeOver: number | null = null,
): number {
  const normalizedMethodFee = Number.isFinite(methodFee)
    ? Math.max(0, methodFee)
    : 0;
  if (cartHasFreeDeliveryItem(items)) return 0;
  if (freeOver !== null && Number.isFinite(freeOver) && cartItemsSubtotal(items) >= freeOver) return 0;
  return normalizedMethodFee;
}

if (typeof window !== "undefined") {
  cartStore.subscribe((state) => {
    if (!canPersistToStorage) return;
    try {
      const json = JSON.stringify(state);
      if (localStorage.getItem("cart") !== json) localStorage.setItem("cart", json);
    } catch (error) {
      console.warn("Could not persist cart state.", error);
    }
  });
  // Another tab changed the cart (an order, an add, a removal): follow it, so
  // this tab never writes its older copy back over the newer one.
  window.addEventListener?.("storage", (event) => {
    if (event.key === "cart" && hasHydratedFromStorage) readCartFromStorage(true);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeStoredCartItem(value: unknown): VariantCartItem | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || typeof value.name !== "string") return null;

  const id = value.id.trim();
  const name = value.name.trim().slice(0, MAX_CART_ID_LENGTH);
  const variantId =
    typeof value.variantId === "string" ? value.variantId.trim() : "";
  if (
    !id ||
    id.length > MAX_CART_ID_LENGTH ||
    !name ||
    !variantId ||
    variantId === "default" ||
    variantId.length > MAX_CART_ID_LENGTH
  ) {
    return null;
  }

  return {
    id,
    slug: typeof value.slug === "string" ? value.slug : undefined,
    name,
    price: Math.max(0, toNumber(value.price)),
    quantity: Math.min(
      MAX_CART_QUANTITY,
      Math.max(1, Math.floor(toNumber(value.quantity, 1))),
    ),
    image: typeof value.image === "string" ? value.image : undefined,
    imageMediaId:
      typeof value.imageMediaId === "string" && value.imageMediaId.trim()
        ? value.imageMediaId.trim()
        : undefined,
    variantId,
    options: normalizeCartItemOptions(value.options),
    freeDelivery:
      typeof value.freeDelivery === "boolean" ? value.freeDelivery : undefined,
  };
}

/** Upper-cased, de-duplicated, well-formed codes, at most `MAX_DISCOUNT_CODES`. */
export function normalizeDiscountCodes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const codes = value
    .filter((code): code is string => typeof code === "string")
    .map((code) => code.trim().toUpperCase())
    .filter((code) => DISCOUNT_CODE_PATTERN.test(code));
  return [...new Set(codes)].slice(0, MAX_DISCOUNT_CODES);
}

function normalizeCartTotals(state: CartStore): CartStore {
  const items = Object.values(state.items);
  const totalItems = items.reduce((total, item) => total + item.quantity, 0);
  return {
    ...state,
    totalItems,
    totalAmount: items.reduce(
      (total, item) => total + item.price * item.quantity,
      0,
    ),
    discountCodes: totalItems === 0 ? [] : state.discountCodes,
  };
}

export function normalizeStoredCart(value: unknown): CartStore {
  if (!isRecord(value) || !isRecord(value.items)) {
    return { ...EMPTY_CART_STATE };
  }

  const items: Record<string, VariantCartItem> = {};
  for (const item of Object.values(value.items)) {
    const normalized = normalizeStoredCartItem(item);
    if (!normalized) continue;
    const key = createCartItemKey(normalized);
    const existing = items[key];
    items[key] = existing
      ? {
          ...existing,
          quantity: Math.min(
            MAX_CART_QUANTITY,
            existing.quantity + normalized.quantity,
          ),
        }
      : normalized;
  }

  return normalizeCartTotals({
    items,
    totalItems: 0,
    totalAmount: 0,
    discountCodes: normalizeDiscountCodes(value.discountCodes),
  });
}

export function hydrateCartFromStorage(): CartStore {
  if (typeof window === "undefined") return cartStore.get();
  if (hasHydratedFromStorage) return cartStore.get();

  return readCartFromStorage(false);
}

/**
 * Reconcile the in-memory cart with durable browser storage.
 *
 * This is intentionally separate from one-time hydration because a document
 * restored from the back-forward cache can have an older Nanostore snapshot
 * than localStorage (for example, after a completed checkout cleared the cart
 * on the receipt page).
 */
export function syncCartFromStorage(): CartStore {
  if (typeof window === "undefined") return cartStore.get();

  return readCartFromStorage(true);
}

function readCartFromStorage(resetWhenMissing: boolean): CartStore {
  if (typeof window === "undefined") return cartStore.get();

  if (
    typeof localStorage === "undefined" ||
    typeof localStorage.getItem !== "function" ||
    typeof localStorage.setItem !== "function"
  ) {
    hasHydratedFromStorage = true;
    return cartStore.get();
  }

  hasHydratedFromStorage = true;
  try {
    const storedCart = localStorage.getItem("cart");
    if (storedCart) {
      const normalized = normalizeStoredCart(JSON.parse(storedCart));
      if (JSON.stringify(normalized) !== JSON.stringify(cartStore.get())) cartStore.set(normalized);
      const normalizedJson = JSON.stringify(normalized);
      if (normalizedJson !== storedCart) {
        try {
          localStorage.setItem("cart", normalizedJson);
        } catch (error) {
          console.warn("Could not persist migrated cart state.", error);
        }
      }
    } else if (resetWhenMissing && Object.keys(cartStore.get().items).length > 0) {
      cartStore.set({ ...EMPTY_CART_STATE });
    }
  } catch (error) {
    console.warn("Could not hydrate cart state.", error);
    cartStore.set({ ...EMPTY_CART_STATE });
  } finally {
    canPersistToStorage = true;
  }

  if (typeof document !== "undefined") {
    document.dispatchEvent(new CustomEvent("cart-updated"));
  }

  return cartStore.get();
}

function ensureCartHydrated(): void {
  if (typeof window !== "undefined") {
    hydrateCartFromStorage();
  }
}

function emitCartUpdated(): void {
  if (typeof document !== "undefined") {
    document.dispatchEvent(new CustomEvent("cart-updated"));
  }
}

/**
 * Produces the stable exact key used by the v2 local cart contract. Hydration
 * canonicalizes pre-v2 browser snapshots into this key space once.
 */
export function createCartItemKey(
  item: { id: string; variantId: string },
): string {
  const productPart = encodeURIComponent(item.id.trim());
  const variantId = item.variantId.trim();
  if (!productPart || !variantId || variantId === "default") {
    throw new TypeError("Cart lines require persisted product and variant IDs.");
  }
  return `line:v2:${productPart}:variant:${encodeURIComponent(variantId)}`;
}

function commitNonLineCartState(state: CartStore): CartStore {
  const next = normalizeCartTotals(state);
  cartStore.set(next);
  emitCartUpdated();
  return next;
}

function applyLocalLinePatch(
  patches: CartAbsoluteQuantityPatch[],
  trustedExistingItemReplacements?: ReadonlyMap<
    string,
    Omit<CartItem, "quantity">
  >,
): CartLinePatchResult {
  return applyLinePatchesToLiveStore(patches, trustedExistingItemReplacements);
}

export function addToCart(
  item: Omit<CartItem, "quantity"> & { quantity?: number },
): boolean {
  ensureCartHydrated();
  const variantId = item.variantId;
  if (
    !isValidIdentity(item.id) ||
    !isValidIdentity(variantId) ||
    variantId === "default"
  ) {
    return false;
  }
  const current = cartStore.get();
  const itemKey = createCartItemKey({ id: item.id, variantId });
  const existingItem = current.items[itemKey];
  const requestedQuantity = Math.min(
    MAX_CART_QUANTITY,
    Math.max(1, Math.floor(toNumber(item.quantity, 1))),
  );
  const quantity = existingItem
    ? Math.min(MAX_CART_QUANTITY, existingItem.quantity + requestedQuantity)
    : requestedQuantity;
  const options = normalizeCartItemOptions(item.options);
  const normalizedItem: Omit<CartItem, "quantity"> = {
    ...item,
    variantId,
    ...(options ? { options } : { options: undefined }),
  };

  return applyLocalLinePatch([
    {
      lineKey: itemKey,
      productId: item.id,
      variantId,
      quantity,
      ...(!existingItem ? { item: normalizedItem } : {}),
    },
  ]).ok;
}

export function removeCartItemByKey(itemKey: string): boolean {
  ensureCartHydrated();
  const current = cartStore.get();
  const item = current.items[itemKey];
  if (
    !item ||
    !isValidIdentity(item.variantId) ||
    item.variantId === "default"
  ) {
    return false;
  }

  return applyLocalLinePatch([
    {
      lineKey: itemKey,
      productId: item.id,
      variantId: item.variantId,
      quantity: 0,
    },
  ]).ok;
}

export function updateCartItemByKey(
  itemKey: string,
  updates: Partial<
    Pick<CartItem, "name" | "price" | "quantity" | "image" | "imageMediaId" | "freeDelivery">
  >,
): boolean {
  return updateCartItemsByKeyAtomically([{ lineKey: itemKey, updates }]);
}

export function updateCartItemsByKeyAtomically(
  updatesByLine: CartLineItemUpdate[],
): boolean {
  ensureCartHydrated();
  const current = cartStore.get();
  if (
    !Array.isArray(updatesByLine) ||
    updatesByLine.length < 1 ||
    updatesByLine.length > MAX_CART_LINE_PATCHES
  ) {
    return false;
  }

  const patches: CartAbsoluteQuantityPatch[] = [];
  const replacements = new Map<string, Omit<CartItem, "quantity">>();
  for (const { lineKey, updates } of updatesByLine) {
    const existingItem = current.items[lineKey];
    if (
      !existingItem ||
      !isValidIdentity(existingItem.variantId) ||
      existingItem.variantId === "default"
    ) {
      return false;
    }
    if (
      updates.quantity !== undefined &&
      (!Number.isInteger(updates.quantity) ||
        updates.quantity < 1 ||
        updates.quantity > MAX_CART_QUANTITY)
    ) {
      return false;
    }
    const quantity = updates.quantity ?? existingItem.quantity;
    const refreshed = { ...existingItem, ...updates, quantity };
    const refreshedItem: Omit<CartItem, "quantity"> = {
      id: refreshed.id,
      ...(refreshed.slug ? { slug: refreshed.slug } : {}),
      name: refreshed.name,
      price: refreshed.price,
      ...(refreshed.image ? { image: refreshed.image } : {}),
      ...(refreshed.imageMediaId ? { imageMediaId: refreshed.imageMediaId } : {}),
      variantId: existingItem.variantId,
      ...(refreshed.options ? { options: refreshed.options } : {}),
      ...(refreshed.freeDelivery !== undefined
        ? { freeDelivery: refreshed.freeDelivery }
        : {}),
    };
    patches.push({
      lineKey,
      productId: existingItem.id,
      variantId: existingItem.variantId,
      quantity,
    });
    replacements.set(lineKey, refreshedItem);
  }
  return applyLocalLinePatch(patches, replacements).ok;
}

/** Keeps a code the buyer applied; the server quote decides what it is worth. */
export function addDiscountCode(code: string): boolean {
  ensureCartHydrated();
  const current = cartStore.get();
  const next = normalizeDiscountCodes([...current.discountCodes, code]);
  if (next.length === current.discountCodes.length) return false;
  commitNonLineCartState({ ...current, discountCodes: next });
  return true;
}

export function removeDiscountCode(code: string): void {
  ensureCartHydrated();
  const current = cartStore.get();
  const next = current.discountCodes.filter((applied) => applied !== code);
  if (next.length === current.discountCodes.length) return;
  commitNonLineCartState({ ...current, discountCodes: next });
}

/** Puts back a cart the buyer just emptied or trimmed (undo). */
export function restoreCart(snapshot: CartStore): void {
  ensureCartHydrated();
  commitNonLineCartState(normalizeStoredCart(snapshot));
}

/**
 * Removes the lines of a placed order: each ordered quantity comes off its
 * line, and lines added meanwhile (for example in another tab) stay.
 */
export function removeOrderedLines(
  ordered: Record<string, { id?: unknown; variantId?: unknown; quantity?: unknown }>,
): void {
  ensureCartHydrated();
  const current = cartStore.get();
  const patches: CartAbsoluteQuantityPatch[] = [];
  for (const [lineKey, line] of Object.entries(ordered)) {
    const existing = current.items[lineKey];
    const quantity = typeof line.quantity === "number" ? Math.floor(line.quantity) : 0;
    if (!existing || existing.variantId !== line.variantId || quantity < 1) continue;
    patches.push({
      lineKey,
      productId: existing.id,
      variantId: existing.variantId,
      quantity: Math.max(0, existing.quantity - quantity),
    });
  }
  if (patches.length > 0) applyLocalLinePatch(patches);
}

export function clearCart(): void {
  ensureCartHydrated();
  const current = cartStore.get();
  if (Object.keys(current.items).length === 0 && current.discountCodes.length === 0) return;
  const entries = Object.entries(current.items);
  if (
    entries.some(
      ([, item]) =>
        !isValidIdentity(item.variantId) || item.variantId === "default",
    )
  ) {
    return;
  }
  const patches = entries.map(([lineKey, item]) => ({
    lineKey,
    productId: item.id,
    variantId: item.variantId!,
    quantity: 0,
  }));
  if (patches.length > 0) {
    applyLocalLinePatch(patches);
  } else {
    commitNonLineCartState({ ...current, discountCodes: [] });
  }
}

function patchFailure(
  code: CartLinePatchFailureCode,
): CartLinePatchFailure {
  return {
    ok: false,
    code,
  };
}

function isValidIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= MAX_CART_ID_LENGTH
  );
}

function validateNewPatchItem(
  patch: CartAbsoluteQuantityPatch,
): CartLinePatchFailureCode | null {
  const item = patch.item;
  if (!item) return "item_required";
  const variantId = item.variantId;
  if (!isValidIdentity(item.id) || item.id !== patch.productId) {
    return "invalid_product";
  }
  if (
    !isValidIdentity(variantId) ||
    variantId === "default" ||
    variantId !== patch.variantId
  ) {
    return "invalid_variant";
  }
  if (
    !isValidIdentity(item.name) ||
    typeof item.price !== "number" ||
    !Number.isFinite(item.price) ||
    item.price < 0
  ) {
    return "invalid_product";
  }
  if (createCartItemKey({ id: item.id, variantId }) !== patch.lineKey) {
    return "invalid_line_key";
  }
  return null;
}

function validateExistingItemReplacement(
  lineKey: string,
  item: Omit<CartItem, "quantity">,
  existing: CartItem,
): CartLinePatchFailureCode | null {
  const variantId = item.variantId;
  if (!isValidIdentity(item.id) || item.id !== existing.id) {
    return "invalid_product";
  }
  if (
    !isValidIdentity(variantId) ||
    variantId === "default" ||
    variantId !== existing.variantId
  ) {
    return "invalid_variant";
  }
  if (
    !isValidIdentity(item.name) ||
    typeof item.price !== "number" ||
    !Number.isFinite(item.price) ||
    item.price < 0
  ) {
    return "invalid_product";
  }
  if (createCartItemKey({ id: item.id, variantId }) !== lineKey) {
    return "invalid_line_key";
  }
  return null;
}

/**
 * Plans one local line update without touching the live store. Every change is
 * validated first so multi-line repair operations remain all-or-nothing.
 */
function planLinePatches(
  sourceState: CartStore,
  patches: CartAbsoluteQuantityPatch[],
  trustedExistingItemReplacements?: ReadonlyMap<
    string,
    Omit<CartItem, "quantity">
  >,
): CartLinePatchResult {
  const state = normalizeCartTotals(sourceState);

  if (
    !Array.isArray(patches) ||
    patches.length < 1 ||
    patches.length > MAX_CART_LINE_PATCHES
  ) {
    return patchFailure("invalid_patch_count");
  }

  const seenLineKeys = new Set<string>();
  for (const patch of patches) {
    if (
      typeof patch.lineKey !== "string" ||
      patch.lineKey.length < 1 ||
      patch.lineKey.length > MAX_CART_LINE_KEY_LENGTH
    ) {
      return patchFailure("invalid_line_key");
    }
    if (seenLineKeys.has(patch.lineKey)) {
      return patchFailure("duplicate_line_key");
    }
    seenLineKeys.add(patch.lineKey);

    if (!isValidIdentity(patch.productId)) {
      return patchFailure("invalid_product");
    }
    if (!isValidIdentity(patch.variantId) || patch.variantId === "default") {
      return patchFailure("invalid_variant");
    }
    if (
      !Number.isInteger(patch.quantity) ||
      patch.quantity < 0 ||
      patch.quantity > MAX_CART_QUANTITY
    ) {
      return patchFailure("invalid_quantity");
    }

    const existing = state.items[patch.lineKey];
    if (existing) {
      if (existing.id !== patch.productId) {
        return patchFailure("invalid_product");
      }
      if ((existing.variantId ?? undefined) !== patch.variantId) {
        return patchFailure("invalid_variant");
      }
      if (patch.item) return patchFailure("item_not_allowed");
      const replacement = trustedExistingItemReplacements?.get(patch.lineKey);
      const itemError = replacement
        ? validateExistingItemReplacement(
            patch.lineKey,
            replacement,
            existing,
          )
        : null;
      if (itemError) return patchFailure(itemError);
      continue;
    }

    if (patch.quantity === 0) {
      return patchFailure("line_not_found");
    }
    const itemError = validateNewPatchItem(patch);
    if (itemError) return patchFailure(itemError);
  }

  const items = { ...state.items };
  for (const patch of patches) {
    const existing = items[patch.lineKey];
    if (patch.quantity === 0) {
      delete items[patch.lineKey];
    } else if (existing) {
      items[patch.lineKey] = {
        ...(trustedExistingItemReplacements?.get(patch.lineKey) ?? existing),
        variantId: patch.variantId,
        quantity: patch.quantity,
      };
    } else {
      items[patch.lineKey] = {
        ...patch.item!,
        variantId: patch.variantId,
        quantity: patch.quantity,
      };
    }
  }

  const nextState = normalizeCartTotals({ ...state, items });
  return {
    ok: true,
    state: nextState,
  };
}

function applyLinePatchesToLiveStore(
  patches: CartAbsoluteQuantityPatch[],
  trustedExistingItemReplacements?: ReadonlyMap<
    string,
    Omit<CartItem, "quantity">
  >,
): CartLinePatchResult {
  ensureCartHydrated();
  const result = planLinePatches(
    cartStore.get(),
    patches,
    trustedExistingItemReplacements,
  );
  if (!result.ok) return result;
  cartStore.set(result.state);
  emitCartUpdated();
  return result;
}
