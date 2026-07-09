import { z } from "@hono/zod-openapi";
import {
  ADMIN_CHAT_MAX_NAVIGATION_ACTIONS,
  ADMIN_CHAT_MAX_PAGE_ACTION_CONTEXT_CHARS,
  ADMIN_CHAT_MAX_PAGE_ACTION_ROW_ID_CHARS,
  ADMIN_CHAT_MAX_PAGE_ACTION_ROW_IDS,
  ADMIN_CHAT_MAX_PAGE_ACTION_VALUE_CHARS,
  ADMIN_CHAT_TOOL_ACTION_FALLBACK,
  ADMIN_CHAT_TOOL_GUIDANCE_FALLBACK,
  adminChatSurfaceActionSchema,
  adminChatSurfaceSchema,
  chatMessageSchema,
  chatSchema,
  compactAdminChatText,
  isJsonRecord,
  type AdminChatAction,
  type AdminChatAssistantText,
  type AdminChatNavigateAction,
  type AdminChatNavigationEntry,
  type AdminChatPageAction,
  type AdminChatPageActionType,
} from "./ai-chat-contract";
import { hasProductCopyIntent, safeAdminNavigationPath } from "./ai-chat-mcp";

export function formatAdminChatPageActionContext(
  pageContext: z.infer<typeof chatSchema>["pageContext"],
): string | null {
  const surfaces = pageContext?.surfaces ?? [];
  const lines: string[] = [];

  for (const surface of surfaces) {
    const actions = surface.assistantActions ?? [];
    if (actions.length === 0) continue;

    const actionFacts = actions.map((action) => {
      const fields = action.safeFields?.length
        ? ` fields=${action.safeFields.join("/")}`
        : "";
      return `${action.type}${fields}`;
    });
    lines.push(`- ${surface.id}: ${actionFacts.join(", ")}`);
  }

  if (lines.length === 0) return null;
  return compactAdminChatText(
    [
      "Current visible page action buttons may be attached only for these browser-advertised actions:",
      ...lines,
      "If drafting a product name or description, write the exact replacement content so the dashboard can show a click-confirmed Apply button. Do not say the form was saved unless the user clicks a visible save action and the UI reports success.",
    ].join("\n"),
    ADMIN_CHAT_MAX_PAGE_ACTION_CONTEXT_CHARS,
  );
}

export function readRegisteredPageAction(
  pageContext: z.infer<typeof chatSchema>["pageContext"],
  options: {
    type: AdminChatPageActionType;
    fieldName?: string;
  },
): {
  action: z.infer<typeof adminChatSurfaceActionSchema>;
  targetId: string;
  surface: z.infer<typeof adminChatSurfaceSchema>;
} | null {
  const surfaces = pageContext?.surfaces ?? [];

  for (const surface of surfaces) {
    const actions = surface.assistantActions ?? [];
    for (const action of actions) {
      if (action.type !== options.type) continue;
      if (
        options.fieldName &&
        action.safeFields?.length &&
        !action.safeFields.includes(options.fieldName)
      ) {
        continue;
      }

      return { action, targetId: surface.id, surface };
    }
  }

  return null;
}

export function createAdminChatPageActions(
  pageContext: z.infer<typeof chatSchema>["pageContext"],
  messages: Array<z.infer<typeof chatMessageSchema>>,
  assistantText: string,
): AdminChatPageAction[] {
  const latestText = latestUserChatText(messages);
  const actions: AdminChatPageAction[] = [];

  const draftField = inferVisibleProductDraftField(latestText);
  if (draftField) {
    const registered = readRegisteredPageAction(pageContext, {
      type: "apply_field_draft",
      fieldName: draftField,
    });
    const value = compactAdminChatText(
      assistantText,
      draftField === "description"
        ? ADMIN_CHAT_MAX_PAGE_ACTION_VALUE_CHARS
        : 160,
    );
    if (registered && value) {
      actions.push({
        type: "apply_field_draft",
        id: registered.action.id,
        targetId: registered.targetId,
        label:
          draftField === "description"
            ? "Apply to description"
            : "Apply to product name",
        fieldName: draftField,
        value,
      });
    }
  }

  if (hasVisibleSaveIntent(latestText)) {
    const registered = readRegisteredPageAction(pageContext, {
      type: "save_registered_form",
    });
    if (
      registered &&
      registered.surface.dirty === true &&
      registered.surface.submitting !== true &&
      (registered.surface.validationErrorCount ?? 0) === 0
    ) {
      actions.push({
        type: "save_registered_form",
        id: registered.action.id,
        targetId: registered.targetId,
        label: "Save visible form",
      });
    }
  }

  if (!hasDestructiveBulkSelectionIntent(latestText)) {
    if (hasClearSelectionIntent(latestText)) {
      const registered = readRegisteredPageAction(pageContext, {
        type: "clear_selection",
      });
      if (
        registered &&
        registered.surface.kind === "table" &&
        !(
          typeof registered.surface.selectedCount === "number" &&
          registered.surface.selectedCount <= 0
        )
      ) {
        actions.push({
          type: "clear_selection",
          id: registered.action.id,
          targetId: registered.targetId,
          label: "Clear selection",
        });
      }
    }

    if (hasSelectVisibleRowsIntent(latestText)) {
      const registered = readRegisteredPageAction(pageContext, {
        type: "select_visible_rows",
      });
      const rowIds = registered ? readVisibleRowIds(registered.action) : [];
      if (
        registered &&
        registered.surface.kind === "table" &&
        rowIds.length > 0
      ) {
        actions.push({
          type: "select_visible_rows",
          id: registered.action.id,
          targetId: registered.targetId,
          label: "Select visible rows",
          rowIds,
        });
      }
    }
  }

  return actions.slice(0, 2);
}

