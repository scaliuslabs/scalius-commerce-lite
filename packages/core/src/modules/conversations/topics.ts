// The merchant's conversation topics (Settings → Inbox): the short list a
// buyer picks from when they write to the store. A conversation keeps the
// topic's key; its label is read from the current list in the page's
// language (resource `conversation_topic`, id = key), so a renamed topic
// reads its new name everywhere and a removed one reads no label.
import type { Database } from "@scalius/database/client";
import {
  isConversationTopicKey,
  normalizeConversationTopics,
  type ConversationTopic,
} from "@scalius/shared/conversation";
import { ValidationError } from "../../errors";
import { conversationTopicsDocument } from "../settings";

/** A thread's topic as a reader shows it: the key, and its label while the merchant still lists it. */
export interface ConversationTopicView {
  key: string;
  label: string | null;
}

/**
 * The merchant's topics in the store's default language. A reader in another
 * language folds their translations (resource `conversation_topic`, id = key)
 * where it knows the page's presence (the API's buyer conversation view).
 */
export async function readConversationTopics(db: Database): Promise<ConversationTopic[]> {
  return (await conversationTopicsDocument.read(db)).topics;
}

/** The editor's read: the source list and its revision. */
export async function getConversationTopicsDocument(db: Database): Promise<{ topics: ConversationTopic[]; revision: number }> {
  const { value, revision } = await conversationTopicsDocument.readDetailed(db, {}, { skipCache: true });
  return { topics: value.topics, revision };
}

const TOPIC_REFUSALS = {
  too_many: "List at most 12 topics.",
  invalid_key: "Each topic needs a key of lowercase letters, digits, - or _ (up to 40).",
  duplicate_key: "Each topic key can be listed once.",
  invalid_label: "Each topic needs a one-line name of up to 60 characters.",
} as const;

/** Replaces the list. A stale `expectedRevision` is a 409; an invalid list says which entry and why (`details.reason`). */
export async function saveConversationTopics(
  db: Database,
  topics: unknown,
  options: { expectedRevision?: number } = {},
): Promise<{ topics: ConversationTopic[]; revision: number }> {
  const normalized = normalizeConversationTopics(topics);
  if (!normalized.ok) {
    throw new ValidationError(TOPIC_REFUSALS[normalized.reason], { reason: normalized.reason, ...(normalized.index === undefined ? {} : { index: normalized.index }) });
  }
  const written = await conversationTopicsDocument.write(db, { topics: normalized.value }, {}, { replace: true, expectedRevision: options.expectedRevision });
  return { topics: written.value.topics, revision: written.revision };
}

/**
 * The key a buyer chose, checked against the current list: null for none,
 * else one of the listed keys. A refusal names the keys that are allowed.
 */
export function chosenConversationTopic(topics: readonly ConversationTopic[], input: unknown): string | null {
  if (input === undefined || input === null || input === "") return null;
  if (isConversationTopicKey(input) && topics.some((topic) => topic.key === input)) return input;
  throw new ValidationError(topics.length === 0 ? "This store has no conversation topics. Send the message without one." : "Choose one of the store's topics.", {
    field: "topic",
    reason: "unknown_topic",
    allowed: topics.map((topic) => topic.key),
  });
}

/** A thread's topic for a reader, labelled from `topics` (already in the reader's language). */
export function conversationTopicView(key: string | null, topics: readonly ConversationTopic[]): ConversationTopicView | null {
  if (!key) return null;
  return { key, label: topics.find((topic) => topic.key === key)?.label ?? null };
}
