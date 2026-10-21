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
    purchaseOption: null,
    ...overrides,
  };
}

/** A guest's online-store cart in BDT (two decimal places); override any field, including `lines`. */
function cart(overrides: Partial<FunctionCart> = {}): FunctionCart {
  const lines = overrides.lines ?? [cartLine()];
  return {
    currency: "BDT",
    decimalPlaces: 2,
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

export const fixtures = { event, cartLine, cart, checkoutDiscountsInput, storefrontExtensionInput, money, readRecord, adminRouteRequest };
