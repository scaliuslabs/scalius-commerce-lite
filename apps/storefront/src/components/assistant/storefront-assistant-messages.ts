import type {
  FlueConversationMessage,
  FlueConversationPart,
} from "@flue/sdk";
import { isScaliusComputerResultContinuation } from "@scalius/shared/assistant-computer-handoff";

import {
  MAX_MESSAGE_CHARS,
  cleanAssistantDisplayText,
  type StorefrontAssistantUiMessage,
} from "./storefront-assistant-chat";

export function flueMessageText(message: FlueConversationMessage): string {
  return cleanAssistantDisplayText(
    message.parts
      .flatMap((part) =>
        part.type === "text" &&
        !isScaliusComputerResultContinuation(part.text, "storefront")
          ? [part.text]
          : [],
      )
      .join("\n\n"),
    MAX_MESSAGE_CHARS,
  );
}

export function restoredToFlueMessages(
  messages: readonly StorefrontAssistantUiMessage[],
): FlueConversationMessage[] {
  return messages.flatMap((message) => {
    const text = cleanAssistantDisplayText(
      message.parts
        .flatMap((part) =>
          part.type === "text" &&
          !isScaliusComputerResultContinuation(part.text, "storefront")
            ? [part.text]
            : [],
        )
        .join("\n\n"),
      MAX_MESSAGE_CHARS,
    );
    return text
      ? [
          {
            id: message.id,
            role: message.role,
            parts: [{ type: "text" as const, text, state: "done" as const }],
          },
        ]
      : [];
  });
}

export function mergeRestoredFlueMessages(
  restored: readonly FlueConversationMessage[],
  live: readonly FlueConversationMessage[],
): FlueConversationMessage[] {
  const liveIds = new Set(live.map((message) => message.id));
  return [...restored.filter((message) => !liveIds.has(message.id)), ...live];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGroundedCatalogPart(part: FlueConversationPart): boolean {
  if (
    part.type !== "dynamic-tool" ||
    part.toolName !== "scalius" ||
    part.state !== "output-available" ||
    !isRecord(part.output) ||
    part.output.ok !== true ||
    part.output.authoritative !== true ||
    !isRecord(part.output.data) ||
    part.output.data.command !== "call" ||
    !isRecord(part.output.data.capability)
  ) {
    return false;
  }
  return ["catalog.search", "catalog.list", "catalog.product"].includes(
    String(part.output.data.capability.id),
  );
}

/**
 * Collapse Flue's separate tool/answer messages into one visible assistant
 * message per durable submission (or user turn without a submission id).
 */
export function projectStorefrontAssistantMessages(
  messages: readonly FlueConversationMessage[],
): FlueConversationMessage[] {
  // Flue persists browser continuations as durable user-role messages. They are
  // control-plane acknowledgements, not buyer-authored transcript content, so
  // classify the exact validated envelope by content rather than role.
  const transcriptMessages = messages.flatMap((message) => {
    const parts = message.parts.filter(
      (part) =>
        part.type !== "text" ||
        !isScaliusComputerResultContinuation(part.text, "storefront"),
    );
    return parts.length > 0 ? [{ ...message, parts }] : [];
  });
  const groups = new Map<
    string,
    { messages: FlueConversationMessage[]; lastIndex: number }
  >();
  const groupKeyByIndex = new Map<number, string>();
  let turn = 0;

  transcriptMessages.forEach((message, index) => {
    if (message.role === "user") {
      turn += 1;
      return;
    }
    const key = message.submissionId
      ? `submission:${message.submissionId}`
      : `turn:${turn}`;
    const group = groups.get(key) ?? { messages: [], lastIndex: index };
    group.messages.push(message);
    group.lastIndex = index;
    groups.set(key, group);
    groupKeyByIndex.set(index, key);
  });

  const projectedByIndex = new Map<number, FlueConversationMessage>();
  for (const group of groups.values()) {
    const visibleTextParts = new Map<
      FlueConversationMessage,
      FlueConversationPart[]
    >();
    for (const message of group.messages) {
      visibleTextParts.set(
        message,
        message.parts.filter(
          (part) =>
            part.type === "text" &&
            part.text.trim().length > 0,
        ),
      );
    }
    const terminalToolCalls = new Set<string>();
    for (const message of group.messages) {
      for (const part of message.parts) {
        if (
          part.type === "dynamic-tool" &&
          (part.state === "output-available" ||
            part.state === "output-error")
        ) {
          terminalToolCalls.add(part.toolCallId);
        }
      }
    }

    let lastTextMessage: FlueConversationMessage | undefined;
    for (let index = group.messages.length - 1; index >= 0; index -= 1) {
      const candidate = group.messages[index];
      if (candidate && (visibleTextParts.get(candidate)?.length ?? 0) > 0) {
        lastTextMessage = candidate;
        break;
      }
    }
    const catalogParts = group.messages.flatMap((message) =>
      message.parts.filter(isGroundedCatalogPart),
    );
    const errorParts = group.messages
      .flatMap((message) =>
        message.parts.filter(
          (part) =>
            part.type === "dynamic-tool" && part.state === "output-error",
        ),
      )
      .slice(-2);
    const hasFinalContent = Boolean(lastTextMessage) || catalogParts.length > 0;
    const activeParts = hasFinalContent
      ? []
      : group.messages
          .flatMap((message) =>
            message.parts.filter(
              (part) =>
                part.type === "dynamic-tool" &&
                part.state === "input-available" &&
                !terminalToolCalls.has(part.toolCallId),
            ),
          )
          .slice(-2);
    const textParts = lastTextMessage
      ? (visibleTextParts.get(lastTextMessage) ?? [])
      : [];
    const parts = [
      ...textParts,
      ...catalogParts,
      ...errorParts,
      ...activeParts,
    ];
    if (parts.length === 0) continue;

    const source =
      lastTextMessage ??
      group.messages.findLast((message) =>
        message.parts.some(isGroundedCatalogPart),
      ) ??
      group.messages.at(-1);
    if (!source) continue;
    projectedByIndex.set(group.lastIndex, { ...source, parts });
  }

  return transcriptMessages.flatMap((message, index) => {
    if (message.role === "user") return [message];
    const key = groupKeyByIndex.get(index);
    const group = key ? groups.get(key) : undefined;
    if (!group || group.lastIndex !== index) return [];
    const projected = projectedByIndex.get(index);
    return projected ? [projected] : [];
  });
}

export function toSessionHandoffMessages(
  messages: readonly FlueConversationMessage[],
): StorefrontAssistantUiMessage[] {
  return messages.flatMap((message) => {
    const text = flueMessageText(message);
    return text
      ? [
          {
            id: message.id,
            role: message.role,
            parts: [{ type: "text" as const, text }],
          },
        ]
      : [];
  });
}
