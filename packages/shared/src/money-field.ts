// The unit of a money field in an operation schema, machine-readable: every
// amount an operation takes is declared with `minorMoney` or `majorMoney`,
// which put `x-scalius-money: {unit, currency}` into the generated OpenAPI
// (and the published contract adds a sentence naming the unit to the
// field's description). Agents read the unit from it (the MCP
// describe output shows it beside the type), so a model never has to guess
// whether 500 means 500.00 or 5.00.
//
// Kept free of `@hono/zod-openapi`: domain packages declare their request
// schemas with plain zod, whose `.meta()` the OpenAPI generator reads.

import type { z } from "zod";

/** The OpenAPI/JSON Schema keyword: `"x-scalius-money": {"unit": "minor", "currency": "store"}`. */
export const MONEY_FIELD_KEYWORD = "x-scalius-money";

/** `minor`: an integer count of the currency's smallest unit (paisa, cents). `major`: a decimal amount (12.50). */
export type MoneyUnit = "minor" | "major";

/**
 * Whose currency the amount is in: the store's, the market's (a market or
 * price-list price), the order's (a payment or refund of an order), or the
 * one the request or record names in its own `currency` field.
 */
export type MoneyCurrency = "store" | "market" | "order" | "named";

export interface MoneyFieldMarker {
  unit: MoneyUnit;
  currency: MoneyCurrency;
}

/** The sentence the published contract adds to a marked field's description (openapi-contract.ts). */
export const MONEY_UNIT_SENTENCE: Record<MoneyUnit, string> = {
  minor: "Integer minor units (100 = 1.00 in a two-decimal currency)",
  major: "Decimal major units (12.50 means 12.50, not minor units)",
};

/**
 * The marker on the schema itself. A schema of the OpenAPI-extended zod
 * keeps its description through `.openapi`; plain zod keeps its metadata
 * through `.meta`.
 */
function marked<T extends z.ZodType>(schema: T, marker: MoneyFieldMarker): T {
  const extended = schema as unknown as { openapi?: (metadata: Record<string, unknown>) => T };
  if (typeof extended.openapi === "function") return extended.openapi({ [MONEY_FIELD_KEYWORD]: marker });
  return schema.meta({ ...((schema.meta() ?? {}) as Record<string, unknown>), [MONEY_FIELD_KEYWORD]: marker }) as T;
}

/** An amount in integer minor units of the given currency. */
export function minorMoney<T extends z.ZodType>(schema: T, currency: MoneyCurrency = "store"): T {
  return marked(schema, { unit: "minor", currency });
}

/** An amount in decimal major units of the given currency. */
export function majorMoney<T extends z.ZodType>(schema: T, currency: MoneyCurrency = "store"): T {
  return marked(schema, { unit: "major", currency });
}

/** The marker a JSON Schema node carries, or null. */
export function moneyMarkerOf(schema: unknown): MoneyFieldMarker | null {
  if (!schema || typeof schema !== "object") return null;
  const marker = (schema as Record<string, unknown>)[MONEY_FIELD_KEYWORD];
  if (!marker || typeof marker !== "object") return null;
  const { unit, currency } = marker as Record<string, unknown>;
  if ((unit !== "minor" && unit !== "major") || (currency !== "store" && currency !== "market" && currency !== "order" && currency !== "named")) return null;
  return { unit, currency };
}
