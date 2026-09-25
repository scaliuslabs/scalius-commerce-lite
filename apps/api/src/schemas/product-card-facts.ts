// What a product card can say beyond title, price and photo
// (catalog/card-facts.ts), shared by every route that returns listing or
// homepage cards. Every fact is stored data; a missing fact is null or empty.
import { z } from "@hono/zod-openapi";

export const productCardFactsSchema = z.object({
  brand: z.object({ name: z.string(), slug: z.string() }).nullable().openapi({
    description: "The published brand entity.",
  }),
  keySpecs: z.array(z.string()).max(4).openapi({
    description: "Up to four \"Name: value\" lines from key-spec attributes, in spec-table order.",
  }),
  options: z.array(z.object({
    name: z.string().openapi({ description: "The merchant's option axis name." }),
    kind: z.enum(["color", "size", "other"]),
    count: z.number().int().min(2).openapi({ description: "Values sold on at least one live SKU." }),
    swatches: z.array(z.object({
      label: z.string(),
      hex: z.string().nullable().openapi({ description: "`#rrggbb` when a swatch attribute value of the same name has one." }),
    })).max(5),
  })).openapi({ description: "Option axes with two or more values, in position order." }),
  soldLast30Days: z.number().int().min(10).nullable().openapi({
    description: "Units sold in the last 30 days from real orders; null below 10.",
  }),
  packSize: z.string().nullable(),
  delivery: z.union([
    z.object({ free: z.literal(true) }),
    z.object({ free: z.literal(false), feeFrom: z.number().positive() }),
  ]).nullable().openapi({
    description: "Free when the product ships free, else the cheapest active delivery rate; null without a rate.",
  }),
}).openapi("ProductCardFacts");

/** Listing and homepage cards carry their facts; other product reads leave them out. */
export const optionalProductCardFacts = productCardFactsSchema.optional();
