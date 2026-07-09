import { map } from "nanostores";

export type CartItemOption = {
  name: string;
  label: string;
};

export type CartItem = {
  id: string;
  slug?: string;
  name: string;
  price: number;
  quantity: number;
  image?: string;
  variantId?: string;
  size?: string;
  color?: string;
  options?: CartItemOption[];
  freeDelivery?: boolean;
};

export type VariantCartItem = CartItem & { variantId: string };

export type Discount = {
  id: string;
  code: string;
  type: string;
  valueType: string;
  discountValue: number;
  discountAmount: number;
  combineWithProductDiscounts?: boolean;
  combineWithOrderDiscounts?: boolean;
  combineWithShippingDiscounts?: boolean;
};

export type CartStore = {
  items: Record<string, VariantCartItem>;
  totalItems: number;
  totalAmount: number;
  discount: Discount | null;
  revision: number;
  appliedOperationIds: string[];
};

export type CartStateSnapshot = Pick<
  CartStore,
  "items" | "totalItems" | "totalAmount" | "discount"
> &
  Partial<Pick<CartStore, "revision" | "appliedOperationIds">>;

export type CartAbsoluteQuantityPatch = {
  lineKey: string;
  productId: string;
  variantId: string;
  quantity: number;
  /** Required only when the exact line does not yet exist. */
  item?: Omit<CartItem, "quantity">;
};

export type CartPatchRequest = {
  operationId: string;
  expectedRevision: number;
  expectedFingerprint: string;
  patches: CartAbsoluteQuantityPatch[];
};

export type CartPatchFailureCode =
  | "invalid_operation_id"
  | "invalid_expected_revision"
  | "invalid_fingerprint"
  | "operation_replayed"
  | "revision_exhausted"
  | "revision_mismatch"
  | "fingerprint_mismatch"
  | "invalid_patch_count"
  | "duplicate_line_key"
  | "invalid_line_key"
  | "line_not_found"
  | "invalid_product"
  | "invalid_variant"
  | "invalid_quantity"
  | "item_not_allowed"
  | "item_required";

export type CartPatchFailure = {
  ok: false;
  code: CartPatchFailureCode;
  revision: number;
  fingerprint: string;
};

export type CartPatchSuccess = {
  ok: true;
  state: CartStore;
  revision: number;
  fingerprint: string;
  changedLineKeys: string[];
};

export type CartPatchResult = CartPatchFailure | CartPatchSuccess;

export type CartLineItemUpdate = {
  lineKey: string;
  updates: Partial<
    Pick<CartItem, "name" | "price" | "quantity" | "freeDelivery">
  >;
};

export const MAX_CART_QUANTITY = 99;
export const MAX_CART_PATCH_LINES = 100;
export const MAX_CART_OPERATION_HISTORY = 100;

const MAX_CART_ID_LENGTH = 160;
const MAX_CART_LINE_KEY_LENGTH = 512;
const MAX_CART_OPERATION_ID_LENGTH = 120;
const CART_OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const CART_FINGERPRINT_PATTERN = /^cart_v1_[a-f0-9]{8}$/;

const EMPTY_CART_STATE: CartStore = {
  items: {},
  totalItems: 0,
  totalAmount: 0,
  discount: null,
  revision: 0,
  appliedOperationIds: [],
};

let hasHydratedFromStorage = false;
let canPersistToStorage = false;

export const cartStore = map<CartStore>({ ...EMPTY_CART_STATE });

if (typeof window !== "undefined") {
  cartStore.subscribe((state) => {
    if (!canPersistToStorage) return;
    try {
      localStorage.setItem("cart", JSON.stringify(state));
    } catch (error) {
      console.warn("Could not persist cart state.", error);
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeRevision(value: unknown): number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : 0;
}

function nextRevision(value: unknown): number {
  const revision = normalizeRevision(value);
  return revision < Number.MAX_SAFE_INTEGER ? revision + 1 : revision;
}

function isValidOperationId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_CART_OPERATION_ID_LENGTH &&
    CART_OPERATION_ID_PATTERN.test(value)
  );
}

function normalizeOperationIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const unique = new Set<string>();
  for (const entry of value.slice(-MAX_CART_OPERATION_HISTORY * 2)) {
    if (isValidOperationId(entry)) unique.add(entry);
  }
  return Array.from(unique).slice(-MAX_CART_OPERATION_HISTORY);
}

