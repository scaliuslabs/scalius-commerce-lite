// `@scalius/plugin-sdk/fixtures`: typed builders for what the platform hands
// a plugin, so a test states only what it cares about. Every builder returns
// a complete, valid value; pass overrides for the rest.
//
//   harness.deliver(fixtures.event("order.created", { resource: { type: "order", id: "o1" } }));
//   harness.fn("checkout.discounts", fixtures.checkoutDiscountsInput({ cart: { subtotalMinor: 150_000 } }));
//   harness.route("admin", "overview", fixtures.adminRouteRequest({ query: { cursor: "abc" } }));
//   harness.extension(fixtures.storefrontExtensionInput("checkout.contact.after", { attributes: { gift_message: "Hi" } }));

import type { EventTopic } from "@scalius/shared/events";
import { STOREFRONT_UI_SLOT_PAGES, type StorefrontUiSlot } from "@scalius/shared/plugins/storefront-protocol";
import type { BuyerUiInput, FunctionCart, FunctionReads, PluginFunctionInput } from "@scalius/shared/plugins";
import type { BuyerEvent, BuyerEventData, BuyerLine, BuyerMerchandise, PixelEventName } from "@scalius/shared/plugins/buyer-events";
import type { PluginEvent, PluginMoney, PluginRouteRequest } from "./context";

let eventCounter = 0;

/** A delivered event: a fresh id, now, and a resource named after the topic (`order.paid` is about an `order`). */
function event<T extends EventTopic>(topic: T, overrides: Partial<PluginEvent<T>> = {}): PluginEvent<T> {
  eventCounter += 1;
  const type = topic.split(".")[0] ?? "resource";
  return {
    id: `evt_test_${eventCounter}`,
    topic,
    apiVersion: "2026-10",
    occurredAt: new Date().toISOString(),
    resource: { type, id: `${type}_test_${eventCounter}` },
    facts: {},
    ...overrides,
  };
}

/** One cart line: a single T-shirt, 2 x 500.00 BDT. */
function cartLine(overrides: Partial<FunctionCart["lines"][number]> = {}): FunctionCart["lines"][number] {
  return {
    lineId: "line_1",
    productId: "prod_1",
    variantId: "var_1",
    sku: "TSHIRT-M",
    title: "T-shirt",
    quantity: 2,
    unitPriceMinor: 50_000,
    lineTotalMinor: 100_000,
    categoryIds: [],
    collectionIds: [],
    brandId: null,
    properties: {},
    requiresShipping: true,
    weightGrams: null,
    shippingProfileId: "shp_default",
    purchaseOptions: [],
    addOns: [],
    ...overrides,
  };
}

/** A guest's online-store cart in BDT (two decimal places); override any field, including `lines`. */
function cart(overrides: Partial<FunctionCart> = {}): FunctionCart {
  const lines = overrides.lines ?? [cartLine()];
  const currency = overrides.currency ?? "BDT";
  const decimalPlaces = overrides.decimalPlaces ?? 2;
  return {
    currency,
    decimalPlaces,
    // The store sells in the cart's currency unless the test says otherwise.
    storeCurrency: { code: currency, decimalPlaces },
    channel: "online_store",
    salesChannelId: "sc_online_store",
    lines,
    subtotalMinor: lines.reduce((sum, line) => sum + line.lineTotalMinor, 0),
    customer: null,
    destination: null,
    discountCodes: [],
    market: { id: "mkt_backup", country: null },
    attributes: {},
    ...overrides,
  };
}

/** The input of the `checkout.discounts` function: a cart (see `cart`) and the function's declared reads (none by default). */
function checkoutDiscountsInput(overrides: { cart?: Partial<FunctionCart>; reads?: FunctionReads } = {}): PluginFunctionInput<"checkout.discounts"> {
  return { cart: cart(overrides.cart), reads: overrides.reads ?? {} };
}

/**
 * An amount as object fields, custom fields and reads carry it: integer minor
 * units of the store currency (the harness store is BDT, 2 decimal places).
 * `money(125_000)` is 1,250 taka.
 */
function money(amountMinor: number, currency = "BDT"): PluginMoney {
  return { amountMinor, currency };
}

/** One read record, as `input.reads` carries it (`{ revision, data }`). */
function readRecord<T extends Record<string, unknown>>(data: T, revision = 1): { revision: number; data: T } {
  return { revision, data };
}

/** A dashboard request to an admin route: a GET by a staff member, with no query or body. */
function adminRouteRequest(overrides: Partial<PluginRouteRequest> = {}): PluginRouteRequest {
  return {
    method: "GET",
    subpath: "",
    query: {},
    headers: {},
    body: null,
    rawBody: null,
    staffId: "staff_test",
    ...overrides,
  };
}

/** What a storefront extension gets: `attributes` by your own bare keys; `cart` takes the `cart` fixture's overrides. */
type StorefrontExtensionInputOverrides = Partial<Omit<BuyerUiInput, "target" | "cart">> & { cart?: Partial<FunctionCart> | null };

