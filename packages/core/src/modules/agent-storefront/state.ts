import { ConflictError, ValidationError } from "@scalius/core/errors";

export const AGENT_STOREFRONT_MAX_CART_LINES = 99;
export const AGENT_STOREFRONT_MAX_LINE_QUANTITY = 99;

export interface AgentStorefrontCartLine {
  variantId: string;
  quantity: number;
}

export interface AgentStorefrontDeliverySelection {
  cityId: string | null;
  zoneId: string | null;
  areaId: string | null;
  shippingMethodId: string | null;
}

function normalizeVariantId(value: unknown): string {
  if (typeof value !== "string") {
    throw new ValidationError("A saved product variant is required.");
  }
  const variantId = value.trim();
  if (!variantId || variantId.length > 180 || variantId === "default") {
    throw new ValidationError("A saved product variant is required.");
  }
  return variantId;
}

function normalizeQuantity(value: unknown): number {
  if (
    typeof value !== "number"
    || !Number.isInteger(value)
    || value < 1
    || value > AGENT_STOREFRONT_MAX_LINE_QUANTITY
  ) {
    throw new ValidationError(
      `Quantity must be a whole number from 1 to ${AGENT_STOREFRONT_MAX_LINE_QUANTITY}.`,
    );
  }
  return value;
}

export function parseAgentStorefrontCartJson(value: string): AgentStorefrontCartLine[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ConflictError("This storefront context has invalid cart state. Close it and start a new context.");
  }
  if (!Array.isArray(parsed) || parsed.length > AGENT_STOREFRONT_MAX_CART_LINES) {
    throw new ConflictError("This storefront context has invalid cart state. Close it and start a new context.");
  }

  const lines: AgentStorefrontCartLine[] = [];
  const variantIds = new Set<string>();
  try {
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") throw new Error("invalid line");
      const row = entry as Record<string, unknown>;
      const variantId = normalizeVariantId(row.variantId);
      const quantity = normalizeQuantity(row.quantity);
      if (variantIds.has(variantId)) throw new Error("duplicate variant");
      variantIds.add(variantId);
      lines.push({ variantId, quantity });
    }
  } catch {
    throw new ConflictError("This storefront context has invalid cart state. Close it and start a new context.");
  }
  return lines;
}

export function serializeAgentStorefrontCart(lines: readonly AgentStorefrontCartLine[]): string {
  if (lines.length > AGENT_STOREFRONT_MAX_CART_LINES) {
    throw new ValidationError(
      `A storefront cart supports at most ${AGENT_STOREFRONT_MAX_CART_LINES} distinct items.`,
    );
  }
  const variantIds = new Set<string>();
  return JSON.stringify(lines.map((line) => {
    const variantId = normalizeVariantId(line.variantId);
    if (variantIds.has(variantId)) {
      throw new ValidationError("Each saved product variant can appear only once in the cart.");
    }
    variantIds.add(variantId);
    return {
      variantId,
      quantity: normalizeQuantity(line.quantity),
    };
  }));
}

export function addAgentStorefrontCartLine(
  lines: readonly AgentStorefrontCartLine[],
  input: AgentStorefrontCartLine,
): AgentStorefrontCartLine[] {
  const variantId = normalizeVariantId(input.variantId);
  const quantity = normalizeQuantity(input.quantity);
  const existing = lines.find((line) => line.variantId === variantId);
  if (existing) {
    const nextQuantity = existing.quantity + quantity;
    if (nextQuantity > AGENT_STOREFRONT_MAX_LINE_QUANTITY) {
      throw new ValidationError(
        `Quantity must not exceed ${AGENT_STOREFRONT_MAX_LINE_QUANTITY}.`,
      );
    }
    return lines.map((line) => line.variantId === variantId
      ? { variantId, quantity: nextQuantity }
      : { ...line });
  }
  if (lines.length >= AGENT_STOREFRONT_MAX_CART_LINES) {
    throw new ValidationError(
      `A storefront cart supports at most ${AGENT_STOREFRONT_MAX_CART_LINES} distinct items.`,
    );
  }
  return [...lines.map((line) => ({ ...line })), { variantId, quantity }];
}

export function setAgentStorefrontCartLineQuantity(
  lines: readonly AgentStorefrontCartLine[],
  variantIdInput: string,
  quantityInput: number,
): AgentStorefrontCartLine[] {
  const variantId = normalizeVariantId(variantIdInput);
  const quantity = normalizeQuantity(quantityInput);
  if (!lines.some((line) => line.variantId === variantId)) {
    throw new ValidationError("This variant is not in the storefront cart.");
  }
  return lines.map((line) => line.variantId === variantId
    ? { variantId, quantity }
    : { ...line });
}

export function removeAgentStorefrontCartLine(
  lines: readonly AgentStorefrontCartLine[],
  variantIdInput: string,
): AgentStorefrontCartLine[] {
  const variantId = normalizeVariantId(variantIdInput);
  if (!lines.some((line) => line.variantId === variantId)) {
    throw new ValidationError("This variant is not in the storefront cart.");
  }
  return lines
    .filter((line) => line.variantId !== variantId)
    .map((line) => ({ ...line }));
}

export function normalizeAgentStorefrontDiscountCode(value: string): string {
  const code = value.trim().toUpperCase();
  if (!code || code.length > 100) {
    throw new ValidationError("Enter a discount code with at most 100 characters.");
  }
  return code;
}

function normalizeOptionalId(value: string | null | undefined): string | null {
  if (value == null || value.trim() === "") return null;
  const id = value.trim();
  if (id.length > 180) throw new ValidationError("Delivery identifiers must be at most 180 characters.");
  return id;
}

export function normalizeAgentStorefrontDeliverySelection(
  value: AgentStorefrontDeliverySelection,
): AgentStorefrontDeliverySelection {
  const selection = {
    cityId: normalizeOptionalId(value.cityId),
    zoneId: normalizeOptionalId(value.zoneId),
    areaId: normalizeOptionalId(value.areaId),
    shippingMethodId: normalizeOptionalId(value.shippingMethodId),
  };
  if (!selection.cityId && (selection.zoneId || selection.areaId)) {
    throw new ValidationError("Select a city before selecting a zone or area.");
  }
  if (!selection.zoneId && selection.areaId) {
    throw new ValidationError("Select a zone before selecting an area.");
  }
  if (selection.shippingMethodId && (!selection.cityId || !selection.zoneId)) {
    throw new ValidationError("Select a city and zone before selecting a shipping method.");
  }
  return selection;
}
