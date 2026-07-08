import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type JsonRecord = Record<string, unknown>;

const CART_VALIDATION_MAX_ITEMS = 10;
const CART_ID_MAX_LENGTH = 180;
const CART_DISPLAY_MAX_LENGTH = 160;
const CART_MESSAGE_MAX_LENGTH = 120;
const CART_UNIT_PRICE_MAX = 10_000_000;

const CART_VALIDATION_PATH = "/api/checkout/validate-cart";

const CART_ISSUE_CODES = [
  "PRODUCT_UNAVAILABLE",
  "VARIANT_REQUIRED",
  "VARIANT_UNAVAILABLE",
  "VARIANT_MISMATCH",
  "QUANTITY_UNAVAILABLE",
  "PRICE_CHANGED",
] as const;

type CartIssueCode = typeof CART_ISSUE_CODES[number];

const CART_ISSUE_ACTIONS = [
  "remove",
  "select_variant",
  "reduce_quantity",
  "refresh_item",
] as const;

type CartIssueAction = typeof CART_ISSUE_ACTIONS[number];

const CART_ISSUE_MESSAGES: Record<CartIssueCode, string> = {
  PRODUCT_UNAVAILABLE: "This item is no longer available.",
  VARIANT_REQUIRED: "Choose an option for this item.",
  VARIANT_UNAVAILABLE: "This option is no longer available.",
  VARIANT_MISMATCH: "This option no longer matches the product.",
  QUANTITY_UNAVAILABLE: "Requested quantity is not available.",
  PRICE_CHANGED: "Unit price changed.",
};

const cartOptionSchema = z.object({
  name: z.string().trim().min(1).max(80),
  value: z.string().trim().min(1).max(120),
}).strict();

const cartValidationInputSchema = z.object({
  items: z.array(z.object({
    productId: z.string().trim().min(1).max(CART_ID_MAX_LENGTH),
    variantId: z.string().trim().min(1).max(CART_ID_MAX_LENGTH).nullable().optional(),
    slug: z.string().trim().min(1).max(CART_DISPLAY_MAX_LENGTH).optional(),
    name: z.string().trim().min(1).max(CART_DISPLAY_MAX_LENGTH).optional(),
    quantity: z.number().int().min(1).max(99),
    unitPrice: z.number().min(0).max(CART_UNIT_PRICE_MAX),
    options: z.array(cartOptionSchema).max(4).optional(),
  }).strict()).min(1).max(CART_VALIDATION_MAX_ITEMS),
}).strict();

type CartValidationInput = z.infer<typeof cartValidationInputSchema>;