/**
 * The input of one storefront extension at a UI slot, as the host sends it
 * (pass it to `harness.extension`). By the slot's page: a checkout or cart
 * drawer slot gets a cart (see `cart`), an order slot (`order.confirmation`,
 * `account.order`) a paid order of the cart fixture's line, and an `account.*`
 * slot a signed-in customer; the rest are null (a guest's thank-you page).
 * English, BDT, no answers and no reads unless overridden. `attributes` holds
 * the buyer's answers to your own checkout attributes by bare key
 * (`gift_message`); `cart.attributes` the same answers by `<app id>.<key>`.
 */
function storefrontExtensionInput(target: StorefrontUiSlot, overrides: StorefrontExtensionInputOverrides = {}): BuyerUiInput {
  const page = STOREFRONT_UI_SLOT_PAGES[target];
  const { cart: cartOverrides, ...rest } = overrides;
  const builtCart = cartOverrides === null ? null
    : cartOverrides !== undefined || page === "checkout" || page === "cart_drawer" ? cart(cartOverrides ?? {}) : null;
  return {
    target,
    language: "en",
    locale: "en-BD",
    currency: "BDT",
    cart: builtCart,
    attributes: {},
    order: page === "order"
      ? { orderId: "order_test_1", status: "confirmed", paymentStatus: "paid", lines: [{ productId: "prod_1", variantId: "var_1", quantity: 2 }] }
      : null,
    customer: target.startsWith("account.") ? { id: "cust_test_1" } : null,
    reads: {},
    ...rest,
  };
}

// ── Buyer events (pixels) ────────────────────────────────────────────────

type DeepPartial<T> = T extends readonly (infer U)[] ? U[] : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> | null } : T;

const merchandise = (): BuyerMerchandise => ({ productId: "prod_1", variantId: "var_1", title: "T-shirt", price: { amountMinor: 50_000, currency: "BDT" } });
const buyerLine = (): BuyerLine => ({ merchandise: merchandise(), quantity: 2 });
const checkoutOf = () => ({ id: "chk_test_1", lines: [buyerLine()], itemCount: 2, total: { amountMinor: 100_000, currency: "BDT" } });

/** Each buyer event's data as a store sends it: a 2 x 500.00 BDT T-shirt, a checkout quoted at 1,000.00 BDT. */
const BUYER_EVENT_DATA: { [N in PixelEventName]: () => BuyerEventData[N] } = {
  page_viewed: () => ({}),
  product_viewed: () => ({ merchandise: { ...merchandise(), variantId: null }, category: "Clothing" }),
  collection_viewed: () => ({ collection: { kind: "category", id: "cat_1", title: "Clothing" }, products: [merchandise()] }),
  search_submitted: () => ({ query: "t-shirt", results: [merchandise()] }),
  product_added_to_cart: () => ({ line: buyerLine() }),
  product_removed_from_cart: () => ({ line: { ...buyerLine(), quantity: 1 } }),
  cart_viewed: () => ({ lines: [buyerLine()], total: { amountMinor: 100_000, currency: "BDT" } }),
  checkout_started: () => ({ checkout: checkoutOf() }),
  checkout_contact_submitted: () => ({ checkout: checkoutOf(), contact: { email: "buyer@example.com", phone: "+8801700000000" } }),
  checkout_address_submitted: () => ({
    checkout: checkoutOf(),
    address: { name: "Test Buyer", line1: "House 1, Road 2", line2: null, locality: "Dhanmondi", adminArea: "Dhaka", postalCode: "1209", countryCode: "BD" },
  }),
  checkout_shipping_submitted: () => ({ checkout: checkoutOf(), shipping: { kind: "delivery", methodId: "ship_1", title: "Inside Dhaka", cost: { amountMinor: 6_000, currency: "BDT" } } }),
  checkout_payment_submitted: () => ({ checkout: checkoutOf(), payment: { method: "cod" } }),
  checkout_completed: () => ({ checkout: checkoutOf(), order: { id: "order_test_1" } }),
  app_event: () => ({ app: "acme.test", name: "quiz_finished", payload: {} }),
};

function mergeInto(base: unknown, overrides: unknown): unknown {
  if (overrides === undefined) return base;
  if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides) || base === null || typeof base !== "object" || Array.isArray(base)) return overrides;
  const merged: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(overrides as Record<string, unknown>)) merged[key] = mergeInto(merged[key], value);
  return merged;
}

/**
 * One buyer event as the store's bus carries it, for a pixel test
 * (`createPixelTestHarness`). `data` overrides merge into the defaults
 * (`{ checkout: { total: null } }`); a list replaces the default list.
 * Money is `{ amountMinor, currency }`, and it can be null: a product with no
 * price shown (`merchandise.price`), a cart or checkout before a quote
 * (`total`), a delivery not yet priced (`shipping.cost`). Handle null.
 */
function buyerEvent<N extends PixelEventName>(name: N, data: DeepPartial<BuyerEventData[N]> = {} as DeepPartial<BuyerEventData[N]>, overrides: Partial<Omit<BuyerEvent<N>, "name" | "data">> = {}): BuyerEvent<N> {
  eventCounter += 1;
  return {
    id: `bev_test_${eventCounter}`,
    name,
    timestamp: new Date().toISOString(),
    data: mergeInto(BUYER_EVENT_DATA[name](), data) as BuyerEventData[N],
    ...overrides,
  };
}

export const fixtures = { event, cartLine, cart, checkoutDiscountsInput, storefrontExtensionInput, money, readRecord, adminRouteRequest, buyerEvent };
