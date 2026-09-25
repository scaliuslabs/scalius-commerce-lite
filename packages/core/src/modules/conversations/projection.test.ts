import { describe, expect, it } from "vitest";
import { projectMessageForBuyer, projectMessagesForBuyer } from "./projection";
import type { ConversationMessageRecord } from "./types";

function line(overrides: Partial<ConversationMessageRecord>): ConversationMessageRecord {
  return {
    id: "msg_aaaaaaaaaaaa",
    seq: 1,
    kind: "message",
    visibility: "public",
    authorType: "staff",
    authorUserId: "staff_1",
    authorName: "Nadia",
    body: "Hello",
    eventKind: null,
    eventData: null,
    createdAt: 1_780_000_000,
    attachments: [],
    ...overrides,
  };
}

describe("buyer projection (C4)", () => {
  it("never passes an internal note, whoever wrote it", () => {
    expect(projectMessageForBuyer(line({ visibility: "internal" }))).toBeNull();
    expect(projectMessageForBuyer(line({ visibility: "internal", authorType: "system", kind: "event", eventKind: "x" }))).toBeNull();
    const projected = projectMessagesForBuyer([
      line({ seq: 1, body: "Public reply" }),
      line({ seq: 2, visibility: "internal", body: "Buyer seems angry, refund quietly" }),
      line({ seq: 3, authorType: "guest_receipt", authorUserId: null, body: "Thanks" }),
    ]);
    expect(projected.map((message) => message.seq)).toEqual([1, 3]);
    expect(JSON.stringify(projected)).not.toContain("refund quietly");
  });

  it("collapses staff identity to the store and keeps only buyer-safe event facts", () => {
    const projected = projectMessageForBuyer(line({
      kind: "event",
      authorType: "system",
      body: null,
      eventKind: "support_request_status",
      eventData: { requestId: "osr_1", type: "return", fromStatus: "submitted", toStatus: "approved", actorId: "staff_1", note: "internal" },
    }));
    expect(projected).toMatchObject({ from: "system", eventData: { requestId: "osr_1", type: "return", fromStatus: "submitted", toStatus: "approved" } });
    expect(projected?.eventData).not.toHaveProperty("note");
    expect(projected?.eventData).not.toHaveProperty("actorId");
    const reply = projectMessageForBuyer(line({}));
    expect(reply).toMatchObject({ from: "store" });
    expect(reply).not.toHaveProperty("authorName");
    expect(reply).not.toHaveProperty("authorUserId");
  });
});
