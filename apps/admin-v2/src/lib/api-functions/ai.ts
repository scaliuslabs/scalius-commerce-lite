import { createServerFn } from "@tanstack/react-start";
import { apiGetText, apiPost } from "../api.server";

export interface AiPromptInput {
  type: string;
}

export interface AiContextBatchDetailsInput {
  productIds?: string[];
  categoryIds?: string[];
  collectionIds?: string[];
  anchorCollectionIds?: string[];
  allCategories?: boolean;
}

export interface AiProductContextDetail {
  id: string;
  name: string;
  description: string | null;
  price: number;
  discountType: "percentage" | "flat" | null;
  discountAmount: number | null;
  discountPercentage: number | null;
  freeDelivery: boolean;
  slug: string;
  url: string;
  buyNowUrl: string;
  finalPrice: number;
  category: {
    id: string;
    name: string;
    slug: string;
    url: string;
  } | null;
  images: Array<{ url: string; alt: string | null; isPrimary: boolean }>;
  variants: Array<{
    id: string;
    sku: string;
    size: string | null;
    color: string | null;
    stock: number;
    price: number;
    discountType: "percentage" | "flat" | null;
    discountAmount: number | null;
    discountPercentage: number | null;
    buyNowUrl: string;
    finalPrice: number;
  }>;
  attributes: Array<{ name: string; value: string }>;
}

export interface AiCategoryContextDetail {
  id: string;
  name: string;
  description: string | null;
  slug: string;
  imageUrl: string | null;
  url: string;
}

export interface AiCollectionProductContextDetail {
  id: string;
  name: string;
  slug: string;
  url: string;
  price: number;
  discountedPrice: number;
  imageUrl: string | null;
  imageAlt: string | null;
}

export interface AiCollectionCategoryContextDetail {
  id: string;
  name: string;
  slug: string;
  url: string;
}

export interface AiCollectionContextDetail {
  id: string;
  name: string;
  type: "manual" | "dynamic";
  url: string;
  title: string | null;
  subtitle: string | null;
  placementRoles: Array<"target" | "anchor">;
  products: AiCollectionProductContextDetail[];
  categories: AiCollectionCategoryContextDetail[];
  featuredProduct: AiCollectionProductContextDetail | null;
}

export interface AiContextBatchWarnings {
  productsTruncated: boolean;
  categoriesTruncated: boolean;
  collectionsTruncated: boolean;
  productsUnavailable: number;
  categoriesUnavailable: number;
  collectionsUnavailable: number;
  maxProducts: number;
  maxCategories: number;
  maxCollections: number;
}

export interface AiContextBatchDetails {
  products: AiProductContextDetail[];
  categories: AiCategoryContextDetail[];
  collections: AiCollectionContextDetail[];
  warnings: AiContextBatchWarnings;
}

export interface AdminAssistantSurfaceContext {
  id: string;
  kind: "dialog" | "form" | "panel" | "surface" | "table";
  label?: string;
  dirty?: boolean;
  submitting?: boolean;
  open?: boolean;
  selectedCount?: number;
  rowCount?: number;
  validationErrorCount?: number;
}

export interface AdminAssistantPageContext {
  version: number;
  routePath: string;
  pageTitle: string | null;
  pageHeading: string | null;
  mainScroll?: {
    top: number;
    maxTop: number;
    viewportHeight: number;
    contentHeight: number;
    atTop: boolean;
    atBottom: boolean;
  };
  surfaces: AdminAssistantSurfaceContext[];
}

