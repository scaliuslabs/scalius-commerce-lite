import { describe, expect, it } from "vitest";
import { inboxMessages, type InboxMessageKey } from "~/i18n/inbox";
import { acceptImages, authorName, eventText, initials, threadPreview, threadTitle } from "./conversation-format";

const t = (key: InboxMessageKey, vars?: Record<string, string | number>) =>
  inboxMessages.en[key].replace(/\{(\w+)\}/g, (_, name: string) => String(vars?.[name] ?? ""));
const labels = {
  request: (type: string) => ({ return: "Return requested", cancel_pre_shipment: "Cancellation requested" })[type] ?? "Request",
  status: (status: string) => ({ approved: "Accepted", rejected: "Rejected" })[status] ?? status,
};

describe("conversation presentation", () => {
  it("titles order threads by number and store threads by subject", () => {
    expect(threadTitle(t, { subjectType: "order", subject: null, orderNumber: "#1057" })).toBe("Order #1057");
    expect(threadTitle(t, { subjectType: "store", subject: "  Do you ship abroad?  ", orderNumber: null })).toBe("Do you ship abroad?");
    expect(threadTitle(t, { subjectType: "store", subject: null, orderNumber: null })).toBe("General question");
  });

  it("previews the last text, or who acted when the last line was an event", () => {
    expect(threadPreview(t, { preview: "Where is it?", lastAuthorType: "customer" })).toBe("Where is it?");
    expect(threadPreview(t, { preview: null, lastAuthorType: "staff" })).toBe("You replied");
    expect(threadPreview(t, { preview: null, lastAuthorType: "system" })).toBe("Update");
  });

  it("words case events with the order page's request and status names", () => {
    expect(eventText(t, { eventKind: "support_request_submitted", eventData: { type: "return" } }, labels)).toBe("Return requested submitted");
    expect(eventText(t, { eventKind: "support_request_status", eventData: { type: "cancel_pre_shipment", toStatus: "approved" } }, labels))
      .toBe("Cancellation requested: Accepted");
    expect(eventText(t, { eventKind: "something_new", eventData: null }, labels)).toBe("Update");
  });

  it("names the author: you, a colleague, or the customer", () => {
    const staff = { authorType: "staff", authorUserId: "u1", authorName: "Nadia" };
    expect(authorName(t, staff, "u1", "Rahim")).toBe("You");
    expect(authorName(t, staff, "u2", "Rahim")).toBe("Nadia");
    expect(authorName(t, { authorType: "guest_receipt", authorUserId: null, authorName: null }, "u1", null)).toBe("Customer");
    expect(authorName(t, { authorType: "customer", authorUserId: null, authorName: null }, null, "Rahim Uddin")).toBe("Rahim Uddin");
  });

  it("takes whole Bangla graphemes for initials", () => {
    expect(initials("Rahim Uddin")).toBe("RU");
    expect(initials("ক্ষমা রায়")).toBe("ক্ষরা");
  });

  it("accepts up to three JPEG, PNG or WebP images of 5 MB or less", () => {
    const file = (type: string, size = 10) => new File([new Uint8Array(size)], "a", { type });
    expect(acceptImages([file("image/jpeg"), file("image/png")], 0)).toEqual({ accepted: [expect.any(File), expect.any(File)], rejection: null });
    expect(acceptImages([file("image/gif")], 0).rejection).toBe("attachType");
    expect(acceptImages([file("image/jpeg", 5 * 1024 * 1024 + 1)], 0).rejection).toBe("attachTooBig");
    const many = acceptImages([file("image/jpeg"), file("image/jpeg")], 2);
    expect(many.accepted).toHaveLength(1);
    expect(many.rejection).toBe("attachTooMany");
  });
});
