// The buyer projection (C4): the only way a stored line reaches a buyer.
// Internal notes never pass; staff identity collapses to "the store". Pure,
// so the storefront, the API and the tests share one rule.

import { isBuyerVisibleMessage } from "@scalius/shared/conversation";
import type { BuyerConversationMessage, ConversationMessageRecord } from "./types";

/** Event data keys a buyer may see (ids and state words, never staff notes). */
const BUYER_EVENT_DATA_KEYS = new Set(["type", "status", "fromStatus", "toStatus", "requestId"]);

function projectEventData(data: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!data) return null;
  const projected: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!BUYER_EVENT_DATA_KEYS.has(key)) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") projected[key] = value;
  }
  return Object.keys(projected).length > 0 ? projected : null;
}

export function projectMessageForBuyer(message: ConversationMessageRecord): BuyerConversationMessage | null {
  if (!isBuyerVisibleMessage(message)) return null;
  return {
    id: message.id,
    seq: message.seq,
    kind: message.kind,
    from: message.authorType === "staff"
      ? "store"
      : message.authorType === "system"
        ? "system"
        : "buyer",
    body: message.body,
    eventKind: message.eventKind,
    eventData: projectEventData(message.eventData),
    createdAt: message.createdAt,
    attachments: message.attachments,
  };
}

export function projectMessagesForBuyer(messages: readonly ConversationMessageRecord[]): BuyerConversationMessage[] {
  const projected: BuyerConversationMessage[] = [];
  for (const message of messages) {
    const line = projectMessageForBuyer(message);
    if (line) projected.push(line);
  }
  return projected;
}