export interface AdminAssistantChatInput {
  message: string;
  pageContext: AdminAssistantPageContext | null;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface AdminAssistantChatUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface AdminAssistantNavigateAction {
  type: "navigate";
  path: string;
  label: string;
}

export interface AdminAssistantChatApiMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AdminAssistantChatApiRequest {
  messages: AdminAssistantChatApiMessage[];
}

export type AdminAssistantChatResult =
  | {
      status: "ok";
      message: { role: "assistant"; content: string };
      usage?: AdminAssistantChatUsage | null;
      actions?: AdminAssistantNavigateAction[];
    }
  | {
      status: "disabled";
      reason: "api-missing" | "profile-disabled" | "unconfigured";
      message: string;
    }
  | {
      status: "error";
      message: string;
    };

const ADMIN_ASSISTANT_MAX_MESSAGE_CHARS = 2_000;
const ADMIN_ASSISTANT_MAX_HISTORY_ITEMS = 6;
const ADMIN_ASSISTANT_MAX_CONTEXT_TEXT_CHARS = 180;
const ADMIN_ASSISTANT_MAX_SURFACES = 12;
const ADMIN_ASSISTANT_MAX_ROUTE_CHARS = 240;
const ADMIN_ASSISTANT_MAX_ACTIONS = 3;
const ADMIN_ASSISTANT_MAX_ACTION_LABEL_CHARS = 80;

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const BANGLADESH_PHONE_PATTERN = /(^|[^\d])(?:\+?88)?01[3-9]\d{8}(?!\d)/g;
const BROAD_PHONE_PATTERN = /(^|[^\d])\+?\d[\d\s().-]{6,}\d(?!\d)/g;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const TOKEN_PATTERN =
  /\b(?:chk|cst|otp|tok|token|session|secret|sk|pk)_[A-Za-z0-9_-]{6,}\b/gi;
const LONG_TOKEN_PATTERN = /\b[A-Za-z0-9_-]{32,}\b/g;

export const getAiPrompts = createServerFn({ method: "GET" })
  .validator((data: AiPromptInput) => data)
  .handler(async ({ data }) => {
    return apiGetText("/ai-prompts", { type: data.type });
  });

export const getAiContextBatchDetails = createServerFn({ method: "POST" })
  .validator((data: AiContextBatchDetailsInput) => data)
  .handler(async ({ data }) => {
    return apiPost<AiContextBatchDetails>("/ai-context/batch-details", data);
  });

export const sendAdminAssistantMessage = createServerFn({ method: "POST" })
  .validator((data: AdminAssistantChatInput) =>
    normalizeAdminAssistantChatInput(data),
  )
  .handler(async ({ data }): Promise<AdminAssistantChatResult> => {
    try {
      const result = await apiPost<unknown>(
        "/ai/chat",
        createAdminAssistantChatApiRequest(data),
      );
      return normalizeAdminAssistantChatResult(result);
    } catch (error) {
      if (isAdminChatApiMissing(error)) {
        return {
          status: "disabled",
          reason: "api-missing",
          message:
            "Admin chat is not enabled on this deployment yet. The dashboard UI is ready, but the adminChat API route still needs to be deployed.",
        };
      }
      if (isAdminChatConfigurationError(error)) {
        return {
          status: "disabled",
          reason: "unconfigured",
          message:
            "Admin chat is not ready. Enable the adminChat model profile and save a valid provider key before using the assistant.",
        };
      }
      return {
        status: "error",
        message: "Assistant request failed. Nothing was changed.",
      };
    }
  });

export function createAdminAssistantChatApiRequest(
  input: AdminAssistantChatInput,
): AdminAssistantChatApiRequest {
  const normalized = normalizeAdminAssistantChatInput(input);
  const messages: AdminAssistantChatApiMessage[] = [
    ...(normalized.history ?? []),
  ];
  const context = formatAdminAssistantPageContext(normalized.pageContext);

  if (context) {
    messages.push({
      role: "user",
      content: `Current safe dashboard context:\n${context}`,
    });
  }
  if (normalized.message) {
    messages.push({ role: "user", content: normalized.message });
  }

  return { messages };
}

function normalizeAdminAssistantChatInput(
  data: AdminAssistantChatInput,
): AdminAssistantChatInput {
  return {
    message: boundText(data?.message, ADMIN_ASSISTANT_MAX_MESSAGE_CHARS),
    pageContext: normalizeAdminAssistantPageContext(data?.pageContext),
    history: normalizeAdminAssistantHistory(data?.history),
  };
}

function normalizeAdminAssistantPageContext(
  pageContext: AdminAssistantChatInput["pageContext"],
): AdminAssistantPageContext | null {
  if (!pageContext || typeof pageContext !== "object") return null;

  return {
    version: Number.isFinite(pageContext.version) ? pageContext.version : 1,
    routePath: sanitizeRoutePath(pageContext.routePath),
    pageTitle: sanitizeContextText(pageContext.pageTitle),
    pageHeading: sanitizeContextText(pageContext.pageHeading),
    mainScroll: normalizeScrollContext(pageContext.mainScroll),
    surfaces: normalizeSurfaceContext(pageContext.surfaces),
  };
}

function normalizeAdminAssistantHistory(
  history: AdminAssistantChatInput["history"],
): AdminAssistantChatInput["history"] {
  if (!Array.isArray(history)) return [];

  return history
    .filter((message) => message.role === "user" || message.role === "assistant")
    .slice(-ADMIN_ASSISTANT_MAX_HISTORY_ITEMS)
    .map((message) => ({
      role: message.role,
      content: boundText(message.content, ADMIN_ASSISTANT_MAX_MESSAGE_CHARS),
    }))
    .filter((message) => message.content.length > 0);
}

function normalizeScrollContext(
  scroll: AdminAssistantPageContext["mainScroll"],
): AdminAssistantPageContext["mainScroll"] {
  if (!scroll || typeof scroll !== "object") return undefined;
  return {
    top: boundNumber(scroll.top),
    maxTop: boundNumber(scroll.maxTop),
    viewportHeight: boundNumber(scroll.viewportHeight),
    contentHeight: boundNumber(scroll.contentHeight),
    atTop: scroll.atTop === true,
    atBottom: scroll.atBottom === true,
  };
}

function normalizeSurfaceContext(
  surfaces: AdminAssistantPageContext["surfaces"],
): AdminAssistantSurfaceContext[] {
  if (!Array.isArray(surfaces)) return [];

  const normalized: AdminAssistantSurfaceContext[] = [];
  for (const surface of surfaces.slice(0, ADMIN_ASSISTANT_MAX_SURFACES)) {
    const id = sanitizeContextText(surface.id);
    if (!id) continue;
    const kind = isAdminAssistantSurfaceKind(surface.kind)
      ? surface.kind
      : "surface";
    normalized.push({
      id,
      kind,
      label: sanitizeContextText(surface.label) ?? undefined,
      dirty: surface.dirty === true ? true : undefined,
      submitting: surface.submitting === true ? true : undefined,
      open: surface.open === true ? true : undefined,
      selectedCount: optionalBoundNumber(surface.selectedCount),
      rowCount: optionalBoundNumber(surface.rowCount),
      validationErrorCount: optionalBoundNumber(surface.validationErrorCount),
    });
  }
  return normalized;
}

function formatAdminAssistantPageContext(
  pageContext: AdminAssistantPageContext | null,
): string | null {
  if (!pageContext) return null;

  const parts = [
    `Route: ${pageContext.routePath}`,
    pageContext.pageHeading ? `Heading: ${pageContext.pageHeading}` : null,
    pageContext.pageTitle ? `Title: ${pageContext.pageTitle}` : null,
  ];

  if (pageContext.mainScroll) {
    parts.push(
      `Scroll: ${
        pageContext.mainScroll.atTop
          ? "top"
          : pageContext.mainScroll.atBottom
            ? "bottom"
            : "middle"
      }`,
    );
  }

  const surfaces = pageContext.surfaces
    .map((surface) => {
      const facts = [
        surface.label ?? surface.id,
        surface.kind,
        surface.dirty ? "dirty" : null,
        surface.submitting ? "submitting" : null,
        typeof surface.selectedCount === "number"
          ? `${surface.selectedCount} selected`
          : null,
        typeof surface.rowCount === "number" ? `${surface.rowCount} rows` : null,
        typeof surface.validationErrorCount === "number"
          ? `${surface.validationErrorCount} validation errors`
          : null,
      ].filter(Boolean);
      return facts.join(", ");
    })
    .filter(Boolean);

  if (surfaces.length > 0) {
    parts.push(`Visible surfaces: ${surfaces.join(" | ")}`);
  }

  return boundText(parts.filter(Boolean).join("\n"), 1_200) || null;
}

export function normalizeAdminAssistantChatResult(
  result: unknown,
): AdminAssistantChatResult {
  if (!result || typeof result !== "object") {
    return { status: "error", message: "Assistant returned an empty response." };
  }

  const record = result as Record<string, unknown>;
  if (record.status === "disabled") {
    const reason =
      record.reason === "profile-disabled" || record.reason === "api-missing"
        ? record.reason
        : "unconfigured";
    return {
      status: "disabled",
      reason,
      message:
        boundedResponseText(record.message) ??
        "Admin chat is not ready. Check the adminChat AI profile settings.",
    };
  }

  const content =
    readAssistantContent(record.message) ??
    readAssistantContent(record.reply) ??
    readAssistantContent(record.text);
  if (!content) {
    return { status: "error", message: "Assistant returned no readable message." };
  }

  const actions = normalizeAdminAssistantActions(record.actions);
  return {
    status: "ok",
    message: { role: "assistant", content },
    usage: normalizeAdminAssistantUsage(record.usage),
    ...(actions ? { actions } : {}),
  };
}

function normalizeAdminAssistantActions(
  actions: unknown,
): AdminAssistantNavigateAction[] | undefined {
  if (!Array.isArray(actions)) return undefined;

  const normalized: AdminAssistantNavigateAction[] = [];
  for (const action of actions.slice(0, ADMIN_ASSISTANT_MAX_ACTIONS)) {
    if (!action || typeof action !== "object") continue;
    const record = action as Record<string, unknown>;
    if (record.type !== "navigate") continue;
    const path = sanitizeAdminAssistantNavigationPath(record.path);
    if (!path) continue;
    const label =
      sanitizeContextText(record.label, ADMIN_ASSISTANT_MAX_ACTION_LABEL_CHARS) ??
      "Open dashboard page";
    normalized.push({ type: "navigate", path, label });
  }

  return normalized.length > 0 ? normalized : undefined;
}

function normalizeAdminAssistantUsage(
  usage: unknown,
): AdminAssistantChatUsage | null {
  if (!usage || typeof usage !== "object") return null;
  const record = usage as Record<string, unknown>;
  return {
    inputTokens: optionalBoundNumber(record.inputTokens),
    outputTokens: optionalBoundNumber(record.outputTokens),
    totalTokens: optionalBoundNumber(record.totalTokens),
  };
}

function readAssistantContent(value: unknown): string | null {
  if (typeof value === "string") return boundedResponseText(value);
  if (!value || typeof value !== "object") return null;
  const content = (value as { content?: unknown }).content;
  return typeof content === "string" ? boundedResponseText(content) : null;
}

function isAdminAssistantSurfaceKind(
  value: unknown,
): value is AdminAssistantSurfaceContext["kind"] {
  return (
    value === "dialog" ||
    value === "form" ||
    value === "panel" ||
    value === "surface" ||
    value === "table"
  );
}

function isAdminChatApiMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:404|not found|Cannot\s+(?:POST|GET)\s+\/api\/v1\/admin\/ai\/chat)/i.test(
    message,
  );
}

function isAdminChatConfigurationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:adminChat|api key|credential|disabled|unconfigured|not configured|not enabled|provider)/i.test(
    message,
  );
}

function sanitizeRoutePath(value: unknown): string {
  const raw = typeof value === "string" ? value : "";
  const pathOnly = raw.split("?")[0]?.split("#")[0] ?? "";
  const sanitized = sanitizeContextText(pathOnly, ADMIN_ASSISTANT_MAX_ROUTE_CHARS);
  return sanitized?.startsWith("/admin") ? sanitized : "/admin";
}

function sanitizeAdminAssistantNavigationPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const path = value.trim();
  if (!/^\/admin(?:\/[a-z0-9-]+)*$/.test(path)) return null;
  const segments = path.split("/").filter(Boolean);
  const resourceRoots = new Set([
    "attributes",
    "categories",
    "collections",
    "customers",
    "discounts",
    "inventory",
    "media",
    "orders",
    "pages",
    "products",
    "widgets",
  ]);
  if (segments.slice(1).some((segment) => /^\d+$/.test(segment))) return null;
  if (segments.length > 2 && resourceRoots.has(segments[1] ?? "")) return null;
  return path;
}

function sanitizeContextText(
  value: unknown,
  maxLength = ADMIN_ASSISTANT_MAX_CONTEXT_TEXT_CHARS,
): string | null {
  if (typeof value !== "string") return null;
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;

  return boundText(
    collapsed
      .replace(BEARER_PATTERN, "Bearer [redacted-token]")
      .replace(EMAIL_PATTERN, "[redacted-email]")
      .replace(BANGLADESH_PHONE_PATTERN, "$1[redacted-phone]")
      .replace(BROAD_PHONE_PATTERN, "$1[redacted-number]")
      .replace(TOKEN_PATTERN, "[redacted-token]")
      .replace(LONG_TOKEN_PATTERN, "[redacted-token]"),
    maxLength,
  );
}

function boundedResponseText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return boundText(value.trim(), 4_000) || null;
}

function boundText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength - 3).trimEnd()}...`;
}

function boundNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1_000_000, Math.round(value)));
}

function optionalBoundNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return boundNumber(value);
}
