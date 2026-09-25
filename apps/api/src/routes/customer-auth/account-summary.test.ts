// GET /customer-auth/account-summary: the counts behind the account tabs.
// Real route on the migrated SQLite schema (the conversation harness).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getOrCreateOrderThread, postConversationMessage } from "@scalius/core/modules/conversations";
import { getDb } from "@scalius/database/client";
import { createConversationHarness, OWNER_SESSION, type Harness } from "../__tests__/conversation-harness";

let harness: Harness;

beforeEach(async () => {
  harness = await createConversationHarness();
});
afterEach(() => harness.sqlite.close());

describe("customer account summary", () => {
  it("counts the unread inbox and keeps the Wave B tabs at zero while their domains are empty", async () => {
    const db = getDb(harness.env);
    const thread = await getOrCreateOrderThread(db, "ORDEROWNED000001");
    await postConversationMessage(db, thread, { actor: { kind: "staff", userId: "staff_1" }, body: "Your order ships tomorrow." });

    const response = await harness.request("/customer-auth/account-summary", { session: OWNER_SESSION });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    const body = await response.json() as { data: Record<string, number> };
    expect(body.data).toEqual({
      unreadInbox: 1,
      reviewsToWrite: 0,
      reviewsWritten: 0,
      downloads: 0,
      giftCards: 0,
      activeWarranties: 0,
    });
  });

  it("requires a customer session", async () => {
    const response = await harness.request("/customer-auth/account-summary");
    expect(response.status).toBe(401);
  });
});
