// `@scalius/plugin-sdk/fixtures`: typed builders for what the platform hands
// a plugin, so a test states only what it cares about. Every builder returns
// a complete, valid value; pass overrides for the rest.
//
//   harness.deliver(fixtures.event("order.created", { resource: { type: "order", id: "o1" } }));
//   harness.fn("checkout.discounts", fixtures.checkoutDiscountsInput({ cart: { subtotalMinor: 150_000 } }));
//   harness.route("admin", "overview", fixtures.adminRouteRequest({ query: { cursor: "abc" } }));

import type { EventTopic } from "@scalius/shared/events";
import type { FunctionCart, FunctionReads, PluginFunctionInput } from "@scalius/shared/plugins";
import type { PluginEvent, PluginRouteRequest } from "./context";

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

export const fixtures = { event, cartLine, cart, checkoutDiscountsInput, readRecord, adminRouteRequest };