export function inferVisibleProductDraftField(
  text: string,
): "name" | "description" | null {
  if (!hasProductCopyIntent(text)) return null;
  if (/\b(?:description|copy|content|seo|listing)\b/i.test(text)) {
    return "description";
  }
  if (/\b(?:name|title|headline)\b/i.test(text)) return "name";
  return "description";
}

export function hasVisibleSaveIntent(text: string): boolean {
  return (
    /\b(?:save|submit|update)\b/i.test(text) &&
    /\b(?:form|product|changes|draft)\b/i.test(text)
  );
}

export function hasClearSelectionIntent(text: string): boolean {
  return (
    /\bclear\s+(?:the\s+)?selection\b/i.test(text) ||
    /\bunselect\s+(?:all|selected(?:\s+rows?)?|rows?)\b/i.test(text) ||
    /\bdeselect\s+(?:all|selected(?:\s+rows?)?|rows?|(?:the\s+)?selection)\b/i.test(
      text,
    )
  );
}

export function hasSelectVisibleRowsIntent(text: string): boolean {
  return /\bselect\s+(?:all\s+visible(?:\s+(?:products|rows?|items?))?|visible\s+(?:products|rows?|items?)|all\s+(?:products|rows?|items?)\s+on\s+(?:this|the|current)\s+page)\b/i.test(
    text,
  );
}

export function hasDestructiveBulkSelectionIntent(text: string): boolean {
  return (
    /\b(?:bulk\s+delete|delete\s+(?:selected|all)|trash\s+(?:selected|all)|remove\s+(?:selected|all)|permanently\s+delete)\b/i.test(
      text,
    ) ||
    (/\b(?:delete|trash|remove)\b/i.test(text) &&
      /\b(?:selected|bulk|products|rows?|items?)\b/i.test(text))
  );
}

export function readVisibleRowIds(
  action: z.infer<typeof adminChatSurfaceActionSchema>,
): string[] {
  const rowIds: string[] = [];
  for (const rowId of action.visibleRowIds ?? []) {
    const sanitized = sanitizeAdminChatOpaqueRowId(rowId);
    if (!sanitized || rowIds.includes(sanitized)) continue;
    rowIds.push(sanitized);
    if (rowIds.length >= ADMIN_CHAT_MAX_PAGE_ACTION_ROW_IDS) break;
  }
  return rowIds;
}

export function sanitizeAdminChatOpaqueRowId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw || containsSensitiveOpaqueRowIdPattern(raw)) return null;

  const sanitized = compactAdminChatText(
    raw,
    ADMIN_CHAT_MAX_PAGE_ACTION_ROW_ID_CHARS,
  );
  if (!sanitized || containsSensitiveOpaqueRowIdPattern(sanitized)) return null;
  return sanitized;
}

