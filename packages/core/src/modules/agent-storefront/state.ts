import { ConflictError, ValidationError } from "@scalius/core/errors";
import { DELIVERY_HIERARCHY_COUNTRY } from "@scalius/shared/markets";

export const AGENT_STOREFRONT_MAX_CART_LINES = 99;
export const AGENT_STOREFRONT_MAX_LINE_QUANTITY = 99;

export interface AgentStorefrontCartLine {
  variantId: string;
  quantity: number;
}

/**
 * Where the context's order is delivered, as far as shipping zones and the
 * delivery rate look at it (MARKETS-DESIGN step 3b): a country (null:
 * Bangladesh), Bangladesh's City/Thana/Area ids, or another country's admin
 * area and postal code. The street lines come with the checkout submit.
 */
export interface AgentStorefrontDeliverySelection {
  countryCode?: string | null;
  cityId: string | null;
  zoneId: string | null;
  areaId: string | null;
  adminArea?: string | null;
  postalCode?: string | null;
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

function normalizeOptionalText(value: string | null | undefined, max: number, label: string): string | null {
  if (value == null || value.trim() === "") return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length > max) throw new ValidationError(`${label} must be at most ${max} characters.`);
  return text;
}

/** An ISO country other than Bangladesh, or null (Bangladesh, the default). */
function normalizeDestinationCountry(value: string | null | undefined): string | null {
  if (value == null || value.trim() === "") return null;
  const code = value.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) throw new ValidationError("Use a two-letter ISO country code, such as BD or US.");
  return code === DELIVERY_HIERARCHY_COUNTRY ? null : code;
}

export function normalizeAgentStorefrontDeliverySelection(
  value: AgentStorefrontDeliverySelection,
): Required<AgentStorefrontDeliverySelection> {
  const countryCode = normalizeDestinationCountry(value.countryCode);
  const selection = {
    countryCode,
    cityId: normalizeOptionalId(value.cityId),
    zoneId: normalizeOptionalId(value.zoneId),
    areaId: normalizeOptionalId(value.areaId),
    adminArea: normalizeOptionalText(value.adminArea, 120, "The region"),
    postalCode: normalizeOptionalText(value.postalCode, 20, "The postal code"),
    shippingMethodId: normalizeOptionalId(value.shippingMethodId),
  };
  if (countryCode && (selection.cityId || selection.zoneId || selection.areaId)) {
    throw new ValidationError("City, thana and area are Bangladesh's delivery places. Send the region and postal code for another country.");
  }
  if (!countryCode && (selection.adminArea || selection.postalCode)) {
    throw new ValidationError("A Bangladesh address takes a city, thana and area. Send countryCode for another country.");
  }
  if (!selection.cityId && (selection.zoneId || selection.areaId)) {
    throw new ValidationError("Select a city before selecting a zone or area.");
  }
  if (!selection.zoneId && selection.areaId) {
    throw new ValidationError("Select a zone before selecting an area.");
  }
  // A method alone is valid: a pickup rate needs no address. The delivery
  // preflight refuses a delivery rate without its city and zone.
  if (selection.shippingMethodId && selection.cityId && !selection.zoneId) {
    throw new ValidationError("Select a zone for this city, or clear the city to collect at a pickup point.");
  }
  return selection;
}
