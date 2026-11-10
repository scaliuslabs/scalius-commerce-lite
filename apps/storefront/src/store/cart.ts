import { MAX_LINE_QUANTITY } from "@scalius/shared/order-limits";
import { map } from "nanostores";
import {
  LINE_ADJUSTMENT_KEY,
  lineCartKey,
  lineIdentityProperties,
  linePropertiesHash,
  LINE_PROPERTY_INPUT_LIMITS,
  LINE_PROPERTY_REVISION_PATTERN,
  NO_PROPERTIES_HASH,
} from "@scalius/shared/line-identity";
import { isFulfillmentKind, type FulfillmentKind } from "@scalius/shared/fulfilment";
import { getCurrencyCode, getDecimalPlaces } from "@scalius/shared/currency";
import { fromMinor, toMinor } from "@scalius/shared/money";
import {
  normalizeCartItemOptions,
  type CartItemOption,
} from "@/lib/cart/item-options";
import {
  normalizeCartLinePurchaseOptions,
  type CartLinePurchaseOption,
} from "@/lib/cart/purchase-option";
import { isAppScopedKey } from "@scalius/shared/plugins/ids";
import { emitBuyerEvent } from "@/lib/buyer-events/bus";
import { dropCheckoutFormDraft } from "@/lib/checkout/draft-lifetime";
import { cartLine } from "@/lib/buyer-events/lines";

export type { CartItemOption } from "@/lib/cart/item-options";
export type { CartLinePurchaseOption } from "@/lib/cart/purchase-option";

/**
 * The browser cart lives here. v3 keys lines by product, SKU and the hash of
 * the buyer inputs (`line:v3:<product>:variant:<variant>:p:<hash>`); carts
 * saved under the v2 `cart` key are dropped, never read (Wave A §3.2).
 */
export const CART_STORAGE_KEY = "cart:v3";

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
  /**
   * The revision of the words the buyer answered (an app input whose words
   * the merchant writes): sent with the answer, never part of the identity.
   */
  revision?: string;
};

/**
 * An app's add-on to a line ("Add-on: Engraving, 6 letters (+৳300)"), as the
 * last cart check priced it. Display only: it is in `price` already, has no
 * identity and is never sent to checkout (the server adds it again).
 */
export type CartLineAdjustment = {
  /** `_adjustment`: what the line froze it under (its label is the page's word for an add-on). */
  key?: string;
  label: string;
  displayValue: string;
  /** Per unit, in minor units. */
  priceMinor: number;
  /** The app that added it (an island reads its own app's add-ons). */
  appId?: string;
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
  /**
   * The apps' ways to buy the line (a subscription, another app's protection
   * plan), at most one per app, sorted by id; absent for a one-time line.
   * Their ids join the line's identity and are sent to checkout; the apps
   * price the line.
   */
  purchaseOptions?: CartLinePurchaseOption[];
  /** `linePropertiesHash` of `properties` then `purchaseOptions` (`lineIdentityProperties`); "none" without either. Part of the line key. */
  propertiesHash?: string;
  /** Apps' add-ons from the last cart check (display only, never identity). */
  adjustments?: CartLineAdjustment[];
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
  /**
   * The cart is a signed-in buyer's: lines were added to it while signed in.
   * Signing out empties such a cart (a shared phone keeps nothing of the
   * account); a guest's cart belongs to the device and stays. Absent: a
   * guest's. It ends when the cart empties.
   */
  accountCart?: true;
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
  | "item_required"
  | "storage_unavailable";

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
  /** The apps' add-ons the server priced in (an empty list clears them). */
  adjustments?: CartLineAdjustment[];
};

export type CartLineItemUpdate = {
  lineKey: string;
  updates: CartLineRefresh;
};

/** The most units one cart line holds: the one order-line limit (`@scalius/shared/order-limits`). */
export const MAX_CART_QUANTITY = MAX_LINE_QUANTITY;
/** Mirrors the API's `MAX_SUBMITTED_DISCOUNT_CODES`. */
export const MAX_DISCOUNT_CODES = 5;
const DISCOUNT_CODE_PATTERN = /^[A-Z0-9_-]{1,50}$/;
const MAX_CART_LINE_PATCHES = 100;

