import type { AssistantMessagePart } from "@scalius/shared/assistant-contracts";

import type { AdminAssistantChatAction } from "../../../lib/api-functions/ai";

export type AdminAssistantMessageRole = "assistant" | "user";

export interface AdminAssistantMessage {
  id: string;
  role: AdminAssistantMessageRole;
  content: string;
  parts?: AssistantMessagePart[];
  actions?: AdminAssistantChatAction[];
  transcriptSequence?: number;
}

export type AdminAssistantStatus =
  | { kind: "idle"; message: string }
  | { kind: "success"; message: string }
  | { kind: "disabled"; message: string }
  | { kind: "error"; message: string };

export type AdminAssistantActionExecutionState = "running" | "consumed";
