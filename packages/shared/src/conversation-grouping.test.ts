import { expect, it } from "vitest";
import { groupConversationMessages } from "./conversation-grouping";
const row = (seq: number, patch: Record<string, unknown> = {}) => ({ seq, kind: "message", visibility: "public", authorType: "staff", authorUserId: "a", createdAt: 1000 + seq, ...patch });
const dayKey = (seconds: number) => String(Math.floor(seconds / 86_400));
it("groups consecutive author/visibility messages within five minutes, never across gaps, events, people or store days", () => {
  const messages = [row(1), row(2), row(3, { visibility: "internal" }), row(4, { authorUserId: "b" }), row(5, { kind: "event" }), row(6), row(8), row(9, { createdAt: 86_400 }), row(10, { createdAt: 86_701 })];
  expect(groupConversationMessages(messages, { dayKey }).map((item) => item.showAuthor)).toEqual([true, false, true, true, false, true, true, true, true]);
});
it("keeps an appended message in its previous rendered group without guessing the caller's timezone", () => {
  const previous = row(1, { createdAt: 86_399 });
  const next = row(2, { createdAt: 86_401 });
  expect(groupConversationMessages([next], { previous, dayKey: () => "same-store-day" })[0]).toMatchObject({ groupStart: false, showAuthor: false, startsDay: false });
  expect(groupConversationMessages([next], { previous, dayKey })[0]).toMatchObject({ groupStart: true, startsDay: true });
});
