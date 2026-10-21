import { describe, expect, it } from "vitest";
import {
  PLUGIN_PROVIDERS_MAX,
  PROVIDER_KINDS,
  PROVIDER_OPERATIONS,
  PROVIDER_PORTS,
  ProviderError,
  decodeProviderAmount,
  encodeProviderAmount,
  isQualifiedProviderId,
  parseQualifiedProviderId,
  providerErrorOf,
  providerOperationSchemas,
  providerServesCountry,
  qualifiedProviderId,
  declaredCourierBookingOptions,
} from "../providers";
import { PLUGIN_API_VERSION } from "../api-version";
import { checkPluginHandlers, pluginHandlerInventory } from "../handlers";
import { parsePluginManifest, pluginGrantRequest } from "../manifest";

const manifest = {
  id: "acme.wallet",
  name: "Acme wallet",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Port contract fixtures.",
  author: { name: "Acme" },
  // Every port these fixtures declare receives its buyer data (COMMERCE-HOOKS H5).
  scopes: ["read_customer_names", "read_customer_emails", "read_customer_phones", "read_customer_addresses"],
};

const HOSTED_REFUNDS = ["verifyReturn", "queryPayment", "refund", "refundStatus"];
const wire = (minor: number, decimal: string) => ({ minor, decimal });
const request = { method: "POST", rawBody: "{}", headers: { "x-signature": "abc" }, query: {} };
const recipient = {
  name: "Buyer", phone: "+8801700000000", company: null, line1: "House 1, Road 2", line2: null, dependentLocality: null,
  locality: "Dhaka", adminArea: null, postalCode: null, countryCode: "BD",
  placeIds: { city: "c1", zone: "z1", area: null }, placeNames: { city: "Dhaka", zone: "Gulshan", area: null },
};

/** One valid input and output per operation that has meaningful money or identity rules. */
const SAMPLES: Array<[string, string, unknown, unknown]> = [
  ["payment", "createSession", {
    attemptKey: "attempt-1", correlationId: "ORD1_full_ABCDEF12", orderId: "ORD1", paymentType: "full",
    amountMinor: 12_550, currency: "BDT", wireAmount: wire(12_550, "125.50"),
    buyer: { name: "Buyer", phone: "+8801700000000" },
    urls: { success: "https://api.test/s", fail: "https://api.test/f", cancel: "https://api.test/c", webhook: "https://api.test/w" },
    requestTimeoutMs: 10_000,
  }, { providerRef: "TR001", redirectUrl: "https://wallet.test/pay/TR001" }],
  ["payment", "verifyWebhook", request, {
    status: "event",
    event: { kind: "confirmed", eventType: "payment", eventId: "TR001", orderId: "ORD1", providerRef: "TR001", amountMinor: 12_550, currency: "BDT" },
  }],
  ["payment", "refund", {
    providerRef: "TR001", secondaryRef: null, amountMinor: 500, currency: "BDT", wireAmount: wire(500, "5.00"),
    reason: "requested_by_customer", idempotencyKey: "refund-1", reference: "RF1", metadata: {},
  }, { refundId: "RF-PROVIDER-1" }],
  ["payment", "chargeSavedMethod", {
    attemptKey: "pcharge_1", correlationId: "ORD1_full_ABCDEF12", orderId: "ORD1", paymentType: "full",
    amountMinor: 12_550, currency: "BDT", wireAmount: wire(12_550, "125.50"), methodRef: "pm_1", capture: "automatic",
    requestTimeoutMs: 10_000,
  }, { status: "declined", reason: "Insufficient funds", code: "insufficient_funds" }],
  ["payment", "capture", {
    providerRef: "pi_1", orderId: "ORD1", amountMinor: 12_550, currency: "BDT", wireAmount: wire(12_550, "125.50"), idempotencyKey: "capture:pay_1",
  }, { status: "pending", providerRef: "pi_1" }],
  ["payment", "void", { providerRef: "pi_1", orderId: "ORD1", idempotencyKey: "void:pay_1" }, { status: "voided" }],
  ["payment", "deleteSavedMethod", { ref: "pm_1", idempotencyKey: "delete:cpm_1" }, { status: "not_found" }],
  ["courier", "createShipment", {
    idempotencyKey: "shp_1", orderId: "ORD1", recipient, codAmountMinor: 12_550, currency: "BDT", decimalPlaces: 2,
    note: null, itemCount: 1, itemDescription: null, parcel: { weightGrams: 500, dimensionsCm: null }, options: {},
  }, { externalId: "CN1", trackingId: null, status: "pending", rawStatus: "Pending", chargeMinor: 6000, label: null }],
  ["courier", "trackShipment", { externalId: "CN1" }, { status: "delivered", rawStatus: "Delivered", updatedAt: "2026-10-03T10:00:00+06:00" }],
  ["sms", "send", { to: "+8801700000000", text: "Your order shipped", idempotencyKey: "outbox1" }, { success: true, providerRef: "m1" }],
  ["email", "send", { to: "buyer@example.test", subject: "Shipped", html: "<p>Shipped</p>" }, { success: false, retryable: true }],
  ["courier_history", "check", { phone: "+8801700000000" }, { riskLevel: "low", phone: "01700000000", totalParcels: 10, delivered: 9, cancelled: 1, successRate: 90 }],
  ["tax", "calculate", {
    idempotencyKey: "tax-1", currency: "BDT", pricesIncludeTax: false,
    destination: { country: "BD", adminArea: null, city: "Dhaka", postalCode: null }, origin: null,
    lines: [{ lineId: "l1", taxCode: null, quantity: 1, amountMinor: 10_000 }], shippingMinor: 6000, customer: null,
  }, { calculationId: "calc-1", lines: [{ lineId: "l1", taxes: [{ taxMinor: 500, rateBps: 500, jurisdiction: "BD" }] }], shipping: [] }],
];

