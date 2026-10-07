// Price lists on the wire (docs/MARKETS-DESIGN.md D5): the dashboard's price
// list record and its SKU price grid. Amounts are decimal major units of the
// list's currency, converted once at this edge.
import { z } from "@hono/zod-openapi";
import { getDecimalPlaces } from "@scalius/shared/currency";
import {
  MAX_PRICE_LIST_QUANTITY_BREAKS,
  PRICE_LIST_DESCRIPTION_MAX_LENGTH,
  PRICE_LIST_MIN_QUANTITY_MAX,
  PRICE_LIST_NAME_MAX_LENGTH,
  PRICE_LIST_PRIORITY_MAX,
} from "@scalius/shared/market-pricing";
import { fromMinor } from "@scalius/shared/money";
import { PRICE_LIST_WRITE_MAX_VARIANTS, type PriceListRecord, type PriceListVariantPrices } from "@scalius/core/modules/price-lists";

const kindSchema = z.enum(["market", "segment", "sale"]).openapi({
  description: "`market`: a market's own prices. `segment`: prices for the members of one customer segment (signed-in checkout only). `sale`: a scheduled sale in a market; it wins over the others.",
});

export const priceListSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  kind: kindSchema,
  marketId: z.string(),
  marketName: z.string(),
  marketIsBackup: z.boolean(),
  segmentId: z.string().nullable(),
  segmentName: z.string().nullable(),
  status: z.enum(["draft", "active"]),
  state: z.enum(["draft", "scheduled", "active", "expired"]).openapi({ description: "What the list does now: its status read with its schedule." }),
  startsAt: z.string().nullable().openapi({ format: "date-time" }),
  endsAt: z.string().nullable().openapi({ format: "date-time" }),
  priority: z.number().int().min(0).max(PRICE_LIST_PRIORITY_MAX),
  revision: z.number().int().positive(),
  priceCount: z.number().int().min(0),
  variantCount: z.number().int().min(0),
  currencyCode: z.string(),
  priceIncrement: z.number().openapi({ description: "Every price is a multiple of this (major units)." }),
  createdAt: z.string().openapi({ format: "date-time" }),
  updatedAt: z.string().openapi({ format: "date-time" }),
}).openapi("PriceList");

export function presentPriceList(record: PriceListRecord) {
  const { priceIncrementMinor, startsAt, endsAt, createdAt, updatedAt, ...rest } = record;
  return {
    ...rest,
    priceIncrement: fromMinor(priceIncrementMinor, getDecimalPlaces(record.currencyCode)),
    startsAt: startsAt?.toISOString() ?? null,
    endsAt: endsAt?.toISOString() ?? null,
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
  };
}

const scheduleFields = {
  startsAt: z.string().datetime({ offset: true }).nullable().optional().openapi({ description: "When it starts pricing (inclusive); null: now." }),
  endsAt: z.string().datetime({ offset: true }).nullable().optional().openapi({ description: "When it stops (exclusive); null: no end." }),
};

export const createPriceListSchema = z.object({
  name: z.string().trim().min(1).max(PRICE_LIST_NAME_MAX_LENGTH),
  description: z.string().trim().max(PRICE_LIST_DESCRIPTION_MAX_LENGTH).nullable().optional(),
  kind: kindSchema,
  marketId: z.string().min(1).max(64),
  segmentId: z.string().min(1).max(64).nullable().optional().openapi({ description: "Segment lists only." }),
  status: z.enum(["draft", "active"]).default("draft"),
  priority: z.number().int().min(0).max(PRICE_LIST_PRIORITY_MAX).optional(),
  ...scheduleFields,
}).strict();

export const updatePriceListSchema = z.object({
  expectedRevision: z.number().int().positive(),
  name: z.string().trim().min(1).max(PRICE_LIST_NAME_MAX_LENGTH).optional(),
  description: z.string().trim().max(PRICE_LIST_DESCRIPTION_MAX_LENGTH).nullable().optional(),
  kind: kindSchema.optional(),
  marketId: z.string().min(1).max(64).optional(),
  segmentId: z.string().min(1).max(64).nullable().optional(),
  status: z.enum(["draft", "active"]).optional(),
  priority: z.number().int().min(0).max(PRICE_LIST_PRIORITY_MAX).optional(),
  ...scheduleFields,
}).strict();

/** A schedule instant from the wire: undefined keeps, null clears. */
export function scheduleInstant(value: string | null | undefined): Date | null | undefined {
  return value === undefined ? undefined : value === null ? null : new Date(value);
}

const tierSchema = z.object({
  amount: z.number().positive().openapi({ description: "The price of one unit (major units, at the price increment)." }),
  compareAt: z.number().positive().nullable().optional().openapi({ description: "The struck-through price, above the amount; null for none." }),
  minQuantity: z.number().int().min(1).max(PRICE_LIST_MIN_QUANTITY_MAX).default(1).openapi({ description: "1 is the list's price; a larger value is a quantity break from that many units." }),
});

export const setPriceListPricesSchema = z.object({
  expectedRevision: z.number().int().positive(),
  set: z.array(z.object({
    variantId: z.string().min(1).max(180),
    prices: z.array(tierSchema).min(1).max(MAX_PRICE_LIST_QUANTITY_BREAKS),
  })).max(PRICE_LIST_WRITE_MAX_VARIANTS).default([]).openapi({ description: "Each SKU's whole set of prices (it replaces what the SKU had in the list)." }),
  remove: z.array(z.string().min(1).max(180)).max(PRICE_LIST_WRITE_MAX_VARIANTS).default([]).openapi({ description: "SKUs to take out of the list." }),
}).strict();

export const priceListVariantSchema = z.object({
  variantId: z.string(),
  productId: z.string(),
  productName: z.string(),
  variantLabel: z.string().nullable(),
  sku: z.string(),
  basePrice: z.number().openapi({ description: "The SKU's own product price (shop currency)." }),
  prices: z.array(z.object({
    currencyCode: z.string(),
    amount: z.number(),
    compareAt: z.number().nullable(),
    minQuantity: z.number().int(),
  })),
}).openapi("PriceListVariant");

export function presentPriceListVariant(variant: PriceListVariantPrices, currencyCode: string) {
  const { basePriceMinor, prices, ...rest } = variant;
  const places = getDecimalPlaces(currencyCode);
  return {
    ...rest,
    basePrice: fromMinor(basePriceMinor, places),
    prices: prices.map((price) => ({
      currencyCode: price.currencyCode,
      amount: fromMinor(price.amountMinor, getDecimalPlaces(price.currencyCode)),
      compareAt: price.compareAtMinor === null ? null : fromMinor(price.compareAtMinor, getDecimalPlaces(price.currencyCode)),
      minQuantity: price.minQuantity,
    })),
  };
}