const MAX_CART_ID_LENGTH = 160;
const MAX_CART_LINE_KEY_LENGTH = 512;
const PROPERTY_KEY_PATTERN = /^[a-z0-9_]{1,40}$/;
/** A buyer input's key: the product's own (`engraving`) or an app's line input (`<app id>.<key>`). */
const isPropertyKey = (key: string) => PROPERTY_KEY_PATTERN.test(key) || isAppScopedKey(key);
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

// The buyer's typed checkout details live only while the cart has something
// to check out: a cart that empties (the last line removed, the order placed,
// another tab emptying it) takes them with it (lib/checkout/draft-lifetime.ts).
cartStore.listen((state) => {
  if (Object.keys(state.items).length === 0) dropCheckoutFormDraft();
});

type ShippingFeeCartItem = Pick<CartItem, "freeDelivery"> & Partial<Pick<CartItem, "price" | "quantity" | "fulfillmentKind">>;

/** A line that ships (a line whose kind is not known yet counts as physical). */
const shipsItem = (item: ShippingFeeCartItem) => item.fulfillmentKind === undefined || item.fulfillmentKind === "physical";

/**
 * Every line that ships is in a free-delivery shipping profile, so delivery
 * costs nothing (the checkout's rule: a free line ships only itself free,
 * never the rest of the order; a digital or service line ships nothing).
 */
export function cartShipsAllFree(
  items: Record<string, ShippingFeeCartItem>,
): boolean {
  const shipped = Object.values(items).filter(shipsItem);
  return shipped.length > 0 && shipped.every((item) => item.freeDelivery === true);
}

/**
 * What a rate's free-over threshold is measured against: the lines that ship
 * and pay delivery, before discounts. Digital, service and free-delivery
 * lines count for nothing (the checkout's shipping-profile rule).
 */
export function cartShippedSubtotal(items: Record<string, ShippingFeeCartItem>): number {
  return cartItemsSubtotal(Object.fromEntries(Object.entries(items).filter(([, item]) => shipsItem(item) && item.freeDelivery !== true)));
}

/** The items subtotal before discounts. */
export function cartItemsSubtotal(items: Record<string, ShippingFeeCartItem>): number {
  const decimalPlaces = getDecimalPlaces(getCurrencyCode());
  const totalMinor = Object.values(items).reduce(
    (sum, item) => {
      const price = Number(item.price);
      const quantity = Number(item.quantity);
      return sum + toMinor(Number.isFinite(price) ? Math.max(0, price) : 0, decimalPlaces)
        * (Number.isFinite(quantity) ? Math.max(0, Math.trunc(quantity)) : 0);
    },
    0,
  );
  return fromMinor(totalMinor, decimalPlaces);
}

/**
 * What the buyer pays for the chosen rate: nothing when every line that ships
 * ships free, or when the shipped lines reach the rate's free-over threshold
 * (the checkout applies the same rule authoritatively; with shipping profiles
 * the checkout quote's per-cart amount is `quoted`).
 */