describe("provider port contracts", () => {
  it("lists exactly the operations each port defines", () => {
    for (const kind of PROVIDER_KINDS) {
      const listed = [...PROVIDER_OPERATIONS[kind].required, ...PROVIDER_OPERATIONS[kind].optional].sort();
      expect(Object.keys(PROVIDER_PORTS[kind]).sort()).toEqual(listed);
    }
  });

  it.each(SAMPLES)("validates %s.%s on both sides and refuses extra fields", (kind, operation, input, output) => {
    const schemas = providerOperationSchemas(kind as never, operation)!;
    expect(schemas.input.safeParse(input).success).toBe(true);
    expect(schemas.output.safeParse(output).success).toBe(true);
    expect(schemas.input.safeParse({ ...(input as object), unexpected: true }).success).toBe(false);
    if (!("status" in (output as object) && (output as { status: unknown }).status === "event")) {
      expect(schemas.output.safeParse({ ...(output as object), rawProviderBody: "{}" }).success).toBe(false);
    }
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY])("refuses %s as minor units", (amount) => {
    const session = SAMPLES[0]![2] as Record<string, unknown>;
    expect(PROVIDER_PORTS.payment.createSession.input.safeParse({ ...session, amountMinor: amount }).success).toBe(false);
  });

  it("only accepts a confirmed payment with its authenticated amount and currency", () => {
    const event = { kind: "confirmed", eventType: "payment", eventId: "e1", orderId: "o1", providerRef: "p1" };
    const output = PROVIDER_PORTS.payment.verifyReturn.output;
    expect(output.safeParse({ status: "event", event }).success).toBe(false);
    expect(output.safeParse({ status: "event", event: { ...event, amountMinor: 100, currency: "BDT" } }).success).toBe(true);
    expect(output.safeParse({ status: "event", event: { ...event, kind: "cancelled", correlationId: "o1_full_ABCDEF12" } }).success).toBe(true);
    expect(output.safeParse({ status: "invalid", reason: "Bad signature" }).success).toBe(true);
    expect(output.safeParse({ status: "approved" }).success).toBe(false);
  });

  it("keeps saved methods to a reference and display facts, and authorizations to money held", () => {
    const authorized = { kind: "authorized", eventType: "payment.authorized", eventId: "e1", orderId: "o1", providerRef: "pi_1", amountMinor: 100, currency: "BDT" };
    const charge = PROVIDER_PORTS.payment.chargeSavedMethod.output;
    const method = { ref: "pm_1", brand: "visa", last4: "4242", expiryMonth: 12, expiryYear: 2030, label: "Work card" };
    expect(charge.safeParse({ status: "event", event: { ...authorized, savedPaymentMethod: method } }).success).toBe(true);
    // An authorization carries its amount; a charge never answers a refund or a cancel.
    expect(charge.safeParse({ status: "event", event: { ...authorized, amountMinor: undefined } }).success).toBe(false);
    expect(charge.safeParse({ status: "event", event: { ...authorized, kind: "cancelled" } }).success).toBe(false);
    // Never a card number, a CVC or anything but four digits.
    for (const leak of [{ ...method, last4: "4242424242424242" }, { ...method, last4: "42a2" }, { ...method, cvc: "123" }, { ...method, number: "4242424242424242" }]) {
      expect(charge.safeParse({ status: "event", event: { ...authorized, savedPaymentMethod: leak } }).success).toBe(false);
    }
    // Only money held or captured names a kept method.
    expect(PROVIDER_PORTS.payment.verifyWebhook.output.safeParse({
      status: "event", event: { kind: "failed", eventType: "x", eventId: "e2", orderId: "o1", providerRef: "pi_1", savedPaymentMethod: method },
    }).success).toBe(false);
    // A capture answers a confirmed payment only.
    expect(PROVIDER_PORTS.payment.capture.output.safeParse({ status: "event", event: authorized }).success).toBe(false);
    expect(PROVIDER_PORTS.payment.capture.output.safeParse({ status: "event", event: { ...authorized, kind: "confirmed" } }).success).toBe(true);
    // A session asks to keep the method only for a customer, off-session.
    const session = SAMPLES[0]![2] as Record<string, unknown>;
    const input = PROVIDER_PORTS.payment.createSession.input;
    expect(input.safeParse({ ...session, savePaymentMethod: { customerId: "cust_1", usage: "off_session" } }).success).toBe(true);
    expect(input.safeParse({ ...session, savePaymentMethod: { customerId: "cust_1", usage: "on_session" } }).success).toBe(false);
  });

  it("keeps a courier's flat audit facts and push ids, within the booking form's bounds", () => {
    const courier = PROVIDER_PORTS.courier;
    const [, , input, booked] = SAMPLES.find(([kind, operation]) => kind === "courier" && operation === "createShipment")!;
    const tracking = { status: "in_transit", rawStatus: "At the sorting hub", updatedAt: "2026-10-03T10:00:00Z" };
    expect(courier.createShipment.output.safeParse({ ...(booked as object), details: { delivery_fee: 60, invoice: "ORD1", cod: null } }).success).toBe(true);
    expect(courier.createShipment.output.safeParse({ ...(booked as object), details: { recipient: { phone: "+880" } } }).success).toBe(false);
    expect(courier.trackShipment.output.safeParse({ ...tracking, details: { hub: "Dhaka" } }).success).toBe(true);

    const push = { status: "update", externalId: "CN1", tracking };
    expect(courier.verifyWebhook.output.safeParse(push).success).toBe(true);
    expect(courier.verifyWebhook.output.safeParse({ ...push, eventId: "evt-1" }).success).toBe(true);
    expect(courier.verifyWebhook.output.safeParse({ ...push, eventId: "" }).success).toBe(false);
    expect(courier.verifyWebhook.output.safeParse({ ...push, tracking: { ...tracking, status: "lost" } }).success).toBe(false);

    // The courier's expected answer: 2xx, a few safe headers, a small JSON body.
    const reply = { status: 202, headers: { "x-pathao-merchant-webhook-integration-secret": "s" }, body: { success: true, status: "delivered" } };
    expect(courier.verifyWebhook.output.safeParse({ ...push, orderId: "ORD1", reply }).success).toBe(true);
    for (const bad of [{ ...reply, status: 302 }, { ...reply, headers: { "set-cookie": "a=b" } }, { ...reply, headers: { location: "https://evil.test" } }, { ...reply, headers: { "Content-Type": "text/html" } }]) {
      expect(courier.verifyWebhook.output.safeParse({ ...push, reply: bad }).success, JSON.stringify(bad)).toBe(false);
    }
    expect(courier.verifyWebhook.output.safeParse({ status: "note", eventId: "tracking_update:1", externalId: "CN1", details: { lastTrackingMessage: "At hub" } }).success).toBe(true);
    expect(courier.verifyWebhook.output.safeParse({ status: "note", externalId: "CN1", details: {} }).success).toBe(false);
    expect(courier.verifyWebhook.output.safeParse({ status: "invalid", reason: "Missing event", rejectStatus: 400 }).success).toBe(true);
    expect(courier.verifyWebhook.output.safeParse({ status: "invalid", reason: "x", rejectStatus: 200 }).success).toBe(false);
    // A courier that books by its own place ids receives them with the recipient.
    const located = { ...(input as { recipient: object }), recipient: { ...(input as { recipient: object }).recipient, locationIds: { city: "1", zone: "52", area: null } } };
    expect(courier.createShipment.input.safeParse(located).success).toBe(true);

    // The courier's own booking options travel as a bag of declared keys; the parcel's size is the platform's.
    const booking = (options: Record<string, unknown>, parcel: object = { weightGrams: 5_000_000, dimensionsCm: { length: 30, width: 20, height: 10 } }) =>
      courier.createShipment.input.safeParse({ ...(input as object), options, parcel }).success;
    expect(booking({ deliveryType: 48, itemType: 2, express: true, service: "next_day" })).toBe(true);
    expect(booking({ "delivery-type": 48 })).toBe(false);
    expect(booking({ deliveryType: { nested: true } })).toBe(false);
    expect(booking({}, { weightGrams: -1, dimensionsCm: null })).toBe(false);
    expect(booking({}, { weightGrams: null, dimensionsCm: { length: 30, width: 20 } })).toBe(false);
  });

  it("takes each email list header on its own and no other header", () => {
    const send = PROVIDER_PORTS.email.send.input;
    const message = { to: "buyer@example.test", subject: "News", html: "<p>News</p>" };
    expect(send.safeParse({ ...message, headers: { "List-Unsubscribe": "<https://shop.test/u>" } }).success).toBe(true);
    expect(send.safeParse({ ...message, headers: { "List-Unsubscribe": "<https://shop.test/u>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } }).success).toBe(true);
    expect(send.safeParse({ ...message, headers: { "Reply-To": "owner@shop.test" } }).success).toBe(false);
  });

  it("names app providers plugin:provider and keeps built-in ids distinct", () => {
    expect(qualifiedProviderId("scalius.bkash", "bkash")).toBe("scalius.bkash:bkash");
    expect(parseQualifiedProviderId("scalius.bkash:bkash")).toEqual({ pluginId: "scalius.bkash", providerId: "bkash" });
    for (const id of ["stripe", "cod", "pathao", "scalius.bkash", "scalius.bkash:", ":bkash", "Scalius.bkash:bkash", "scalius.bkash:bk/ash", 7]) {
      expect(isQualifiedProviderId(id)).toBe(false);
    }
  });

  it("carries the error category across a loader boundary", () => {
    const thrown = new ProviderError("retryable", "Timed out", { uncertain: true, code: "bkash_timeout" });
    expect(providerErrorOf(structuredClone({ ...thrown, message: thrown.message }))).toMatchObject({ category: "retryable", uncertain: true, code: "bkash_timeout" });
    expect(providerErrorOf(new Error("plain"))).toBeNull();
    expect(new ProviderError("declined", "No", { code: "Not A Code" }).code).toBe("provider_declined");
  });
});

describe("payment amount codec", () => {
  it("sends ISO minor units unchanged by default", () => {
    expect(encodeProviderAmount(12_550, "BDT")).toEqual({ currency: "BDT", chargedMinor: 12_550, roundingMinor: 0, wire: wire(12_550, "125.50") });
    expect(encodeProviderAmount(5, "usd").wire).toEqual(wire(5, "0.05"));
    expect(encodeProviderAmount(1_000, "JPY").wire).toEqual(wire(1_000, "1000"));
  });

  it("widens to a larger wire exponent (two-decimal ISK)", () => {
    expect(encodeProviderAmount(1_500, "ISK", { ISK: { wireExponent: 2 } })).toMatchObject({ roundingMinor: 0, wire: wire(150_000, "1500.00") });
  });

  it("rounds down to the provider increment and reports the difference instead of charging it", () => {
    expect(encodeProviderAmount(12_345, "KWD", { KWD: { minorIncrement: 10 } })).toEqual({
      currency: "KWD", chargedMinor: 12_340, roundingMinor: 5, wire: wire(12_340, "12.340"),
    });
    // A wire without decimals for a two-decimal currency charges whole units only.
    expect(encodeProviderAmount(10_050, "IDR", { IDR: { wireExponent: 0 } })).toMatchObject({ chargedMinor: 10_000, roundingMinor: 50, wire: wire(100, "100") });
  });

  it("decodes a reported wire amount back to ISO minor units, refusing one it could not have sent", () => {
    expect(decodeProviderAmount(12_550, "BDT")).toBe(12_550);
    expect(decodeProviderAmount(150_000, "ISK", { ISK: { wireExponent: 2 } })).toBe(1_500);
    expect(decodeProviderAmount(150_050, "ISK", { ISK: { wireExponent: 2 } })).toBeNull();
    expect(decodeProviderAmount(100, "IDR", { IDR: { wireExponent: 0 } })).toBe(10_000);
    expect(decodeProviderAmount(-1, "BDT")).toBeNull();
    expect(decodeProviderAmount(1.5, "BDT")).toBeNull();
  });
});

describe("provider declarations", () => {
  it("parses providers grouped by port into one flat list", () => {
    const parsed = parsePluginManifest({
      ...manifest,
      providers: {
        payment: [{ id: "wallet", name: "Wallet", chargeCurrencies: ["BDT"], operations: HOSTED_REFUNDS }],
        courier: [{ id: "parcel", name: "Parcel", trackingUrl: "https://parcel.test/t/{trackingId}" }],
      },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.manifest.providers).toEqual([
      { kind: "payment", id: "wallet", name: "Wallet", flow: "hosted", chargeCurrencies: ["BDT"], countries: "any", operations: HOSTED_REFUNDS },
      { kind: "courier", id: "parcel", name: "Parcel", operations: [], trackingUrl: "https://parcel.test/t/{trackingId}", countries: "any" },
    ]);
    expect(pluginGrantRequest(parsed.manifest).providers).toEqual(["courier", "payment"]);
  });

  it("lets a courier declare its own place ids and every provider its own mark", () => {
    const parsed = parsePluginManifest({
      ...manifest,
      providers: { courier: [{ id: "pathao", name: "Pathao", icon: "assets/pathao.svg", locations: { key: "pathao", required: ["city", "zone"], numeric: true } }] },
    });
    expect(parsed.ok && parsed.manifest.providers[0]).toMatchObject({ icon: "assets/pathao.svg", locations: { key: "pathao", required: ["city", "zone"], numeric: true } });
    for (const courier of [
      { id: "pathao", name: "Pathao", icon: "../pathao.svg" },
      { id: "pathao", name: "Pathao", icon: "assets/pathao.gif" },
      { id: "pathao", name: "Pathao", locations: { key: "pathao", required: ["city", "city"] } },
      { id: "pathao", name: "Pathao", locations: { key: "Pathao!", required: [] } },
    ]) {
      expect(parsePluginManifest({ ...manifest, providers: { courier: [courier] } }).ok, JSON.stringify(courier)).toBe(false);
    }
  });

  it("lets a payment provider declare the shipping countries it serves (MARKETS-DESIGN step 3b)", () => {
    const parsed = parsePluginManifest({
      ...manifest,
      providers: { payment: [{ id: "wallet", name: "Wallet", chargeCurrencies: ["BDT"], countries: ["BD"], operations: HOSTED_REFUNDS }] },
    });
    expect(parsed.ok && parsed.manifest.providers[0]).toMatchObject({ kind: "payment", countries: ["BD"] });
    expect(parsePluginManifest({
      ...manifest,
      providers: { payment: [{ id: "wallet", name: "Wallet", chargeCurrencies: ["BDT"], countries: ["bd"], operations: HOSTED_REFUNDS }] },
    }).ok).toBe(false);
  });

  it("lets a hosted provider name its unsigned return reference and its own environment setting (SSLCommerz)", () => {
    const environment = { key: "pay_environment", label: "Environment", type: "select", options: [{ value: "sandbox", label: "Sandbox" }, { value: "live", label: "Live" }] };
    const wallet = { id: "wallet", name: "Wallet", chargeCurrencies: ["BDT"], operations: HOSTED_REFUNDS, returnCorrelationField: "tran_id", environmentSetting: "pay_environment" };
    const parsed = parsePluginManifest({ ...manifest, settings: [environment], providers: { payment: [wallet] } });
    expect(parsed.ok && parsed.manifest.providers[0]).toMatchObject({ returnCorrelationField: "tran_id", environmentSetting: "pay_environment" });
    // The environment setting must exist and be a select of sandbox and live; the field name a plain form key.
    expect(parsePluginManifest({ ...manifest, providers: { payment: [wallet] } }).ok).toBe(false);
    expect(parsePluginManifest({ ...manifest, settings: [{ ...environment, options: [{ value: "test", label: "Test" }] }], providers: { payment: [wallet] } }).ok).toBe(false);
    expect(parsePluginManifest({ ...manifest, settings: [environment], providers: { payment: [{ ...wallet, returnCorrelationField: "tran id" }] } }).ok).toBe(false);
  });

  it("lets a courier declare its own booking options and passes only declared, valid choices", () => {
    const bookingOptions = [
      { key: "deliveryType", label: "Delivery type", type: "select", choices: [{ value: 48, label: "Regular" }, { value: 12, label: "Express" }] },
      { key: "insured", label: "Insured", type: "boolean" },
      { key: "declaredValue", label: "Declared value", type: "number", min: 0, max: 100_000 },
    ];
    const parsed = parsePluginManifest({ ...manifest, providers: { courier: [{ id: "redx", name: "RedX", bookingOptions }] } });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.manifest.providers[0]!.kind !== "courier") return;
    const declared = parsed.manifest.providers[0]!.bookingOptions;
    expect(declaredCourierBookingOptions(declared, { deliveryType: 12, insured: true, declaredValue: 500, itemType: 2 }))
      .toEqual({ deliveryType: 12, insured: true, declaredValue: 500 });
    expect(declaredCourierBookingOptions(declared, { deliveryType: 13, insured: "yes", declaredValue: -1 })).toEqual({});
    expect(declaredCourierBookingOptions(undefined, { deliveryType: 12 })).toEqual({});
    const refuses = (options: unknown[]) => parsePluginManifest({ ...manifest, providers: { courier: [{ id: "redx", name: "RedX", bookingOptions: options }] } }).ok;
    expect(refuses([bookingOptions[0], bookingOptions[0]])).toBe(false);
    expect(refuses([{ ...bookingOptions[0], key: "delivery_type" }])).toBe(false);
    expect(refuses([{ ...bookingOptions[0], choices: [] }])).toBe(false);
  });

  it("lets couriers and courier-history checkers declare the countries they serve (MARKETS-DESIGN step 3a)", () => {
    const parsed = parsePluginManifest({
      ...manifest,
      providers: {
        courier: [{ id: "redx", name: "RedX", countries: ["BD"] }],
        courier_history: [{ id: "radar", name: "Radar", countries: ["BD", "IN"] }],
      },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.manifest.providers).toEqual([
      { kind: "courier", id: "redx", name: "RedX", operations: [], countries: ["BD"] },
      { kind: "courier_history", id: "radar", name: "Radar", operations: [], countries: ["BD", "IN"] },
    ]);
    // A stored flat manifest written before the rename still reads.
    const stored = parsePluginManifest({ ...manifest, providers: [{ kind: "fraud", id: "radar", name: "Radar", operations: [], countries: ["BD"] }] });
    expect(stored.ok && stored.manifest.providers).toEqual([{ kind: "courier_history", id: "radar", name: "Radar", operations: [], countries: ["BD"] }]);
    expect(parsePluginManifest({ ...manifest, providers: { courier: [{ id: "redx", name: "RedX", countries: ["bd"] }] } }).ok).toBe(false);
    expect(providerServesCountry(["BD"], "BD")).toBe(true);
    expect(providerServesCountry(["BD"], "IN")).toBe(false);
    expect(providerServesCountry(["BD"], null)).toBe(false);
    expect(providerServesCountry("any", null)).toBe(true);
  });

  it("re-parses a stored (parsed) manifest to the same providers", () => {
    const first = parsePluginManifest({
      ...manifest,
      providers: { payment: [{ id: "wallet", name: "Wallet", chargeCurrencies: ["BDT"], operations: HOSTED_REFUNDS, amountCodecs: { BDT: { minorIncrement: 100 } } }] },
    });
    if (!first.ok) throw new Error("fixture");
    const again = parsePluginManifest(JSON.parse(JSON.stringify(first.manifest)));
    expect(again.ok && again.manifest.providers).toEqual(first.manifest.providers);
  });

  it("still parses the first flat shape and maps its old kind names", () => {
    const parsed = parsePluginManifest({ ...manifest, providers: [{ kind: "messaging", id: "sms", name: "SMS" }, { kind: "shipping", id: "parcel", name: "Parcel" }] });
    expect(parsed.ok && parsed.manifest.providers.map((provider) => provider.kind)).toEqual(["sms", "courier"]);
  });

  it("declares the service ports: chat channels, address countries, and a stored chat provider re-parses as chat", () => {
    const first = parsePluginManifest({
      ...manifest,
      providers: {
        messaging: [{ id: "wa", name: "WhatsApp", channels: ["whatsapp", "messenger"], operations: ["deliveryStatus"] }],
        push: [{ id: "push", name: "Push" }],
        search: [{ id: "search", name: "Search" }],
        address: [{ id: "places", name: "Places", countries: ["BD"] }],
        fx: [{ id: "rates", name: "Rates", operations: ["testConnection"] }],
        identity: [{ id: "google", name: "Google" }],
      },
    });
    if (!first.ok) throw new Error(first.issues.map((issue) => issue.message).join("; "));
    expect(first.manifest.providers.map((provider) => provider.kind)).toEqual(["messaging", "push", "search", "address", "fx", "identity"]);
    const again = parsePluginManifest(JSON.parse(JSON.stringify(first.manifest)));
    expect(again.ok && again.manifest.providers).toEqual(first.manifest.providers);
    expect(parsePluginManifest({ ...manifest, providers: { messaging: [{ id: "wa", name: "WhatsApp" }] } }).ok).toBe(false);
    expect(parsePluginManifest({ ...manifest, providers: { messaging: [{ id: "wa", name: "WhatsApp", channels: ["fax"] }] } }).ok).toBe(false);
  });

  it("takes a chat message as text or a template, never both, and FX rates as exact decimals", () => {
    const send = PROVIDER_PORTS.messaging.send.input;
    expect(send.safeParse({ channel: "whatsapp", to: "+8801711111111", text: "Hi" }).success).toBe(true);
    expect(send.safeParse({ channel: "whatsapp", to: "+8801711111111", template: { name: "order_update", language: "en_US", parameters: ["A"] } }).success).toBe(true);
    expect(send.safeParse({ channel: "whatsapp", to: "+8801711111111" }).success).toBe(false);
    expect(send.safeParse({ channel: "whatsapp", to: "+8801711111111", text: "Hi", template: { name: "x", language: "en" } }).success).toBe(false);
    const rates = PROVIDER_PORTS.fx.rates.output;
    expect(rates.safeParse({ rates: [{ currency: "USD", rate: "0.0084" }] }).success).toBe(true);
    for (const rate of ["0", "-1", "1e3", "0.000", "1.2.3", 1.2]) {
      expect(rates.safeParse({ rates: [{ currency: "USD", rate }] }).success).toBe(false);
    }
    expect(PROVIDER_PORTS.push.send.input.safeParse({ audience: "customer", recipients: ["cus_1"], notification: { title: "Shipped", url: "//evil.example" } }).success).toBe(false);
  });

  it("requires what checkout and reconciliation rely on", () => {
    const wallet = { id: "wallet", name: "Wallet", chargeCurrencies: ["BDT"] };
    const parses = (payment: unknown) => parsePluginManifest({ ...manifest, providers: { payment: [payment] } }).ok;
    expect(parses({ ...wallet, operations: HOSTED_REFUNDS })).toBe(true);
    expect(parses({ id: "wallet", name: "Wallet", operations: HOSTED_REFUNDS })).toBe(false);
    expect(parses({ ...wallet, flow: "card", operations: HOSTED_REFUNDS })).toBe(false);
    expect(parses({ ...wallet, operations: ["queryPayment"] })).toBe(false);
    expect(parses({ ...wallet, operations: ["verifyReturn", "queryPayment", "refund"] })).toBe(false);
    expect(parses({ ...wallet, flow: "hosted", operations: HOSTED_REFUNDS })).toBe(true);
    expect(parses({ ...wallet, flow: "instructions" })).toBe(false);
    expect(parses({ ...wallet, operations: ["capture"] })).toBe(false);
    // A capability and its operations come together, both ways.
    const vaulting = [...HOSTED_REFUNDS, "chargeSavedMethod", "deleteSavedMethod"];
    expect(parses({ ...wallet, operations: vaulting, capabilities: ["vault"] })).toBe(true);
    expect(parses({ ...wallet, operations: vaulting })).toBe(false);
    expect(parses({ ...wallet, operations: [...HOSTED_REFUNDS, "chargeSavedMethod"], capabilities: ["vault"] })).toBe(false);
    expect(parses({ ...wallet, operations: [...vaulting, "capture", "void"], capabilities: ["vault", "manualCapture"] })).toBe(true);
    expect(parses({ ...wallet, operations: [...HOSTED_REFUNDS, "capture"], capabilities: ["manualCapture"] })).toBe(false);
    expect(parses({ ...wallet, operations: vaulting, capabilities: ["vault", "vault"] })).toBe(false);
    expect(parsePluginManifest({ ...manifest, providers: { sms: [{ id: "a", name: "A" }], email: [{ id: "a", name: "B" }] } }).ok).toBe(false);
  });

  it("fits a regional pack: up to PLUGIN_PROVIDERS_MAX providers, readiness per provider's own settings", () => {
    const sms = Array.from({ length: 12 }, (_, index) => ({ id: `gateway-${index}`, name: `Gateway ${index}` }));
    const courier_history = Array.from({ length: 12 }, (_, index) => ({ id: `checker-${index}`, name: `Checker ${index}`, countries: ["BD"] }));
    expect(PLUGIN_PROVIDERS_MAX).toBe(24);
    expect(parsePluginManifest({ ...manifest, providers: { sms, courier_history } }).ok).toBe(true);
    expect(parsePluginManifest({ ...manifest, providers: { sms: [...sms, { id: "one-more", name: "One more" }], courier_history } }).ok).toBe(false);

    const settings = [{ key: "gateway_token", label: "Token", type: "secret" }];
    const declared = parsePluginManifest({ ...manifest, settings, providers: { sms: [{ id: "gateway", name: "Gateway", settings: ["gateway_token"] }] } });
    expect(declared.ok && declared.manifest.providers[0]).toMatchObject({ kind: "sms", settings: ["gateway_token"] });
    // A provider names only declared settings, each once.
    expect(parsePluginManifest({ ...manifest, settings, providers: { sms: [{ id: "gateway", name: "Gateway", settings: ["other_token"] }] } }).ok).toBe(false);
    expect(parsePluginManifest({ ...manifest, settings, providers: { sms: [{ id: "gateway", name: "Gateway", settings: ["gateway_token", "gateway_token"] }] } }).ok).toBe(false);
  });

  it("checks an implementation against its port when the plugin loads", () => {
    const parsed = parsePluginManifest({ ...manifest, providers: { payment: [{ id: "wallet", name: "Wallet", chargeCurrencies: ["BDT"], operations: HOSTED_REFUNDS }] } });
    if (!parsed.ok) throw new Error("fixture");
    const inventory = pluginHandlerInventory(parsed.manifest);
    const complete = {
      kind: "payment", createSession() {}, verifyWebhook() {}, verifyReturn() {}, queryPayment() {}, refund() {}, refundStatus() {},
    };
    expect(checkPluginHandlers(inventory, { manifest, providers: { wallet: complete } })).toEqual([]);
    expect(checkPluginHandlers(inventory, { manifest, providers: { wallet: { ...complete, refund: undefined } } }))
      .toContain('Provider "wallet" must implement refund.');
    expect(checkPluginHandlers(inventory, { manifest, providers: { wallet: { ...complete, listRefunds() {} } } }))
      .toContain('Provider "wallet" implements listRefunds; declare it in the provider\'s operations.');
    expect(checkPluginHandlers(inventory, { manifest, providers: { wallet: { ...complete, kind: "courier" } } }))
      .toContain('Provider "wallet" is declared as a payment provider but defined for another port.');
    expect(checkPluginHandlers(inventory, { manifest, providers: { wallet: { ...complete, capture() {} } } }))
      .toContain('Provider "wallet" implements capture; declare it in the provider\'s operations.');
    expect(checkPluginHandlers(inventory, { manifest, providers: { wallet: { ...complete, settle() {} } } }))
      .toContain('Provider "wallet" has "settle", which the payment port does not define.');
    expect(checkPluginHandlers(inventory, { manifest, providers: {} }))
      .toContain('Provider "wallet" is declared in the manifest but has no handler.');
  });
});