const READ_ONLY_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export interface StorefrontCartValidationToolOptions {
  fetchImpl: FetchLike;
  resolveStorefrontBaseUrl: () => string;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textFallback(body: JsonRecord): string {
  return JSON.stringify(body, null, 2);
}

function toolResult(body: JsonRecord, isError = false): CallToolResult {
  return {
    structuredContent: body,
    content: [{ type: "text", text: textFallback(body) }],
    ...(isError ? { isError: true } : {}),
  };
}

function cartValidationToolError(code = "temporarily_unavailable", status?: number): CallToolResult {
  return toolResult({
    cartValidation: {
      valid: false,
      issueCount: 0,
      issues: [],
    },
    error: {
      code,
      ...(typeof status === "number" ? { status } : {}),
      message: "Storefront cart validation is temporarily unavailable.",
    },
  }, true);
}

async function parseJsonResponse(response: Response): Promise<JsonRecord | null> {
  try {
    const body = await response.json();
    return isRecord(body) ? body : { value: body };
  } catch {
    return null;
  }
}

function compactString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

function compactNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function compactInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function compactIssueCode(value: unknown): CartIssueCode | null {
  return typeof value === "string" && (CART_ISSUE_CODES as readonly string[]).includes(value)
    ? value as CartIssueCode
    : null;
}

function compactIssueAction(value: unknown): CartIssueAction | null {
  return typeof value === "string" && (CART_ISSUE_ACTIONS as readonly string[]).includes(value)
    ? value as CartIssueAction
    : null;
}

function compactIssue(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;

  const index = compactInteger(value.index);
  const productId = compactString(value.productId, CART_ID_MAX_LENGTH);
  const code = compactIssueCode(value.code);
  const action = compactIssueAction(value.action);
  const requestedQuantity = compactInteger(value.requestedQuantity);
  if (index === null || !productId || !code || !action || requestedQuantity === null) {
    return null;
  }

  const issue: JsonRecord = {
    index,
    productId,
    variantId: compactString(value.variantId, CART_ID_MAX_LENGTH),
    code,
    action,
    message: CART_ISSUE_MESSAGES[code].slice(0, CART_MESSAGE_MAX_LENGTH),
    productName: compactString(value.productName, CART_DISPLAY_MAX_LENGTH),
    variantLabel: compactString(value.variantLabel, CART_DISPLAY_MAX_LENGTH),
    requestedQuantity,
  };

  const availableQuantity = compactNumber(value.availableQuantity);
  if (availableQuantity !== null) issue.availableQuantity = availableQuantity;

  const submittedPrice = compactNumber(value.submittedPrice);
  if (submittedPrice !== null) issue.submittedPrice = submittedPrice;

  const currentPrice = compactNumber(value.currentPrice);
  if (currentPrice !== null) issue.currentPrice = currentPrice;

  return issue;
}

function compactValidatedItem(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;

  const index = compactInteger(value.index);
  const productId = compactString(value.productId, CART_ID_MAX_LENGTH);
  const quantity = compactInteger(value.quantity);
  const unitPrice = compactNumber(value.unitPrice);
  if (index === null || !productId || quantity === null || unitPrice === null) {
    return null;
  }

  const item: JsonRecord = {
    index,
    productId,
    variantId: compactString(value.variantId, CART_ID_MAX_LENGTH),
    quantity,
    unitPrice,
    productName: compactString(value.productName, CART_DISPLAY_MAX_LENGTH),
    variantLabel: compactString(value.variantLabel, CART_DISPLAY_MAX_LENGTH),
  };

  const availableQuantity = compactNumber(value.availableQuantity);
  if (availableQuantity !== null) item.availableQuantity = availableQuantity;

  return item;
}

function compactCartValidationData(data: JsonRecord): JsonRecord {
  const issues = Array.isArray(data.issues)
    ? data.issues.map(compactIssue).filter((issue): issue is JsonRecord => issue !== null).slice(0, CART_VALIDATION_MAX_ITEMS)
    : [];
  const items = Array.isArray(data.items)
    ? data.items.map(compactValidatedItem).filter((item): item is JsonRecord => item !== null).slice(0, CART_VALIDATION_MAX_ITEMS)
    : [];
  const subtotal = compactNumber(data.subtotal);

  return {
    cartValidation: {
      valid: data.valid === true && issues.length === 0,
      issueCount: issues.length,
      issues,
      items,
      ...(subtotal !== null ? { subtotal } : {}),
    },
  };
}

function normalizeVariantId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed !== "default" ? trimmed : null;
}

function compactOptionLabel(options: CartValidationInput["items"][number]["options"]): string | null {
  if (!options || options.length === 0) return null;
  return options
    .map((option) => `${option.name}: ${option.value}`)
    .join(" / ")
    .slice(0, CART_DISPLAY_MAX_LENGTH);
}

function buildValidationRequestBody(items: CartValidationInput["items"]): JsonRecord {
  return {
    items: items.map((item) => ({
      productId: item.productId,
      variantId: normalizeVariantId(item.variantId),
      quantity: item.quantity,
      price: item.unitPrice,
      productName: item.name ?? item.slug ?? null,
      variantLabel: compactOptionLabel(item.options),
    })),
  };
}

async function callStorefrontCartValidation(
  items: CartValidationInput["items"],
  {
    fetchImpl,
    resolveStorefrontBaseUrl,
    signal,
  }: StorefrontCartValidationToolOptions & { signal?: AbortSignal },
): Promise<CallToolResult> {
  let url: URL;
  try {
    url = new URL(CART_VALIDATION_PATH, `${resolveStorefrontBaseUrl()}/`);
  } catch {
    return cartValidationToolError("upstream_config_invalid");
  }

  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildValidationRequestBody(items)),
      signal,
    });
    const body = await parseJsonResponse(response);
    if (!body || !response.ok || body.success !== true || !isRecord(body.data)) {
      return cartValidationToolError("validation_unavailable", response.status);
    }

    return toolResult(compactCartValidationData(body.data));
  } catch {
    return cartValidationToolError();
  }
}

export function registerStorefrontCartValidationTool(
  server: McpServer,
  options: StorefrontCartValidationToolOptions,
): void {
  server.registerTool(
    "cart_validate",
    {
      title: "Cart Validate",
      description: "Validates a public storefront cart snapshot against current product availability and prices.",
      inputSchema: cartValidationInputSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ items }, extra) => callStorefrontCartValidation(items, {
      ...options,
      signal: extra.signal,
    }),
  );
}
