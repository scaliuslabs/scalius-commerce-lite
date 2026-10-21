// The lost-response rule (`retryAfterLostResponse`) covers every stable write:
// a create that would make a second resource never runs twice, and a new
// stable write is classified on purpose, not by default.
import { describe, expect, it } from "vitest";
import { AGENT_OPERATION_POLICIES } from "../../generated/agent-operation-policies.gen";
import { retryAfterLostResponse } from "./idempotency";

const stableWrites = AGENT_OPERATION_POLICIES.filter((operation) =>
  operation.stability === "stable" && operation.method !== "GET" && operation.method !== "HEAD");

describe("retryAfterLostResponse", () => {
  it("answers outcome unknown exactly for the stable creates with no durable key of their own", () => {
    const unknown = stableWrites.filter((operation) => retryAfterLostResponse(operation) === "outcome_unknown")
      .map((operation) => operation.operationId)
      .sort();
    expect(unknown).toEqual([
      "dashboard.brands.create",
      "dashboard.categories.create",
      "dashboard.collections.create",
      "dashboard.content.create",
      "dashboard.customers.create",
      "dashboard.discounts.create",
      "dashboard.media.import_url",
      "dashboard.resources.menus.create",
      "dashboard.resources.price_lists.create",
      "dashboard.resources.products.create",
      "dashboard.resources.shipments.create",
      "dashboard.resources.webhook_subscriptions.create",
    ]);
  });

  it("reruns every write whose effect is keyed by the request or sets a target state", () => {
    const byId = new Map(stableWrites.map((operation) => [operation.operationId, operation]));
    for (const id of [
      "dashboard.resources.orders.create",
      "dashboard.resources.payments.charge",
      "dashboard.resources.refunds.create",
      "dashboard.inventory.adjust",
      "dashboard.resources.products.batch_create",
      "dashboard.resources.products.update",
      "dashboard.customers.update",
    ]) {
      const operation = byId.get(id);
      expect(operation, id).toBeDefined();
      expect(retryAfterLostResponse(operation!), id).toBe("rerun");
    }
  });
});
