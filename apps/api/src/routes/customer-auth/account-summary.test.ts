// GET /customer-auth/account-summary: the counts behind the account tabs.
// Real route on the migrated SQLite schema (the conversation harness).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getOrCreateOrderThread, postConversationMessage } from "@scalius/core/modules/conversations";
import { getDb } from "@scalius/database/client";
import { createConversationHarness, OWNER_SESSION, type Harness } from "../__tests__/conversation-harness";
const buyerUi = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
vi.mock("../../plugins/checkout-functions", () => ({
  createCheckoutAppFunctions: () => ({ points: new Set(["buyer.ui"]), buyerUi }),
}));

let harness: Harness;

beforeEach(async () => {
  buyerUi.mockClear();
  harness = await createConversationHarness();
});
afterEach(() => harness.sqlite.close());

describe("customer account summary", () => {
  it("counts the unread inbox and keeps the Wave B tabs at zero while their domains are empty", async () => {
    const db = getDb(harness.env);
    const thread = await getOrCreateOrderThread(db, "ORDEROWNED000001");
    await postConversationMessage(db, thread, { actor: { kind: "staff", userId: "staff_1" }, body: "Your order ships tomorrow." });

    const response = await harness.request("/customer-auth/account-summary", {
      session: OWNER_SESSION,
      headers: { "x-storefront-language": "bn", "x-storefront-locale": "bn-BD" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    const body = await response.json() as { data: Record<string, unknown> };
    expect(body.data).toEqual({
      unreadInbox: 1,
      reviewsToWrite: 0,
      reviewsWritten: 0,
      downloads: 0,
      giftCards: 0,
      activeWarranties: 0,
      buyerUi: [],
    });
    expect(buyerUi).toHaveBeenCalledWith({
      targets: ["account.overview", "account.profile"],
      language: "bn",
      locale: "bn-BD",
      currency: expect.any(String),
      customer: { id: "cust_owner" },
    });
  });

  it("requires a customer session", async () => {
    const response = await harness.request("/customer-auth/account-summary");
    expect(response.status).toBe(401);
    expect(buyerUi).not.toHaveBeenCalled();
  });
});