export function getEffectiveCartShippingFee(
  items: Record<string, ShippingFeeCartItem>,
  methodFee: number,
  freeOver: number | null = null,
  quoted = false,
): number {
  const normalizedMethodFee = Number.isFinite(methodFee)
    ? Math.max(0, methodFee)
    : 0;
  // An app quote already includes its delivery rules and is the amount payable.
  if (quoted) return normalizedMethodFee;
  if (cartShipsAllFree(items)) return 0;
  if (freeOver !== null && Number.isFinite(freeOver) && cartShippedSubtotal(items) >= freeOver) return 0;
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

/** JSON with sorted keys: the same cart reads the same whatever order its fields were written in. */
function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => sortedJson(item ?? null)).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${sortedJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Whether storage already holds this cart. Field order is not a change: a tab
 * that writes back a cart it just read from storage (only reordered) races the
 * tab that wrote it and can put back an older cart over a newer one.
 */
function storageHolds(stored: string | null, json: string): boolean {
  if (stored === null) return false;
  try {
    return sortedJson(JSON.parse(stored)) === sortedJson(JSON.parse(json));
  } catch {
    return false;
  }
}

/**
 * The cart as storage keeps it. A line with exactly one purchase option also
 * keeps it as `purchaseOption`, the one field the storefront read before a
 * line could carry one option per app: a tab still running that build (open
 * across a deploy) then keys the line as before (one option hashes exactly
 * as the one-entry list) instead of reading it as one-time and merging it
 * into the one-time line. The list wins when both are read. Remove once no
 * page of that build can still be open.
 */
export function storedCartJson(state: CartStore): string {
  const items = Object.fromEntries(Object.entries(state.items).map(([key, item]) => [
    key,
    item.purchaseOptions?.length === 1 ? { ...item, purchaseOption: item.purchaseOptions[0] } : item,
  ]));
  return JSON.stringify({ ...state, items });
}

if (typeof window !== "undefined") {
  cartStore.subscribe((state) => {
    if (!canPersistToStorage) return;
    try {
      const json = storedCartJson(state);
      const stored = localStorage.getItem(CART_STORAGE_KEY);
      if (stored !== json && !storageHolds(stored, json)) {
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
  // Back can restore a product page whose cart predates a completed checkout.
  window.addEventListener?.("pageshow", (event) => {
    if (event.persisted && hasHydratedFromStorage) readCartFromStorage(true);
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
      !isPropertyKey(key) ||
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
      // Not identity: a malformed one is dropped, never the line.
      ...(typeof entry.revision === "string" && LINE_PROPERTY_REVISION_PATTERN.test(entry.revision) ? { revision: entry.revision } : {}),
    });
  }
  return properties;
}

const MAX_LINE_ADJUSTMENTS = 5;

/** Add-ons from a server answer or a stored cart: display only, so bad entries are dropped, never the line. */
export function normalizeCartLineAdjustments(value: unknown): CartLineAdjustment[] {
  if (!Array.isArray(value)) return [];
  const adjustments: CartLineAdjustment[] = [];
  for (const entry of value.slice(0, MAX_LINE_ADJUSTMENTS)) {
    if (!isRecord(entry)) continue;
    const label = boundedText(entry.label, MAX_PROPERTY_LABEL_LENGTH);
    const displayValue = boundedText(entry.displayValue, MAX_PROPERTY_DISPLAY_LENGTH);
    const priceMinor = toNumber(entry.priceMinor);
    if (!label || !displayValue || !Number.isSafeInteger(priceMinor) || priceMinor <= 0) continue;
    const appId = typeof entry.appId === "string" && entry.appId.length <= MAX_CART_ID_LENGTH ? entry.appId : null;
    adjustments.push({ key: LINE_ADJUSTMENT_KEY, label, displayValue, priceMinor, ...(appId ? { appId } : {}) });
  }
  return adjustments;
}

/** The identity part of a line's inputs, as checkout sends them. */
export function cartLinePropertyInputs(
  item: Pick<CartItem, "properties">,
): Array<{ key: string; value: string; revision?: string }> {
  return (item.properties ?? []).map(({ key, value, revision }) => ({ key, value, ...(revision ? { revision } : {}) }));
}

/** The shared WebCrypto hash of a line's identity: its inputs, then its purchase options ("none" without either). */
export function cartLinePropertiesHash(
  properties: readonly Pick<CartLineProperty, "key" | "value">[] | undefined,
  purchaseOptions?: readonly Pick<CartLinePurchaseOption, "id">[] | null,
): Promise<string> {
  return linePropertiesHash(lineIdentityProperties(
    (properties ?? []).map(({ key, value }) => ({ key, value })),
    (purchaseOptions ?? []).map(({ id }) => id),
  ));
}

/** Whether a line has an identity beyond its SKU (inputs or purchase options), so a hash other than "none". */
function hasLineIdentity(item: Pick<CartItem, "properties" | "purchaseOptions">): boolean {
  return (item.properties?.length ?? 0) > 0 || (item.purchaseOptions?.length ?? 0) > 0;
}

function isPropertiesHash(value: unknown): value is string {
  return value === NO_PROPERTIES_HASH || (typeof value === "string" && PROPERTIES_HASH_PATTERN.test(value));
}

function adjustmentsOf(value: unknown): { adjustments?: CartLineAdjustment[] } {
  const adjustments = normalizeCartLineAdjustments(value);
  return adjustments.length > 0 ? { adjustments } : {};
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
  // A cart saved when a line had at most one option kept it as `purchaseOption`;
  // it hashed exactly as the one-entry list does, so its key still holds.
  const purchaseOptions = normalizeCartLinePurchaseOptions(value.purchaseOptions, value.purchaseOption);
  if (purchaseOptions === null) return null;
  // The stored hash is the line's identity; inputs or an option without one
  // (or "none" with them) cannot be keyed, so the line is dropped.
  const propertiesHash = properties.length === 0 && purchaseOptions.length === 0
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
    ...(purchaseOptions.length > 0 ? { purchaseOptions } : {}),
    propertiesHash,
    ...(adjustmentsOf(value.adjustments)),
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

/** The storefront's readable sign-in hint beside its httpOnly session cookie. */
function signedInHint(): boolean {
  try {
    return typeof document !== "undefined" && document.cookie.split(";").some((cookie) => cookie.trim().startsWith("cs_auth=1"));
  } catch {
    return false;
  }
}

function normalizeCartTotals(state: CartStore): CartStore {
  const items = Object.values(state.items);
  const totalItems = items.reduce((total, item) => total + item.quantity, 0);
  const { accountCart: _owner, ...rest } = state;
  return {
    ...rest,
    // An empty cart is no one's.
    ...(state.accountCart && totalItems > 0 ? { accountCart: true as const } : {}),
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
    ...(value.accountCart === true ? { accountCart: true as const } : {}),
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
    const storedCart = localStorage.getItem(CART_STORAGE_KEY);
    if (storedCart) {
      const normalized = normalizeStoredCart(JSON.parse(storedCart));
      if (JSON.stringify(normalized) !== JSON.stringify(cartStore.get())) cartStore.set(normalized);
      const normalizedJson = storedCartJson(normalized);
      // Only a real migration writes back; a reordered copy of what another
      // tab just wrote must never be written over its newer cart.
      if (normalizedJson !== storedCart && !storageHolds(storedCart, normalizedJson)) {
        try {
          localStorage.setItem(CART_STORAGE_KEY, normalizedJson);
        } catch (error) {
          console.warn("Could not persist migrated cart state.", error);
        }
      }
    } else {
      const current = resetWhenMissing ? { ...EMPTY_CART_STATE } : cartStore.get();
      cartStore.set(current);
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

/** The v3 line key from the line's inputs and purchase options, hashed with the shared WebCrypto function. */
export async function cartLineKeyFor(
  item: {
    id: string;
    variantId: string;
    properties?: readonly Pick<CartLineProperty, "key" | "value">[];
    purchaseOptions?: readonly Pick<CartLinePurchaseOption, "id">[] | null;
  },
): Promise<string> {
  return createCartItemKey({
    id: item.id,
    variantId: item.variantId,
    propertiesHash: await cartLinePropertiesHash(item.properties, item.purchaseOptions),
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
  requirePersistence = false,
  moves?: ReadonlyMap<string, string>,
): CartLinePatchResult {
  return applyLinePatchesToLiveStore(patches, trustedExistingItemReplacements, requirePersistence, moves);
}

type NewCartLine = Omit<CartItem, "quantity" | "propertiesHash"> & { quantity?: number };

/**
 * The buyer events of a cart change the buyer made (buyer-events.ts): the
 * units each line gained or lost. Every add (the buy form, a card, an
 * island, buy now, buy again) comes through here, so each is heard once;
 * a placed order's lines leaving the cart, a sign-out or a repair are not
 * the buyer's change and say nothing.
 */
function emitLineChanges(before: CartStore["items"], after: CartStore["items"], keys: Iterable<string>): void {
  for (const key of keys) {
    const was = before[key]?.quantity ?? 0;
    const now = after[key]?.quantity ?? 0;
    const item = after[key] ?? before[key];
    if (!item || now === was) continue;
    emitBuyerEvent(now > was ? "product_added_to_cart" : "product_removed_from_cart", { line: cartLine(item, Math.abs(now - was)) });
  }
}
export type CartAddFailureReason = "quantity_limit" | "storage_unavailable" | "invalid_item";
type CartAddOptions = {
  requirePersistence?: boolean;
  onFailure?: (reason: CartAddFailureReason) => void;
};

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
  const purchaseOptions = normalizeCartLinePurchaseOptions(item.purchaseOptions);
  if (purchaseOptions === null) return null;
  const propertiesHash = await cartLinePropertiesHash(properties, purchaseOptions);
  const options = normalizeCartItemOptions(item.options);
  const { properties: _ignored, purchaseOptions: _options, quantity: requested, ...rest } = item;
  const line: Omit<CartItem, "quantity"> = {
    ...rest,
    variantId,
    ...(options ? { options } : { options: undefined }),
    ...(properties.length > 0 ? { properties } : {}),
    ...(purchaseOptions.length > 0 ? { purchaseOptions } : {}),
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
export async function addToCart(
  item: NewCartLine,
  options: CartAddOptions = {},
): Promise<boolean> {
  ensureCartHydrated();
  const prepared = await prepareNewLine(item);
  if (!prepared) {
    options.onFailure?.("invalid_item");
    return false;
  }
  const before = cartStore.get().items;
  const existingItem = before[prepared.key];
  const quantity = existingItem
    ? existingItem.quantity + prepared.quantity
    : prepared.quantity;

  const result = applyLocalLinePatch([
    {
      lineKey: prepared.key,
      productId: item.id,
      variantId: prepared.line.variantId!,
      quantity,
      ...(!existingItem ? { item: prepared.line } : {}),
    },
  ], undefined, options.requirePersistence);
  if (!result.ok) {
    options.onFailure?.(result.code === "invalid_quantity" ? "quantity_limit"
      : result.code === "storage_unavailable" ? "storage_unavailable" : "invalid_item");
  } else {
    emitLineChanges(before, result.state.items, [prepared.key]);
  }
  return result.ok;
}

/**
 * How lines meet the same line already in the cart: `add` grows it by the
 * quantity given (add to cart, buy again); `set` makes the quantity given the
 * line's (buy now, a recovered cart), so doing it again never multiplies it.
 */
export type CartLineQuantity = "add" | "set";

/**
 * Puts several lines in the cart as one change (buy again, buy now, a
 * recovered cart): every line's key is computed first, then one patch applies
 * them all against the same cart, so no line can be lost to another line's
 * await. Lines with the same SKU and inputs merge; quantities stop at the
 * cart's per-line limit. A line already in the cart takes the line given (its
 * price and picture are the newer ones); other lines are kept. Returns the
 * keys of the lines it put in, in the order given; a line that can't be a
 * cart line, or (`add`) is already at the limit, is left out. `requirePersistence`
 * (a caller about to navigate) fails the change when the browser can't keep it.
 */
export async function addLinesToCart(
  items: readonly NewCartLine[],
  options: { quantity?: CartLineQuantity; requirePersistence?: boolean } = {},
): Promise<string[]> {
  const result = await putLinesInCart(items, options);
  return "keys" in result ? result.keys : [];
}

async function putLinesInCart(
  items: readonly NewCartLine[],
  options: { quantity?: CartLineQuantity; requirePersistence?: boolean },
): Promise<{ keys: string[] } | { failure: CartAddFailureReason }> {
  ensureCartHydrated();
  const prepared = (await Promise.all(items.map((item) => prepareNewLine(item))))
    .filter((line): line is NonNullable<typeof line> => line !== null);
  if (prepared.length === 0) return { failure: "invalid_item" };
  const current = cartStore.get();
  const merged = new Map<string, { line: Omit<CartItem, "quantity">; quantity: number }>();
  for (const { key, line, quantity } of prepared) {
    const seen = merged.get(key);
    merged.set(key, { line: seen?.line ?? line, quantity: (seen?.quantity ?? 0) + quantity });
  }
  const set = options.quantity === "set";
  const patches: CartAbsoluteQuantityPatch[] = [];
  const replacements = new Map<string, Omit<CartItem, "quantity">>();
  for (const [lineKey, { line, quantity }] of merged) {
    const existing = current.items[lineKey];
    const next = Math.min(MAX_CART_QUANTITY, (set ? 0 : existing?.quantity ?? 0) + quantity);
    if (existing && !set && next <= existing.quantity) continue;
    if (existing) replacements.set(lineKey, line);
    patches.push({
      lineKey,
      productId: line.id,
      variantId: line.variantId!,
      quantity: next,
      ...(!existing ? { item: line } : {}),
    });
  }
  if (patches.length === 0) return { failure: "quantity_limit" };
  const result = applyLocalLinePatch(patches, replacements, options.requirePersistence);
  if (!result.ok) return { failure: result.code === "storage_unavailable" ? "storage_unavailable" : "invalid_item" };
  emitLineChanges(current.items, result.state.items, patches.map((patch) => patch.lineKey));
  return { keys: patches.map((patch) => patch.lineKey) };
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
  // The edited line keeps its place in the cart.
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
  ], undefined, false, new Map([[oldLineKey, prepared.key]])).ok;
}

/**
 * Several lines' inputs edited at once (a bulk action on an app's line
 * input): every old line goes and each edited one is added under its new key
 * in one store update, so the cart is checked once. Lines landing on one key
 * merge. False, with nothing changed, when any line cannot be keyed.
 */
export async function replaceCartLines(
  edits: ReadonlyArray<{ oldLineKey: string; item: NewCartLine }>,
): Promise<boolean> {
  ensureCartHydrated();
  if (edits.length === 0) return true;
  const prepared = await Promise.all(edits.map((edit) => prepareNewLine(edit.item)));
  if (prepared.some((line) => !line)) return false;
  const current = cartStore.get();
  const quantities = new Map<string, number>(Object.entries(current.items).map(([key, item]) => [key, item.quantity]));
  const items = new Map<string, Omit<CartItem, "quantity">>();
  const identities = new Map<string, { productId: string; variantId: string }>();
  for (const [index, edit] of edits.entries()) {
    const line = prepared[index]!;
    const old = current.items[edit.oldLineKey];
    if (!old) return false;
    identities.set(edit.oldLineKey, { productId: old.id, variantId: old.variantId });
    quantities.set(edit.oldLineKey, (quantities.get(edit.oldLineKey) ?? 0) - old.quantity);
    quantities.set(line.key, Math.min(MAX_CART_QUANTITY, (quantities.get(line.key) ?? 0) + line.quantity));
    identities.set(line.key, { productId: edit.item.id, variantId: line.line.variantId! });
    if (!current.items[line.key] || line.key === edit.oldLineKey) items.set(line.key, line.line);
  }
  const patches: CartAbsoluteQuantityPatch[] = [...identities].map(([lineKey, identity]) => ({
    lineKey,
    productId: identity.productId,
    variantId: identity.variantId,
    quantity: Math.max(0, quantities.get(lineKey) ?? 0),
    ...(items.has(lineKey) && !current.items[lineKey] ? { item: items.get(lineKey)! } : {}),
  }));
  const replacements = new Map([...items].filter(([key]) => current.items[key]));
  // Each edited line keeps its place in the cart.
  const moves = new Map(edits.map((edit, index) => [edit.oldLineKey, prepared[index]!.key]));
  return applyLocalLinePatch(patches, replacements.size > 0 ? replacements : undefined, false, moves).ok;
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
  if (hasLineIdentity({ properties: normalized, purchaseOptions: existing.purchaseOptions }) === (propertiesHash === NO_PROPERTIES_HASH)) return false;
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

  const result = applyLocalLinePatch([
    {
      lineKey: itemKey,
      productId: item.id,
      variantId: item.variantId,
      quantity: 0,
    },
  ]);
  if (result.ok) emitLineChanges(current.items, result.state.items, [itemKey]);
  return result.ok;
}

export function updateCartItemByKey(
  itemKey: string,
  updates: CartLineRefresh,
): boolean {
  ensureCartHydrated();
  const before = cartStore.get().items;
  const updated = updateCartItemsByKeyAtomically([{ lineKey: itemKey, updates }]);
  if (updated && updates.quantity !== undefined) emitLineChanges(before, cartStore.get().items, [itemKey]);
  return updated;
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
    const adjustments = updates.adjustments !== undefined ? normalizeCartLineAdjustments(updates.adjustments) : existingItem.adjustments ?? [];
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
      // Identity: never changed by a refresh.
      ...(existingItem.purchaseOptions?.length ? { purchaseOptions: existingItem.purchaseOptions } : {}),
      propertiesHash: existingItem.propertiesHash ?? NO_PROPERTIES_HASH,
      ...(adjustments.length > 0 ? { adjustments } : {}),
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
 * Buy now: this item at the quantity chosen (never added to what the cart
 * already holds of it, so Back and Buy now again keeps one), the other lines
 * kept, persisted before the caller navigates away.
 */
export async function startBuyNow(item: NewCartLine, options: Pick<CartAddOptions, "onFailure"> = {}): Promise<boolean> {
  const result = await putLinesInCart([item], { quantity: "set", requirePersistence: true });
  if ("failure" in result) options.onFailure?.(result.failure);
  return "keys" in result;
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

/** The key a stored line must live under; null when it can't be keyed. */
function storedLineKey(item: Omit<CartItem, "quantity">): string | null {
  if (!item.variantId) return null;
  if (hasLineIdentity(item) === ((item.propertiesHash ?? NO_PROPERTIES_HASH) === NO_PROPERTIES_HASH)) return null;
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
  moves?: ReadonlyMap<string, string>,
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

  const ordered = moves?.size ? linesInPlace(state.items, items, moves) : items;
  // A line added (or grown) while signed in makes the cart the account's.
  const added = patches.some((patch) => patch.quantity > (state.items[patch.lineKey]?.quantity ?? 0));
  const nextState = normalizeCartTotals({ ...state, items: ordered, ...(added && signedInHint() ? { accountCart: true as const } : {}) });
  return {
    ok: true,
    state: nextState,
  };
}

/**
 * The patched lines in the cart's order, a line moved to a new key (its
 * inputs edited) standing where the old one stood; new lines last.
 */
function linesInPlace(
  before: CartStore["items"],
  after: CartStore["items"],
  moves: ReadonlyMap<string, string>,
): CartStore["items"] {
  const ordered: CartStore["items"] = {};
  for (const key of Object.keys(before)) {
    const next = after[key] ? key : moves.get(key);
    if (next && after[next] && !(next in ordered)) ordered[next] = after[next]!;
  }
  for (const [key, item] of Object.entries(after)) if (!(key in ordered)) ordered[key] = item;
  return ordered;
}

function applyLinePatchesToLiveStore(
  patches: CartAbsoluteQuantityPatch[],
  trustedExistingItemReplacements?: ReadonlyMap<
    string,
    Omit<CartItem, "quantity">
  >,
  requirePersistence = false,
  moves?: ReadonlyMap<string, string>,
): CartLinePatchResult {
  ensureCartHydrated();
  const result = planLinePatches(
    cartStore.get(),
    patches,
    trustedExistingItemReplacements,
    moves,
  );
  if (!result.ok) return result;
  if (requirePersistence) {
    try {
      localStorage.setItem(CART_STORAGE_KEY, storedCartJson(result.state));
    } catch {
      return patchFailure("storage_unavailable");
    }
  }
  cartStore.set(result.state);
  emitCartUpdated();
  return result;
}