export function containsSensitiveOpaqueRowIdPattern(value: string): boolean {
  return (
    value.includes("@") ||
    /(?:\+?88)?01[3-9]\d{8}/.test(value) ||
    /(?:chk|cst|otp|tok|token|session|secret|sk|pk)_[A-Za-z0-9_-]{6,}/i.test(
      value,
    )
  );
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

export function normalizeNavigationMatchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\/admin(?:\/[a-z0-9-]+)*/g, (path) => ` ${path} `)
    .replace(/[^a-z0-9/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function navigationTokens(value: string): string[] {
  return normalizeNavigationMatchText(value)
    .split(" ")
    .map((token) => token.trim())
    .filter(Boolean);
}

export function tokenVariants(token: string): string[] {
  if (token.length > 3 && token.endsWith("s"))
    return [token, token.slice(0, -1)];
  return [token];
}

export function textContainsPhrase(haystack: string, needle: string): boolean {
  const normalizedNeedle = normalizeNavigationMatchText(needle);
  if (!normalizedNeedle) return false;
  return ` ${haystack} `.includes(` ${normalizedNeedle} `);
}

export function textContainsTokens(
  haystackTokens: Set<string>,
  needle: string,
): boolean {
  const tokens = navigationTokens(needle);
  if (tokens.length === 0) return false;
  return tokens.every((token) =>
    tokenVariants(token).some((variant) => haystackTokens.has(variant)),
  );
}

export function hasNavigationIntent(text: string): boolean {
  return /\b(?:go|open|navigate|visit|show|view|take|send|jump|link|page|screen|section|where|manage)\b/i.test(
    text,
  );
}

export function createAdminChatNavigationActions(
  entries: AdminChatNavigationEntry[],
  messages: Array<z.infer<typeof chatMessageSchema>>,
): AdminChatNavigateAction[] {
  if (entries.length === 0) return [];

  const latestText = latestUserChatText(messages);
  const normalizedText = normalizeNavigationMatchText(latestText);
  if (!normalizedText) return [];

  const tokens = new Set(navigationTokens(latestText).flatMap(tokenVariants));
  const intent = hasNavigationIntent(latestText);
  const candidates = entries
    .map((entry, index) => {
      const exactPath = latestText
        .toLowerCase()
        .includes(entry.path.toLowerCase());
      let score = exactPath ? 100 : 0;
      if (textContainsPhrase(normalizedText, entry.name)) score += 50;
      else if (textContainsTokens(tokens, entry.name)) score += 35;
      if (textContainsPhrase(normalizedText, entry.section)) score += 10;
      else if (textContainsTokens(tokens, entry.section)) score += 5;
      return { entry, exactPath, index, score };
    })
    .filter(
      (candidate) => candidate.score > 0 && (intent || candidate.exactPath),
    )
    .sort((a, b) => b.score - a.score || a.index - b.index);

  return candidates
    .slice(0, ADMIN_CHAT_MAX_NAVIGATION_ACTIONS)
    .map(({ entry }) => ({
      type: "navigate" as const,
      path: entry.path,
      label: `Open ${entry.name}`,
    }));
}
export function normalizeAdminChatAssistantWhitespace(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function stripProviderToolCallSections(value: string): string {
  return value
    .replace(
      /<\|tool_calls_section_begin\|>[\s\S]*?(?:<\|tool_calls_section_end\|>|$)/gi,
      " ",
    )
    .replace(/<\|tool_call_begin\|>[\s\S]*?(?:<\|tool_call_end\|>|$)/gi, " ")
    .replace(/<tool_calls?>[\s\S]*?<\/tool_calls?>/gi, " ")
    .replace(/<function_call>[\s\S]*?<\/function_call>/gi, " ")
    .replace(/<\|[^|>]*(?:tool|function)[^|>]*\|>/gi, " ");
}

export function containsProviderToolCallArtifact(value: string): boolean {
  return (
    /<\|[^|>]*(?:tool|function)[^|>]*\|>/i.test(value) ||
    /<\/?(?:tool_calls?|function_call)\b/i.test(value)
  );
}

export function unfenceJsonCandidate(value: string): string {
  const match = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (match?.[1] ?? value).trim();
}

export function isRawFunctionCallJsonValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(isRawFunctionCallJsonValue);
  if (!isJsonRecord(value)) return false;

  if (Array.isArray(value.tool_calls) || value.function_call !== undefined)
    return true;
  if (
    typeof value.name === "string" &&
    (value.arguments !== undefined || value.parameters !== undefined)
  ) {
    return true;
  }
  if (
    value.type === "function" &&
    isJsonRecord(value.function) &&
    typeof value.function.name === "string"
  ) {
    return true;
  }

  return Object.values(value).some(isRawFunctionCallJsonValue);
}

export function looksLikeRawFunctionCallText(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/\bfunctions\.[A-Za-z0-9_.:-]+\b/i.test(trimmed)) return true;
  if (/"(?:tool_calls|function_call)"\s*:/i.test(trimmed)) return true;
  if (/"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:/i.test(trimmed)) return true;

  const jsonCandidate = unfenceJsonCandidate(trimmed);
  if (!/^[{[]/.test(jsonCandidate)) return false;
  try {
    return isRawFunctionCallJsonValue(JSON.parse(jsonCandidate));
  } catch {
    return false;
  }
}

export function sanitizeAdminChatAssistantText(
  rawText: string,
): AdminChatAssistantText {
  const normalized = normalizeAdminChatAssistantWhitespace(rawText);
  const withoutToolSections = normalizeAdminChatAssistantWhitespace(
    stripProviderToolCallSections(normalized),
  );
  const unsafeToolOutput =
    !withoutToolSections ||
    containsProviderToolCallArtifact(normalized) ||
    containsProviderToolCallArtifact(withoutToolSections) ||
    looksLikeRawFunctionCallText(normalized) ||
    looksLikeRawFunctionCallText(withoutToolSections);

  if (unsafeToolOutput) {
    return { text: "", safeForPageActionValue: false, usedFallback: true };
  }

  return {
    text: withoutToolSections,
    safeForPageActionValue: true,
    usedFallback: false,
  };
}

export function containsSafeAdminNavigationMarkdownLink(
  value: string,
): boolean {
  for (const match of value.matchAll(
    /\[[^\]\n]{1,160}\]\((\/admin(?:\/[a-z0-9-]+)*)\)/gi,
  )) {
    if (safeAdminNavigationPath(match[1])) return true;
  }
  return false;
}

export function fallbackAdminChatAssistantText(
  actions: AdminChatAction[],
): string {
  return actions.length > 0
    ? ADMIN_CHAT_TOOL_ACTION_FALLBACK
    : ADMIN_CHAT_TOOL_GUIDANCE_FALLBACK;
}
