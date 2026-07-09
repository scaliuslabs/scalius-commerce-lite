import { z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { GENERATION_CONFIG } from "@scalius/core/modules/ai";
import { redactAssistantSensitiveText } from "@scalius/shared/assistant-redaction";
import { ValidationError } from "../../utils/api-error";

const MAX_TEXT_CHARS = GENERATION_CONFIG.context.maxPromptChars;

export const ADMIN_CHAT_MAX_MESSAGES = 24;
export const ADMIN_CHAT_MAX_TEXT_CHARS = 80_000;
export const ADMIN_CHAT_MAX_OUTPUT_TOKENS = 2_400;
export const ADMIN_CHAT_MAX_NAVIGATION_PAGES = 24;
export const ADMIN_CHAT_MAX_NAVIGATION_CONTEXT_CHARS = 1_800;
export const ADMIN_CHAT_MAX_NAVIGATION_ACTIONS = 1;
export const ADMIN_CHAT_MAX_PRODUCT_COPY_CONTEXT_CHARS = 18_000;
export const ADMIN_CHAT_MAX_PRODUCT_DESCRIPTION_CHARS = 14_000;
export const ADMIN_CHAT_MAX_PAGE_ACTION_CONTEXT_CHARS = 1_200;
export const ADMIN_CHAT_MAX_PAGE_ACTION_VALUE_CHARS = 12_000;
export const ADMIN_CHAT_MAX_PAGE_ACTION_ROW_IDS = 100;
export const ADMIN_CHAT_MAX_PAGE_ACTION_ROW_ID_CHARS = 80;
export const ADMIN_CHAT_TOOL_ACTION_FALLBACK =
  "I prepared a safe dashboard action for this request. Use the visible action button to continue.";
export const ADMIN_CHAT_TOOL_GUIDANCE_FALLBACK =
  "I could not turn the model response into safe dashboard guidance. Please use the visible dashboard controls for this request.";
export const ADMIN_AGENT_MCP_URL = "http://admin-agent.internal/mcp";
export const ADMIN_NAVIGATION_CONTEXT_TOOL = "admin_navigation_context";
export const ADMIN_PRODUCT_SEARCH_TOOL = "admin_product_search";
export const ADMIN_PRODUCT_COPY_CONTEXT_TOOL = "admin_product_copy_context";
export const ADMIN_AGENT_MCP_PROTOCOL_VERSION = "2025-11-25";
export const ADMIN_CHAT_SYSTEM_PROMPT = [
  "You are the Scalius Commerce admin assistant for merchants and operators.",
  "Use only the conversation, verified read-only context, and current visible dashboard context. This endpoint cannot directly change settings, mutate products, modify orders, adjust inventory, trigger payments, deploy code, inspect logs, or clear caches.",
  "If a safe destination list exists, mention only those pages; the API may attach a separate click-confirmed navigation button. Do not claim navigation is impossible when that button is available.",
  "If the visible page advertises safe page actions, the API may attach click-confirmed buttons for focus, draft, selection, or form-save actions. Never claim an action happened until the visible UI reports success.",
  "Use read-only product/page context for drafting only. Never claim a product, setting, order, payment, inventory row, or credential changed unless a verified workflow reports success.",
  "For unsupported actions, give safe dashboard steps or tell the merchant to ask an operator to run a verified workflow.",
  "Do not ask for or repeat secrets, OTPs, API keys, credential material, payment proofs, customer contact details, or session tokens.",
  "Keep answers concise, practical, and explicit about uncertainty.",
].join("\n");

export const chatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1).max(MAX_TEXT_CHARS),
});

export const adminChatPageActionTypeSchema = z.enum([
  "focus_surface",
  "apply_field_draft",
  "save_registered_form",
  "select_visible_rows",
  "clear_selection",
]);

export const adminChatSurfaceActionSchema = z
  .object({
    id: z.string().max(80),
    type: adminChatPageActionTypeSchema,
    label: z.string().max(160).optional(),
    safeFields: z.array(z.string().max(80)).max(12).optional(),
    visibleRowIds: z
      .array(z.string().max(80))
      .max(ADMIN_CHAT_MAX_PAGE_ACTION_ROW_IDS * 4)
      .optional(),
  })
  .passthrough();

export const adminChatSurfaceSchema = z
  .object({
    id: z.string().max(80),
    kind: z.enum(["dialog", "form", "panel", "surface", "table"]).optional(),
    label: z.string().max(160).optional(),
    dirty: z.boolean().optional(),
    submitting: z.boolean().optional(),
    selectedCount: z.number().int().min(0).max(10_000).optional(),
    validationErrorCount: z.number().int().min(0).max(10_000).optional(),
    assistantActions: z.array(adminChatSurfaceActionSchema).max(10).optional(),
  })
  .passthrough();

export const adminChatPageContextSchema = z
  .object({
    routePath: z.string().max(240).optional(),
    surfaces: z.array(adminChatSurfaceSchema).max(20).optional(),
  })
  .passthrough();

export const chatSchema = z.object({
  messages: z.array(chatMessageSchema).min(1).max(ADMIN_CHAT_MAX_MESSAGES),
  pageContext: adminChatPageContextSchema.nullable().optional(),
});

export type GenerationUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};
export type ApiContext = Context<{ Bindings: Env }>;
export type JsonRecord = Record<string, unknown>;
export type AdminChatNavigationEntry = {
  path: string;
  name: string;
  section: string;
};
export type AdminChatNavigateAction = {
  type: "navigate";
  path: string;
  label: string;
};
export type AdminChatPageActionType = z.infer<
  typeof adminChatPageActionTypeSchema
>;
export type AdminChatPageAction = {
  type: AdminChatPageActionType;
  id: string;
  targetId: string;
  label: string;
  fieldName?: string;
  value?: string | number | boolean | null;
  rowIds?: string[];
};
export type AdminChatAction = AdminChatNavigateAction | AdminChatPageAction;
export type AdminChatGenerationResult = {
  text: string;
  usage: GenerationUsage;
};
export type AdminChatAssistantText = {
  text: string;
  safeForPageActionValue: boolean;
  usedFallback: boolean;
};
export type AdminAgentMcpSession = {
  protocolVersion?: string;
  sessionId?: string;
};
export type AdminChatProductCopyContext = {
  id: string;
  name: string;
  slug?: string;
  route?: string;
  status?: string;
  categoryName?: string;
  descriptionText?: string;
};
export function validateAdminChatPayload(
  messages: Array<z.infer<typeof chatMessageSchema>>,
): void {
  const textChars = messages.reduce(
    (total, message) => total + message.content.length,
    0,
  );
  if (textChars > ADMIN_CHAT_MAX_TEXT_CHARS) {
    throw new ValidationError(
      `AI chat is too large. Maximum is ${ADMIN_CHAT_MAX_TEXT_CHARS} characters.`,
    );
  }
}

export function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function compactAdminChatText(
  value: unknown,
  maxLength: number,
): string | null {
  if (typeof value !== "string") return null;
  const compacted = value.replace(/\s+/g, " ").trim();
  if (!compacted) return null;
  const redacted = redactAssistantSensitiveText(compacted);
  return redacted.length <= maxLength
    ? redacted
    : redacted.slice(0, maxLength).trimEnd();
}

export function latestUserChatText(
  messages: Array<z.infer<typeof chatMessageSchema>>,
): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return message.content;
  }
  return "";
}