function normalizeStoredCartOptions(value: unknown): CartItemOption[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const options: CartItemOption[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    if (typeof entry.name !== "string" || typeof entry.label !== "string") {
      continue;
    }

    const name = entry.name.trim();
    const label = entry.label.trim();
    if (!name || !label) continue;
    options.push({ name, label });
    if (options.length >= 2) break;
  }

  return options.length > 0 ? options : undefined;
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
    variantId,
    size: typeof value.size === "string" ? value.size : undefined,
    color: typeof value.color === "string" ? value.color : undefined,
    options: normalizeStoredCartOptions(value.options),
    freeDelivery:
      typeof value.freeDelivery === "boolean" ? value.freeDelivery : undefined,
  };
}

function normalizeStoredDiscount(value: unknown): Discount | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== "string" ||
    typeof value.code !== "string" ||
    typeof value.type !== "string" ||
    typeof value.valueType !== "string"
  ) {
    return null;
  }

  return {
    id: value.id,
    code: value.code,
    type: value.type,
    valueType: value.valueType,
    discountValue: toNumber(value.discountValue),
    discountAmount: toNumber(value.discountAmount),
    combineWithProductDiscounts:
      typeof value.combineWithProductDiscounts === "boolean"
        ? value.combineWithProductDiscounts
        : undefined,
    combineWithOrderDiscounts:
      typeof value.combineWithOrderDiscounts === "boolean"
        ? value.combineWithOrderDiscounts
        : undefined,
    combineWithShippingDiscounts:
      typeof value.combineWithShippingDiscounts === "boolean"
        ? value.combineWithShippingDiscounts
        : undefined,
  };
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
    discount: totalItems === 0 ? null : state.discount,
  };
}

export function getCartRevision(cart: CartStateSnapshot | null | undefined): number {
  return normalizeRevision(cart?.revision);
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function canonicalFingerprintValue(
  cart: CartStateSnapshot | null | undefined,
): string {
  const items = Object.entries(cart?.items ?? {})
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([lineKey, item]) => ({
      lineKey,
      id: item.id,
      variantId: item.variantId ?? null,
      quantity: item.quantity,
      price: item.price,
      size: item.size ?? null,
      color: item.color ?? null,
      options: (item.options ?? []).map((option) => [option.name, option.label]),
      freeDelivery: item.freeDelivery === true,
    }));
  return JSON.stringify({ items, hasDiscount: Boolean(cart?.discount) });
}

/** Deterministic, non-secret state fingerprint used together with revision checks. */
export function getCartFingerprint(
  cart: CartStateSnapshot | null | undefined,
): string {
  return `cart_v1_${fnv1a(canonicalFingerprintValue(cart))}`;
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
    discount: normalizeStoredDiscount(value.discount),
    revision: normalizeRevision(value.revision),
    appliedOperationIds: normalizeOperationIds(value.appliedOperationIds),
  });
}

export function hydrateCartFromStorage(): CartStore {
  if (typeof window === "undefined") return cartStore.get();
  if (hasHydratedFromStorage) return cartStore.get();

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
      cartStore.set(normalized);
      const normalizedJson = JSON.stringify(normalized);
      if (normalizedJson !== storedCart) {
        try {
          localStorage.setItem("cart", normalizedJson);
        } catch (error) {
          console.warn("Could not persist migrated cart state.", error);
        }
      }
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
  const current = cartStore.get();
  if (current.revision >= Number.MAX_SAFE_INTEGER) return current;
  const next = normalizeCartTotals({
    ...state,
    revision: nextRevision(current.revision),
    appliedOperationIds: normalizeOperationIds(current.appliedOperationIds),
  });
  cartStore.set(next);
  emitCartUpdated();
  return next;
}

