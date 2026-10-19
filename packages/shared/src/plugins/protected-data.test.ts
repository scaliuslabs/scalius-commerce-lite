import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PLUGIN_FUNCTION_SCHEMAS } from "./functions";
import { PLUGIN_API_VERSION, parsePluginManifest } from "./manifest";
import {
  PROTECTED_CUSTOMER_DATA,
  PROTECTED_FIELD_KEYWORD,
  PROVIDER_PROTECTED_DATA,
  grantedProtectedData,
  projectProviderInput,
  protectedPathsOf,
  redactProtectedData,
} from "./protected-data";
import { PROVIDER_KINDS } from "./providers/kinds";

const schema = {
  type: "object",
  properties: {
    data: {
      type: "object",
      properties: {
        customerName: { type: "string", [PROTECTED_FIELD_KEYWORD]: "name" },
        city: { type: "string" },
        addresses: { type: "array", items: { $ref: "#/components/schemas/Address" } },
        consents: { type: "array", items: { type: "object", properties: { contact: { type: "string", [PROTECTED_FIELD_KEYWORD]: ["email", "phone"] } } } },
      },
    },
  },
};
const components: Record<string, unknown> = {
  Address: {
    type: "object",
    properties: { line1: { type: "string", [PROTECTED_FIELD_KEYWORD]: "address" }, phone: { type: "string", [PROTECTED_FIELD_KEYWORD]: "phone" }, locality: { type: "string" } },
  },
};
const resolve = (ref: string) => components[ref.replace("#/components/schemas/", "")];

describe("protected customer data", () => {
  it("finds every marked field through refs, arrays and multi-category markers", () => {
    expect(protectedPathsOf(schema, resolve)).toEqual([
      { path: ["data", "customerName"], categories: ["name"] },
      { path: ["data", "addresses", "*", "line1"], categories: ["address"] },
      { path: ["data", "addresses", "*", "phone"], categories: ["phone"] },
      { path: ["data", "consents", "*", "contact"], categories: ["email", "phone"] },
    ]);
  });

  it("nulls what the grant does not reveal and nothing else", () => {
    const paths = protectedPathsOf(schema, resolve);
    const body = () => ({
      data: {
        customerName: "Rahim", city: "Dhaka",
        addresses: [{ line1: "House 1", phone: "+8801711111111", locality: "Gulshan" }],
        consents: [{ contact: "rahim@buyer.test" }],
      },
    });
    expect(redactProtectedData(body(), paths, new Set())).toEqual({
      data: { customerName: null, city: "Dhaka", addresses: [{ line1: null, phone: null, locality: "Gulshan" }], consents: [{ contact: null }] },
    });
    expect(redactProtectedData(body(), paths, new Set(["name", "phone"]))).toEqual({
      data: { customerName: "Rahim", city: "Dhaka", addresses: [{ line1: null, phone: "+8801711111111", locality: "Gulshan" }], consents: [{ contact: null }] },
    });
    expect(redactProtectedData(body(), paths, new Set(PROTECTED_CUSTOMER_DATA))).toEqual(body());
    // Absent fields stay absent; nothing is added.
    expect(redactProtectedData({ data: { city: "Dhaka" } }, paths, new Set())).toEqual({ data: { city: "Dhaka" } });
  });

  it("sends a payment app only the buyer fields its grant reveals", () => {
    const input = { orderId: "o1", buyer: { name: "Rahim", phone: "+8801711111111", email: "r@buyer.test", address: "House 1", city: "Dhaka" } };
    expect(projectProviderInput("payment", "createSession", input, grantedProtectedData(["read_customer_phones"])))
      .toEqual({ orderId: "o1", buyer: { phone: "+8801711111111", city: "Dhaka" } });
    expect(input.buyer.name).toBe("Rahim");
    expect(projectProviderInput("courier", "createShipment", input, new Set())).toBe(input);
  });

  it("makes a manifest ask for the buyer data its providers receive", () => {
    const base = { id: "acme.ship", name: "Ship", version: "1.0.0", apiVersion: PLUGIN_API_VERSION, description: "Ships.", author: { name: "Acme" } };
    const courier = { courier: [{ id: "parcel", name: "Parcel" }] };
    const refused = parsePluginManifest({ ...base, providers: courier });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.issues[0]!.message).toContain("read_customer_names, read_customer_phones, read_customer_addresses");
    expect(parsePluginManifest({ ...base, scopes: ["read_customer_names", "read_customer_phones", "read_customer_addresses"], providers: courier }).ok).toBe(true);
    // A feature asks for its own provider's data.
    expect(parsePluginManifest({
      ...base,
      providers: { sms: [{ id: "texts", name: "Texts" }] },
      features: [{ id: "texts", name: "Texts", description: "Send texts.", providers: ["texts"], scopes: ["read_customer_phones"] }],
    }).ok).toBe(true);
    // A payment app needs none: it receives only what it asks for.
    expect(parsePluginManifest({ ...base, providers: { payment: [{ id: "pay", name: "Pay", chargeCurrencies: ["BDT"], operations: ["verifyReturn", "queryPayment", "refund", "refundStatus"] }] } }).ok).toBe(true);
    expect(PROVIDER_KINDS.every((kind) => kind in PROVIDER_PROTECTED_DATA)).toBe(true);
  });

  it("keeps contact details out of every function input", () => {
    const marked = /phone|email|line1|street|recipient|customerName/i;
    for (const [point, schemas] of Object.entries(PLUGIN_FUNCTION_SCHEMAS)) {
      const json = JSON.stringify(z.toJSONSchema(schemas.input as z.ZodType, { io: "input" }));
      expect(marked.test(json), point).toBe(false);
    }
  });
});
