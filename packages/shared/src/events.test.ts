import { describe, expect, it } from "vitest";
import {
  EVENT_FACT_SCHEMAS,
  EVENT_TOPICS,
  EVENT_TOPIC_FILTERS,
  EVENT_TOPIC_RESOURCE,
  isEventTopicFilter,
  normalizeEventTopicFilters,
  parseEventFacts,
  signWebhookPayload,
  topicMatchesAnyFilter,
  topicMatchesFilter,
  verifyWebhookSignature,
} from "./events";


/** An independent HMAC-SHA256 (hex) from the platform's Web Crypto, as a receiver would compute it. */
async function referenceHmacHex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
  return [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("event catalog", () => {
  it("gives every topic a resource and a fact schema", () => {
    for (const topic of EVENT_TOPICS) {
      expect(EVENT_TOPIC_RESOURCE[topic], topic).toBeTruthy();
      expect(EVENT_FACT_SCHEMAS[topic], topic).toBeTruthy();
    }
    expect(Object.keys(EVENT_FACT_SCHEMAS).sort()).toEqual([...EVENT_TOPICS].sort());
  });

  it("parses stored facts strictly by type and tolerates additive keys", () => {
    expect(parseEventFacts("inventory.level_changed", JSON.stringify({
      variantId: "var_1",
      productId: "prod_1",
      locationId: null,
      quantityDelta: -2,
      movementId: "mov_1",
      movementType: "deducted",
      future: "ignored by older readers",
    }))).toMatchObject({ variantId: "var_1", quantityDelta: -2, locationId: null });
    expect(parseEventFacts("inventory.level_changed", { variantId: "var_1", quantityDelta: "-2" })).toBeNull();
    expect(parseEventFacts("order.created", "{not json")).toBeNull();
    expect(parseEventFacts("product.deleted", { productId: "p", deletion: "gone" })).toBeNull();
  });
});

describe("topic filters", () => {
  it("matches exact topics, resource prefixes and everything", () => {
    expect(topicMatchesFilter("order.paid", "order.paid")).toBe(true);
    expect(topicMatchesFilter("order.paid", "order.*")).toBe(true);
    expect(topicMatchesFilter("order.paid", "*")).toBe(true);
    expect(topicMatchesFilter("order.paid", "product.*")).toBe(false);
    expect(topicMatchesFilter("inventory.level_changed", "inventory.*")).toBe(true);
    expect(topicMatchesAnyFilter("customer.updated", ["order.*", "customer.updated"])).toBe(true);
    expect(topicMatchesAnyFilter("customer.created", ["order.*", "customer.updated"])).toBe(false);
  });

  it("normalizes: dedupes, folds exact topics into their prefix, collapses to `*`, and rejects unknown entries", () => {
    expect(normalizeEventTopicFilters(["order.paid", "order.*", "order.paid", "product.created"]))
      .toEqual(["order.*", "product.created"]);
    expect(normalizeEventTopicFilters(["customer.updated", "*", "order.paid"])).toEqual(["*"]);
    expect(normalizeEventTopicFilters(["order.shipped"])).toBeNull();
    expect(normalizeEventTopicFilters(["orders.*"])).toBeNull();
    expect(normalizeEventTopicFilters([])).toEqual([]);
    expect(EVENT_TOPIC_FILTERS.every(isEventTopicFilter)).toBe(true);
  });
});

describe("webhook signature", () => {
  const secret = "whsec_test_0123456789abcdefghijklmnopqrstuvwx";
  const body = '{"id":"evt_1790000000000a1b2c3d4e5f6","topic":"order.paid"}';
  const timestamp = 1_790_000_000;

  it("matches the documented test vector: HMAC-SHA256(secret, `${t}.${body}`) as hex", async () => {
    const expected = await referenceHmacHex(secret, `${timestamp}.${body}`);
    const header = await signWebhookPayload(secret, timestamp, body);
    expect(header).toBe(`t=${timestamp},v1=${expected}`);
    // Pinned value so a change of algorithm or encoding is a visible contract break.
    expect(header).toBe("t=1790000000,v1=c7480c18a9d525a6081a38d1eff18c8b4e5ab9d6ce0256164c6f724b8499e1da");
  });

  it("verifies within the tolerance and rejects tampering, stale timestamps and other secrets", async () => {
    const header = await signWebhookPayload(secret, timestamp, body);
    await expect(verifyWebhookSignature({ secret, header, body, nowSeconds: timestamp + 60 })).resolves.toBe(true);
    await expect(verifyWebhookSignature({ secret, header, body: `${body} `, nowSeconds: timestamp })).resolves.toBe(false);
    await expect(verifyWebhookSignature({ secret, header, body, nowSeconds: timestamp + 301 })).resolves.toBe(false);
    await expect(verifyWebhookSignature({ secret: `${secret}x`, header, body, nowSeconds: timestamp })).resolves.toBe(false);
    await expect(verifyWebhookSignature({ secret, header: "garbage", body, nowSeconds: timestamp })).resolves.toBe(false);
    await expect(verifyWebhookSignature({ secret, header: null, body })).resolves.toBe(false);
  });

  it("accepts any matching v1 entry (signing with two secrets during a rotation)", async () => {
    const own = (await signWebhookPayload(secret, timestamp, body)).split(",v1=")[1];
    const other = await referenceHmacHex("whsec_other", `${timestamp}.${body}`);
    await expect(verifyWebhookSignature({
      secret,
      header: `t=${timestamp},v1=${other},v1=${own}`,
      body,
      nowSeconds: timestamp,
    })).resolves.toBe(true);
  });
});