let localOperationSequence = 0;

function createLocalCartOperationId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `local:${globalThis.crypto.randomUUID()}`;
  }
  localOperationSequence = (localOperationSequence + 1) % 1_000_000;
  return `local:${Date.now().toString(36)}:${localOperationSequence.toString(36)}`;
}

function applyLocalLinePatch(
  patches: CartAbsoluteQuantityPatch[],
  trustedExistingItemReplacements?: ReadonlyMap<
    string,
    Omit<CartItem, "quantity">
  >,
): CartPatchResult {
  const current = cartStore.get();
  return applyCartPatchToLiveStore(
    {
      operationId: createLocalCartOperationId(),
      expectedRevision: current.revision,
      expectedFingerprint: getCartFingerprint(current),
      patches,
    },
    trustedExistingItemReplacements,
  );
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

  return applyLocalLinePatch([
    {
      lineKey: itemKey,
      productId: item.id,
      variantId,
      quantity,
      ...(!existingItem ? { item } : {}),
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
  updates: Partial<Pick<CartItem, "name" | "price" | "quantity" | "freeDelivery">>,
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
    updatesByLine.length > MAX_CART_PATCH_LINES
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
      variantId: existingItem.variantId,
      ...(refreshed.size ? { size: refreshed.size } : {}),
      ...(refreshed.color ? { color: refreshed.color } : {}),
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

export function applyDiscount(discount: Discount): void {
  ensureCartHydrated();
  commitNonLineCartState({ ...cartStore.get(), discount });
  if (typeof document !== "undefined") {
    document.dispatchEvent(new CustomEvent("discount-applied"));
  }
}

export function removeDiscount(): void {
  ensureCartHydrated();
  const current = cartStore.get();
  if (!current.discount) return;
  commitNonLineCartState({ ...current, discount: null });
  if (typeof document !== "undefined") {
    document.dispatchEvent(new CustomEvent("discount-removed"));
  }
}

export function clearCart(): void {
  ensureCartHydrated();
  const current = cartStore.get();
  if (Object.keys(current.items).length === 0 && !current.discount) return;
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
    commitNonLineCartState({ ...current, discount: null });
  }
}

function patchFailure(
  state: CartStore,
  code: CartPatchFailureCode,
): CartPatchFailure {
  return {
    ok: false,
    code,
    revision: getCartRevision(state),
    fingerprint: getCartFingerprint(state),
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
): CartPatchFailureCode | null {
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
): CartPatchFailureCode | null {
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
 * Plans one absolute-quantity transaction without touching the live store.
 * Every patch is validated first; any failure returns the original state.
 */
function planAtomicCartPatchInternal(
  sourceState: CartStore,
  request: CartPatchRequest,
  trustedExistingItemReplacements?: ReadonlyMap<
    string,
    Omit<CartItem, "quantity">
  >,
): CartPatchResult {
  const state = normalizeCartTotals({
    ...sourceState,
    revision: getCartRevision(sourceState),
    appliedOperationIds: normalizeOperationIds(sourceState.appliedOperationIds),
  });

  if (!isValidOperationId(request.operationId)) {
    return patchFailure(state, "invalid_operation_id");
  }
  if (
    !Number.isSafeInteger(request.expectedRevision) ||
    request.expectedRevision < 0
  ) {
    return patchFailure(state, "invalid_expected_revision");
  }
  if (
    typeof request.expectedFingerprint !== "string" ||
    !CART_FINGERPRINT_PATTERN.test(request.expectedFingerprint)
  ) {
    return patchFailure(state, "invalid_fingerprint");
  }
  if (state.appliedOperationIds.includes(request.operationId)) {
    return patchFailure(state, "operation_replayed");
  }
  if (state.revision >= Number.MAX_SAFE_INTEGER) {
    return patchFailure(state, "revision_exhausted");
  }
  if (request.expectedRevision !== getCartRevision(state)) {
    return patchFailure(state, "revision_mismatch");
  }
  if (request.expectedFingerprint !== getCartFingerprint(state)) {
    return patchFailure(state, "fingerprint_mismatch");
  }
  if (
    !Array.isArray(request.patches) ||
    request.patches.length < 1 ||
    request.patches.length > MAX_CART_PATCH_LINES
  ) {
    return patchFailure(state, "invalid_patch_count");
  }

  const seenLineKeys = new Set<string>();
  for (const patch of request.patches) {
    if (
      typeof patch.lineKey !== "string" ||
      patch.lineKey.length < 1 ||
      patch.lineKey.length > MAX_CART_LINE_KEY_LENGTH
    ) {
      return patchFailure(state, "invalid_line_key");
    }
    if (seenLineKeys.has(patch.lineKey)) {
      return patchFailure(state, "duplicate_line_key");
    }
    seenLineKeys.add(patch.lineKey);

    if (!isValidIdentity(patch.productId)) {
      return patchFailure(state, "invalid_product");
    }
    if (!isValidIdentity(patch.variantId) || patch.variantId === "default") {
      return patchFailure(state, "invalid_variant");
    }
    if (
      !Number.isInteger(patch.quantity) ||
      patch.quantity < 0 ||
      patch.quantity > MAX_CART_QUANTITY
    ) {
      return patchFailure(state, "invalid_quantity");
    }

    const existing = state.items[patch.lineKey];
    if (existing) {
      if (existing.id !== patch.productId) {
        return patchFailure(state, "invalid_product");
      }
      if ((existing.variantId ?? undefined) !== patch.variantId) {
        return patchFailure(state, "invalid_variant");
      }
      if (patch.item) return patchFailure(state, "item_not_allowed");
      const replacement = trustedExistingItemReplacements?.get(patch.lineKey);
      const itemError = replacement
        ? validateExistingItemReplacement(
            patch.lineKey,
            replacement,
            existing,
          )
        : null;
      if (itemError) return patchFailure(state, itemError);
      continue;
    }

    if (patch.quantity === 0) {
      return patchFailure(state, "line_not_found");
    }
    const itemError = validateNewPatchItem(patch);
    if (itemError) return patchFailure(state, itemError);
  }

  const items = { ...state.items };
  for (const patch of request.patches) {
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

  const nextState = normalizeCartTotals({
    ...state,
    items,
    discount: null,
    revision: nextRevision(state.revision),
    appliedOperationIds: [
      ...normalizeOperationIds(state.appliedOperationIds),
      request.operationId,
    ].slice(-MAX_CART_OPERATION_HISTORY),
  });
  return {
    ok: true,
    state: nextState,
    revision: getCartRevision(nextState),
    fingerprint: getCartFingerprint(nextState),
    changedLineKeys: request.patches.map((patch) => patch.lineKey),
  };
}

export function planAtomicCartPatch(
  sourceState: CartStore,
  request: CartPatchRequest,
): CartPatchResult {
  return planAtomicCartPatchInternal(sourceState, request);
}

function applyCartPatchToLiveStore(
  request: CartPatchRequest,
  trustedExistingItemReplacements?: ReadonlyMap<
    string,
    Omit<CartItem, "quantity">
  >,
): CartPatchResult {
  ensureCartHydrated();
  const result = planAtomicCartPatchInternal(
    cartStore.get(),
    request,
    trustedExistingItemReplacements,
  );
  if (!result.ok) return result;
  cartStore.set(result.state);
  emitCartUpdated();
  return result;
}

/** Applies a successful public plan with one store write and one cart-updated event. */
export function applyAtomicCartPatch(request: CartPatchRequest): CartPatchResult {
  return applyCartPatchToLiveStore(request);
}
