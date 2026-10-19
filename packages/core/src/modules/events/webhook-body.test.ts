// The webhook body (COMMERCE-HOOKS H5): the sealed representation as the
// endpoint's customer data lets it see it, and the documented truncation
// shape instead of a silent null when it is too large.
import { describe, expect, it } from "vitest";
import { buildEventRepresentation, eventDataTruncationSchema } from "@scalius/shared/events";
import { allProtectedData } from "@scalius/shared/plugins/protected-data";
import { WEBHOOK_MAX_BODY_BYTES, buildWebhookBody } from "./webhook-delivery";
import type { OutboxEvent } from "./event-outbox";

const event: OutboxEvent = {
  id: "evt_1", topic: "customer.updated", resourceType: "customer", resourceId: "cus_1", occurredAt: 1_792_000_000,
  facts: { customerId: "cus_1" },
};
const customer = (name: string) => buildEventRepresentation("customer", {
  id: "cus_1", name, email: "rahim@buyer.test", phone: "+8801711111111", hasAccount: true, totalOrders: 2, lastOrderAt: null,
  mergedIntoCustomerId: null, tags: [], consents: [{ channel: "sms", state: "subscribed", contact: "+8801711111111", updatedAt: "2026-10-19T00:00:00.000Z" }],
  createdAt: "2026-10-19T00:00:00.000Z", updatedAt: "2026-10-19T00:00:00.000Z", deletedAt: null,
}, allProtectedData());

describe("the webhook body", () => {
  it("carries only the customer data the endpoint opted in to, field by field", () => {
    const none = JSON.parse(buildWebhookBody(event, "2026-10", customer("Rahim")));
    expect(none.data).toMatchObject({ id: "cus_1", name: null, email: null, phone: null, totalOrders: 2, consents: [{ channel: "sms", contact: null }] });
    const phones = JSON.parse(buildWebhookBody(event, "2026-10", customer("Rahim"), new Set(["phone"])));
    expect(phones.data).toMatchObject({ name: null, email: null, phone: "+8801711111111", consents: [{ contact: null }] });
    const all = JSON.parse(buildWebhookBody(event, "2026-10", customer("Rahim"), allProtectedData()));
    expect(all.data).toMatchObject({ name: "Rahim", email: "rahim@buyer.test", consents: [{ contact: "+8801711111111" }] });
  });

  it("never sends a field the sealed representation does not declare", () => {
    const sealed = buildEventRepresentation("customer", { ...customer("Rahim"), passwordHash: "secret" } as never, allProtectedData());
    expect(JSON.stringify(sealed)).not.toContain("passwordHash");
  });

  it("replaces an oversized representation with its id and where to read it, and keeps null for a deleted resource", () => {
    const large = customer("x".repeat(3000));
    large.consents = Array.from({ length: 200 }, () => ({ channel: "email", state: "subscribed", contact: "y".repeat(3000), updatedAt: "2026-10-19T00:00:00.000Z" }));
    const body = buildWebhookBody(event, "2026-10", large, allProtectedData());
    expect(new TextEncoder().encode(body).byteLength).toBeLessThan(WEBHOOK_MAX_BODY_BYTES);
    const envelope = JSON.parse(body);
    expect(eventDataTruncationSchema.parse(envelope.data)).toEqual({
      truncated: true, id: "cus_1", fetch: { operationId: "dashboard.resources.customers.get", method: "GET", path: "/api/v1/admin/resources/customers/cus_1" },
    });
    expect(JSON.parse(buildWebhookBody({ ...event, topic: "customer.updated" }, "2026-10", null)).data).toBeNull();
  });
});
