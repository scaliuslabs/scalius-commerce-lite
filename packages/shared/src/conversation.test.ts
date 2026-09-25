import { describe, expect, it } from "vitest";

import {
  conversationAttachmentR2Key,
  conversationUnreadCount,
  isBuyerVisibleMessage,
  isConversationId,
  nextConversationStatus,
  normalizeConversationBody,
  normalizeConversationSubject,
} from "./conversation";

describe("conversation status rule (§4.1)", () => {
  it("opens on a buyer message, even from closed", () => {
    expect(nextConversationStatus("pending", { type: "buyer_message" })).toBe("open");
    expect(nextConversationStatus("closed", { type: "buyer_message" })).toBe("open");
  });

  it("waits on the buyer after a public staff reply; internal notes and events change nothing", () => {
    expect(nextConversationStatus("open", { type: "staff_message", visibility: "public" })).toBe("pending");
    expect(nextConversationStatus("open", { type: "staff_message", visibility: "internal" })).toBe("open");
    expect(nextConversationStatus("closed", { type: "staff_message", visibility: "internal" })).toBe("closed");
    expect(nextConversationStatus("pending", { type: "system_event" })).toBe("pending");
  });

  it("closes and reopens only through staff actions", () => {
    expect(nextConversationStatus("open", { type: "close" })).toBe("closed");
    expect(nextConversationStatus("closed", { type: "reopen" })).toBe("open");
    expect(nextConversationStatus("pending", { type: "reopen" })).toBe("pending");
  });
});

describe("conversation text", () => {
  it("normalizes a body and bounds it to 1–5,000 characters", () => {
    expect(normalizeConversationBody("  hi\r\nthere  ")).toEqual({ ok: true, value: "hi\nthere" });
    expect(normalizeConversationBody("   ")).toEqual({ ok: false, reason: "empty" });
    expect(normalizeConversationBody(42)).toEqual({ ok: false, reason: "empty" });
    expect(normalizeConversationBody("x".repeat(5_000))).toMatchObject({ ok: true });
    expect(normalizeConversationBody("x".repeat(5_001))).toEqual({ ok: false, reason: "too_long" });
    expect(normalizeConversationBody("bell\u0007")).toEqual({ ok: false, reason: "invalid_characters" });
  });

  it("keeps subjects to one line of at most 120 characters", () => {
    expect(normalizeConversationSubject("Wholesale question")).toEqual({ ok: true, value: "Wholesale question" });
    expect(normalizeConversationSubject("two\nlines")).toEqual({ ok: false, reason: "invalid_characters" });
    expect(normalizeConversationSubject("s".repeat(121))).toEqual({ ok: false, reason: "too_long" });
  });
});

describe("conversation ids, keys and projections", () => {
  it("accepts only opaque prefixed ids and builds private attachment keys", () => {
    expect(isConversationId("cnv_AbC123xyz_")).toBe(true);
    expect(isConversationId("cnv_short")).toBe(false);
    expect(isConversationId("ord_AbC123xyz")).toBe(false);
    expect(isConversationId("cnv_../../etc/passwd")).toBe(false);
    expect(conversationAttachmentR2Key("cnv_AbC123xyz", "att_Def456uvw"))
      .toBe("private/conversations/cnv_AbC123xyz/att_Def456uvw");
    expect(() => conversationAttachmentR2Key("cnv_AbC123xyz", "../x")).toThrow();
  });

  it("counts unread messages from sequence markers and hides internal notes from buyers", () => {
    expect(conversationUnreadCount(7, 4)).toBe(3);
    expect(conversationUnreadCount(4, 7)).toBe(0);
    expect(isBuyerVisibleMessage({ visibility: "public" })).toBe(true);
    expect(isBuyerVisibleMessage({ visibility: "internal" })).toBe(false);
  });
});
