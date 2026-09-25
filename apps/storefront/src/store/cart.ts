import { map } from "nanostores";
import {
  lineCartKey,
  linePropertiesHash,
  LINE_PROPERTY_INPUT_LIMITS,
  NO_PROPERTIES_HASH,
} from "@scalius/shared/line-properties";
import { isFulfillmentKind, type FulfillmentKind } from "@scalius/shared/fulfilment";
import {
  normalizeCartItemOptions,
  type CartItemOption,
} from "@/lib/cart/item-options";

export type { CartItemOption } from "@/lib/cart/item-options";

/**
 * The browser cart lives here. v3 keys lines by product, SKU and the hash of
 * the buyer inputs (`line:v3:<product>:variant:<variant>:p:<hash>`); carts
 * saved under the v2 `cart` key are dropped, never read (Wave A §3.2).
 */
export const CART_STORAGE_KEY = "cart:v3";
const RETIRED_CART_STORAGE_KEYS = ["cart"] as const;

/**
 * One buyer input on a cart line, in the product's schema order. `key` and
 * `value` are the line's identity (hashed into the key and sent to checkout);
 * the rest is display only, and the server re-prices every input.
 * Buyer content: never put it in URLs, analytics or logs.
 */
export type CartLineProperty = {
  key: string;
  value: string;
  label: string;
  /** The choice label for selects, "Yes" for ticked boxes, the text otherwise. */
  displayValue: string;
  /** Surcharge per unit, in minor units (display only). */
  priceMinor: number;
};

export type CartItem = {
  id: string;
  slug?: string;
  name: string;
  /** One unit as the buyer saw it: base price plus the surcharges of its inputs. */
  price: number;
  quantity: number;
  image?: string;
  /** Actual image/poster Media asset identity; never a video asset. */
  imageMediaId?: string;
  variantId?: string;
  options?: CartItemOption[];
  freeDelivery?: boolean;
  /** Buyer inputs (engraving, gift wrap…), canonical: schema keys, schema order, no empties. */
  properties?: CartLineProperty[];
  /** `linePropertiesHash` of `properties`; "none" without inputs. Part of the line key. */
  propertiesHash?: string;
  /** What the SKU is. Unknown (older lines) is treated as physical: it needs delivery. */
  fulfillmentKind?: FulfillmentKind;
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

/** Fields a server answer may refresh on an existing line; never its identity. */
export type CartLineRefresh = Partial<
  Pick<
    CartItem,
    "name" | "price" | "quantity" | "image" | "imageMediaId" | "freeDelivery" | "fulfillmentKind"
  >
> & {
  /** Display labels and surcharges of the same inputs (keys and values must not change). */
  properties?: CartLineProperty[];
};

export type CartLineItemUpdate = {
  lineKey: string;
  updates: CartLineRefresh;
};

export const MAX_CART_QUANTITY = 99;
/** Mirrors the API's `MAX_SUBMITTED_DISCOUNT_CODES`. */
export const MAX_DISCOUNT_CODES = 5;
const DISCOUNT_CODE_PATTERN = /^[A-Z0-9_-]{1,50}$/;
const MAX_CART_LINE_PATCHES = 100;

const MAX_CART_ID_LENGTH = 160;
const MAX_CART_LINE_KEY_LENGTH = 512;
const PROPERTY_KEY_PATTERN = /^[a-z0-9_]{1,40}$/;
const PROPERTIES_HASH_PATTERN = /^[0-9a-f]{16}$/;
const MAX_PROPERTY_LABEL_LENGTH = 60;
const MAX_PROPERTY_DISPLAY_LENGTH = LINE_PROPERTY_INPUT_LIMITS.valueLength;

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

/**
 * Whether the cart needs a delivery method (and so, for delivery, an
 * address): some line is physical. A line whose kind is not known yet
 * counts as physical, so the address is never skipped by mistake.
 */
export function cartNeedsDeliveryMethod(
  items: Record<string, Pick<CartItem, "fulfillmentKind">>,
): boolean {
  return Object.values(items).some(
    (item) => item.fulfillmentKind === undefined || item.fulfillmentKind === "physical",
  );
}

if (typeof window !== "undefined") {
  cartStore.subscribe((state) => {
    if (!canPersistToStorage) return;
    try {
      const json = JSON.stringify(state);
      if (localStorage.getItem(CART_STORAGE_KEY) !== json) {
        localStorage.setItem(CART_STORAGE_KEY, json);
      }
    } catch (error) {
      console.warn("Could not persist cart state.", error);
    }
  });
  // Another tab changed the cart (an order, an add, a removal): follow it, so
  // this tab never writes its older copy back over the newer one.
  window.addEventListener?.("storage", (event) => {
    if (event.key === CART_STORAGE_KEY && hasHydratedFromStorage) readCartFromStorage(true);
  });
  // Leaving a Buy now checkout (including Back into a cached page) puts the
  // buyer's own cart back.
  window.addEventListener?.("pageshow", () => {
    if (!isBuyNowCheckoutPath(window.location.pathname)) endBuyNow();
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function boundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.normalize("NFC").trim();
  if (!text) return null;
  return Array.from(text).slice(0, maxLength).join("");
}

/**
 * Buyer inputs from an untrusted snapshot. Identity fields (`key`, `value`)
 * must be well formed or the whole list is refused (null), because a line
 * key that no longer matches its inputs would merge different lines.
 */
export function normalizeCartLineProperties(
  value: unknown,
): CartLineProperty[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > LINE_PROPERTY_INPUT_LIMITS.entries) return null;
  const properties: CartLineProperty[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    const key = typeof entry.key === "string" ? entry.key : "";
    const propertyValue = typeof entry.value === "string" ? entry.value : "";
    if (
      !PROPERTY_KEY_PATTERN.test(key) ||
      seen.has(key) ||
      !propertyValue ||
      propertyValue !== propertyValue.normalize("NFC").trim() ||
      Array.from(propertyValue).length > LINE_PROPERTY_INPUT_LIMITS.valueLength
    ) {
      return null;
    }
    seen.add(key);
    const priceMinor = toNumber(entry.priceMinor);
    properties.push({
      key,
      value: propertyValue,
      label: boundedText(entry.label, MAX_PROPERTY_LABEL_LENGTH) ?? key,
      displayValue: boundedText(entry.displayValue, MAX_PROPERTY_DISPLAY_LENGTH) ?? propertyValue,
      priceMinor: Number.isSafeInteger(priceMinor) && priceMinor > 0 ? priceMinor : 0,
    });
  }
  return properties;
}

/** The identity part of a line's inputs, as checkout sends them. */
export function cartLinePropertyInputs(
  item: Pick<CartItem, "properties">,
): Array<{ key: string; value: string }> {
  return (item.properties ?? []).map(({ key, value }) => ({ key, value }));
}

/** The shared WebCrypto hash of a line's inputs ("none" without inputs). */
export function cartLinePropertiesHash(
  properties: readonly Pick<CartLineProperty, "key" | "value">[] | undefined,
): Promise<string> {
  return linePropertiesHash((properties ?? []).map(({ key, value }) => ({ key, value })));
}

function isPropertiesHash(value: unknown): value is string {
  return value === NO_PROPERTIES_HASH || (typeof value === "string" && PROPERTIES_HASH_PATTERN.test(value));
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
  const properties = normalizeCartLineProperties(value.properties);
  if (properties === null) return null;
  // The stored hash is the line's identity; inputs without one (or "none"
  // with inputs) cannot be keyed, so the line is dropped.
  const propertiesHash = properties.length === 0
    ? NO_PROPERTIES_HASH
    : isPropertiesHash(value.propertiesHash) && value.propertiesHash !== NO_PROPERTIES_HASH
      ? value.propertiesHash
      : null;
  if (!propertiesHash) return null;

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
    ...(properties.length > 0 ? { properties } : {}),
    propertiesHash,
    ...(isFulfillmentKind(value.fulfillmentKind) ? { fulfillmentKind: value.fulfillmentKind } : {}),
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
    // A v2 cart is dropped at the v3 deploy (no legacy reader).
    for (const retired of RETIRED_CART_STORAGE_KEYS) {
      if (localStorage.getItem(retired) !== null) localStorage.removeItem?.(retired);
    }
  } catch {
    // Storage that refuses a removal still reads the v3 cart below.
  }
  try {
    const storedCart = localStorage.getItem(CART_STORAGE_KEY);
    if (storedCart) {
      const normalized = normalizeStoredCart(JSON.parse(storedCart));
      if (JSON.stringify(normalized) !== JSON.stringify(cartStore.get())) cartStore.set(normalized);
      const normalizedJson = JSON.stringify(normalized);
      if (normalizedJson !== storedCart) {
        try {
          localStorage.setItem(CART_STORAGE_KEY, normalizedJson);
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
 * The v3 line key for a line whose inputs hash is already known (hydration,
 * repairs). Same SKU + same canonical inputs = one line (Wave A P2).
 */
export function createCartItemKey(
  item: { id: string; variantId: string; propertiesHash?: string },
): string {
  const productId = item.id.trim();
  const variantId = item.variantId.trim();
  if (!productId || !variantId || variantId === "default") {
    throw new TypeError("Cart lines require persisted product and variant IDs.");
  }
  const hash = item.propertiesHash ?? NO_PROPERTIES_HASH;
  if (!isPropertiesHash(hash)) throw new TypeError("Cart line inputs hash is malformed.");
  return lineCartKey(productId, variantId, hash);
}

/** The v3 line key from the line's inputs, hashed with the shared WebCrypto function. */
export async function cartLineKeyFor(
  item: { id: string; variantId: string; properties?: readonly Pick<CartLineProperty, "key" | "value">[] },
): Promise<string> {
  return createCartItemKey({
    id: item.id,
    variantId: item.variantId,
    propertiesHash: await cartLinePropertiesHash(item.properties),
  });
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

type NewCartLine = Omit<CartItem, "quantity" | "propertiesHash"> & { quantity?: number };

/** Normalizes a line to add and computes its inputs hash; null when it can't be a line. */
async function prepareNewLine(
  item: NewCartLine,
): Promise<{ key: string; line: Omit<CartItem, "quantity">; quantity: number } | null> {
  const variantId = item.variantId;
  if (
    !isValidIdentity(item.id) ||
    !isValidIdentity(variantId) ||
    variantId === "default"
  ) {
    return null;
  }
  const properties = normalizeCartLineProperties(item.properties);
  if (properties === null) return null;
  const propertiesHash = await cartLinePropertiesHash(properties);
  const options = normalizeCartItemOptions(item.options);
  const { properties: _ignored, quantity: requested, ...rest } = item;
  const line: Omit<CartItem, "quantity"> = {
    ...rest,
    variantId,
    ...(options ? { options } : { options: undefined }),
    ...(properties.length > 0 ? { properties } : {}),
    propertiesHash,
    ...(isFulfillmentKind(item.fulfillmentKind) ? { fulfillmentKind: item.fulfillmentKind } : { fulfillmentKind: undefined }),
  };
  return {
    key: createCartItemKey({ id: item.id, variantId, propertiesHash }),
    line,
    quantity: Math.min(MAX_CART_QUANTITY, Math.max(1, Math.floor(toNumber(requested, 1)))),
  };
}

/**
 * Adds a line, or adds to the line with the same SKU and the same inputs.
 * The key uses the shared WebCrypto inputs hash, so this is async.
 */
export async function addToCart(item: NewCartLine): Promise<boolean> {
  ensureCartHydrated();
  const prepared = await prepareNewLine(item);
  if (!prepared) return false;
  const existingItem = cartStore.get().items[prepared.key];
  const quantity = existingItem
    ? Math.min(MAX_CART_QUANTITY, existingItem.quantity + prepared.quantity)
    : prepared.quantity;

  return applyLocalLinePatch([
    {
      lineKey: prepared.key,
      productId: item.id,
      variantId: prepared.line.variantId!,
      quantity,
      ...(!existingItem ? { item: prepared.line } : {}),
    },
  ]).ok;
}

/**
 * Editing a line's inputs: the old line goes and the edited one is added
 * under its new key in one update (merging into a line that already has
 * those inputs). The quantity given is the edited line's own.
 */
export async function replaceCartLine(
  oldLineKey: string,
  item: NewCartLine,
): Promise<boolean> {
  ensureCartHydrated();
  const prepared = await prepareNewLine(item);
  if (!prepared) return false;
  const current = cartStore.get();
  const old = current.items[oldLineKey];
  if (!old) return addToCart(item);
  if (prepared.key === oldLineKey) {
    return applyLocalLinePatch(
      [{ lineKey: oldLineKey, productId: old.id, variantId: old.variantId, quantity: prepared.quantity }],
      new Map([[oldLineKey, prepared.line]]),
    ).ok;
  }
  const target = current.items[prepared.key];
  return applyLocalLinePatch([
    { lineKey: oldLineKey, productId: old.id, variantId: old.variantId, quantity: 0 },
    {
      lineKey: prepared.key,
      productId: item.id,
      variantId: prepared.line.variantId!,
      quantity: target
        ? Math.min(MAX_CART_QUANTITY, target.quantity + prepared.quantity)
        : prepared.quantity,
      ...(!target ? { item: prepared.line } : {}),
    },
  ]).ok;
}

/**
 * The server resolved a line's inputs to a different canonical hash (its
 * word is final): move the line to the key of that hash, merging with a
 * line already there.
 */
export function rekeyCartLine(
  lineKey: string,
  propertiesHash: string,
  properties: CartLineProperty[],
): boolean {
  ensureCartHydrated();
  const current = cartStore.get();
  const existing = current.items[lineKey];
  const normalized = normalizeCartLineProperties(properties);
  if (!existing || normalized === null || !isPropertiesHash(propertiesHash)) return false;
  if ((normalized.length === 0) !== (propertiesHash === NO_PROPERTIES_HASH)) return false;
  const nextKey = createCartItemKey({ id: existing.id, variantId: existing.variantId, propertiesHash });
  if (nextKey === lineKey) return false;
  const target = current.items[nextKey];
  const { properties: _old, ...rest } = existing;
  const moved: Omit<CartItem, "quantity"> = {
    ...rest,
    ...(normalized.length > 0 ? { properties: normalized } : {}),
    propertiesHash,
  };
  return applyLocalLinePatch([
    { lineKey, productId: existing.id, variantId: existing.variantId, quantity: 0 },
    {
      lineKey: nextKey,
      productId: existing.id,
      variantId: existing.variantId,
      quantity: target
        ? Math.min(MAX_CART_QUANTITY, target.quantity + existing.quantity)
        : existing.quantity,
      ...(!target ? { item: moved } : {}),
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
  updates: CartLineRefresh,
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
    // New display labels for the same inputs only: keys and values are the
    // line's identity and never change here.
    let properties = existingItem.properties;
    if (updates.properties !== undefined) {
      const next = normalizeCartLineProperties(updates.properties);
      const sameIdentity = next !== null &&
        next.length === (existingItem.properties?.length ?? 0) &&
        next.every((property, index) =>
          property.key === existingItem.properties?.[index]?.key &&
          property.value === existingItem.properties?.[index]?.value);
      if (!sameIdentity) return false;
      properties = next.length > 0 ? next : undefined;
    }
    const refreshed = { ...existingItem, ...updates, properties, quantity };
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
      ...(properties ? { properties } : {}),
      propertiesHash: existingItem.propertiesHash ?? NO_PROPERTIES_HASH,
      ...(isFulfillmentKind(refreshed.fulfillmentKind)
        ? { fulfillmentKind: refreshed.fulfillmentKind }
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

/**
 * "Buy now" buys only that item: the buyer's cart is set aside here while the
 * checkout holds just the Buy now line, and comes back after the order or as
 * soon as the buyer leaves the checkout (the Buy now line is not added to it).
 * localStorage, so it survives the checkout's reloads and a hosted payment.
 */
export const BUY_NOW_STASH_KEY = "cart:v3:buy-now";

/** Pages that belong to a Buy now checkout; anywhere else the cart comes back. */
export function isBuyNowCheckoutPath(pathname: string): boolean {
  return pathname === "/cart"
    || pathname === "/checkout"
    || pathname.startsWith("/checkout/")
    || pathname.startsWith("/buy/")
    || pathname === "/order-success"
    || pathname === "/payment-recovery";
}

/** Sets the cart aside and starts a checkout holding only this line. */
export async function startBuyNow(item: NewCartLine): Promise<boolean> {
  ensureCartHydrated();
  const prepared = await prepareNewLine(item);
  if (!prepared) return false;
  try {
    // A second Buy now replaces the first; the buyer's own cart stays set aside.
    if (localStorage.getItem(BUY_NOW_STASH_KEY) === null) {
      localStorage.setItem(BUY_NOW_STASH_KEY, JSON.stringify(cartStore.get()));
    }
  } catch {
    // Without storage nothing could be put back: add to the cart as before.
    return addToCart(item);
  }
  commitNonLineCartState({ ...EMPTY_CART_STATE });
  return applyLocalLinePatch([
    {
      lineKey: prepared.key,
      productId: item.id,
      variantId: prepared.line.variantId!,
      quantity: prepared.quantity,
      item: prepared.line,
    },
  ]).ok;
}

/** Puts back the cart a Buy now set aside, if any; the Buy now cart is dropped. */
export function endBuyNow(): void {
  if (typeof window === "undefined") return;
  let stashed: string | null;
  try {
    stashed = localStorage.getItem(BUY_NOW_STASH_KEY);
    if (stashed === null) return;
    localStorage.removeItem(BUY_NOW_STASH_KEY);
  } catch {
    return;
  }
  ensureCartHydrated();
  try {
    commitNonLineCartState(normalizeStoredCart(JSON.parse(stashed)));
  } catch {
    // An unreadable stash leaves the current cart as it is.
  }
}

function discardBuyNowStash(): void {
  try {
    localStorage.removeItem(BUY_NOW_STASH_KEY);
  } catch {
    // Nothing was kept.
  }
}

export function clearCart(): void {
  ensureCartHydrated();
  // Clearing (sign-out on a shared device) also drops a cart set aside by Buy now.
  if (typeof window !== "undefined") discardBuyNowStash();
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

/** The key a stored line must live under; null when it can't be keyed. */
function storedLineKey(item: Omit<CartItem, "quantity">): string | null {
  if (!item.variantId) return null;
  const hasInputs = (item.properties?.length ?? 0) > 0;
  if (hasInputs === ((item.propertiesHash ?? NO_PROPERTIES_HASH) === NO_PROPERTIES_HASH)) return null;
  try {
    return createCartItemKey({
      id: item.id,
      variantId: item.variantId,
      propertiesHash: item.propertiesHash ?? NO_PROPERTIES_HASH,
    });
  } catch {
    return null;
  }
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
  if (storedLineKey(item) !== patch.lineKey) {
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
  if (storedLineKey(item) !== lineKey) {
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
