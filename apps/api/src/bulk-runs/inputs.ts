// The reviewed request of each bulk run kind (operation-registry README,
// "Bulk runs"). A run stores exactly this validated request as its input:
// selections are ids or a list filter, never arbitrary payloads, and money is
// integer minor units of the store currency.
import { z } from "@hono/zod-openapi";
import { CUSTOMER_TAGS_PER_REQUEST_MAX } from "@scalius/shared/customer-marketing";
import { PUBLICATION_BULK_MAX_CHANNELS } from "@scalius/shared/sales-channels";
import { salesChannelIdSchema } from "../schemas/sales-channels";

/** Most items one run may hold. */
export const BULK_RUN_MAX_ITEMS = 5_000;
/** Runs this size or smaller finish inside their request. */
export const BULK_SYNC_MAX_ITEMS = 250;
/** Items one chunk commits in one batch (D1's bound parameters and statement budget). */
export const BULK_CHUNK_ITEMS = 90;
/** Rows a dry run or a run keeps as its before/after sample, and as its failures. */
export const BULK_SAMPLE_MAX = 50;

const id = z.string().trim().min(1).max(180);
const dryRun = z.boolean().optional().openapi({
  description: "true checks and previews everything (before/after for the first 50 items, totals) and writes nothing.",
});

/** The product list's filter (as the dashboard's "select all matching"). */
export const bulkProductFilterSchema = z.object({
  search: z.string().trim().min(1).max(120).optional().openapi({ description: "Product name or SKU words." }),
  category: z.string().min(1).max(180).optional().openapi({ description: "Products directly in this category id." }),
  status: z.enum(["active", "draft"]).optional(),
  salesChannel: salesChannelIdSchema.optional().openapi({ description: "Products published to this sales channel." }),
}).strict().refine((filter) => Object.keys(filter).length > 0, "Give at least one filter, or list ids.");

export const bulkSetPricesSchema = z.object({
  variants: z.array(z.object({
    id,
    expectedPriceMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional()
      .openapi({ description: "The price you read; a SKU whose price changed since is left alone (a failure)." }),
  })).min(1).max(BULK_RUN_MAX_ITEMS).optional().openapi({ description: "SKUs by id (send this or filter)." }),
  filter: bulkProductFilterSchema.optional().openapi({ description: "Every live SKU of the products this filter matches (send this or variants)." }),
  change: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("set"), amountMinor: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) })
      .openapi({ description: "Set every price to this amount (on the store's price increment)." }),
    z.object({ mode: z.literal("percent"), percent: z.number().min(-90).max(1_000).multipleOf(0.01) })
      .openapi({ description: "Change every price by this percent (5 raises 5%, -10 lowers 10%), rounded half up to the price increment." }),
    z.object({ mode: z.literal("amount"), amountMinor: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).refine((value) => value !== 0, "Change the price.") })
      .openapi({ description: "Add (or, negative, take off) this many minor units, rounded to the price increment." }),
  ]),
  dryRun,
}).refine((input) => (input.variants === undefined) !== (input.filter === undefined), "Send variants or filter, not both.");

export const bulkSetStockSchema = z.object({
  locationId: z.string().trim().min(1).max(100).optional().openapi({ description: "The location counted (the default location when omitted)." }),
  items: z.array(z.object({
    variantId: id,
    quantity: z.number().int().min(0).max(1_000_000_000).openapi({ description: "Units on hand at the location after the run (not a change)." }),
    expectedStockVersion: z.number().int().min(0).optional()
      .openapi({ description: "The SKU's stockVersion you read; a SKU whose stock changed since is left alone (a failure)." }),
  })).min(1).max(BULK_RUN_MAX_ITEMS),
  reason: z.string().trim().min(1).max(200).optional().openapi({ description: "Shown on each stock movement (default: Bulk stock count)." }),
  dryRun,
}).refine((input) => new Set(input.items.map((item) => item.variantId)).size === input.items.length, "Each SKU appears once.");

export const bulkTagCustomersSchema = z.object({
  customerIds: z.array(id).min(1).max(BULK_RUN_MAX_ITEMS).optional().openapi({ description: "Customers by id (send this or filter)." }),
  filter: z.object({
    tag: z.string().trim().min(1).max(40).optional().openapi({ description: "Customers who carry this tag." }),
    minOrders: z.number().int().min(0).max(1_000_000).optional()
      .openapi({ description: "Customers with at least this many orders ('more than 3 orders' is 4)." }),
    maxOrders: z.number().int().min(0).max(1_000_000).optional().openapi({ description: "Customers with at most this many orders." }),
  }).strict().refine((filter) => Object.keys(filter).length > 0, "Give at least one filter, or list ids.")
    .optional().openapi({ description: "Every live customer the filter matches (send this or customerIds)." }),
  add: z.array(z.string().trim().min(1).max(40)).min(1).max(CUSTOMER_TAGS_PER_REQUEST_MAX).optional(),
  remove: z.array(z.string().trim().min(1).max(40)).min(1).max(CUSTOMER_TAGS_PER_REQUEST_MAX).optional(),
  dryRun,
}).refine((input) => (input.customerIds === undefined) !== (input.filter === undefined), "Send customerIds or filter, not both.")
  .refine((input) => input.add !== undefined || input.remove !== undefined, "Add or remove at least one tag.");

export const bulkSetProductStatusSchema = z.object({
  products: z.array(z.object({
    id,
    expectedAggregateRevision: z.number().int().min(1).optional()
      .openapi({ description: "The product revision you read; a product changed since is left alone (a failure)." }),
  })).min(1).max(BULK_RUN_MAX_ITEMS).optional().openapi({ description: "Products by id (send this or filter)." }),
  filter: bulkProductFilterSchema.optional(),
  status: z.enum(["active", "draft"]).openapi({ description: "active sells the product; draft hides it. Activating skips a product without a price above 0." }),
  dryRun,
}).refine((input) => (input.products === undefined) !== (input.filter === undefined), "Send products or filter, not both.");

export const bulkPublishProductsSchema = z.object({
  productIds: z.array(id).min(1).max(BULK_RUN_MAX_ITEMS).optional().openapi({ description: "Products by id (send this or filter)." }),
  filter: bulkProductFilterSchema.optional(),
  channelIds: z.array(salesChannelIdSchema).min(1).max(PUBLICATION_BULK_MAX_CHANNELS),
  action: z.enum(["publish", "unpublish"]),
  dryRun,
}).refine((input) => (input.productIds === undefined) !== (input.filter === undefined), "Send productIds or filter, not both.");

export type BulkProductFilter = z.infer<typeof bulkProductFilterSchema>;
export type BulkSetPricesInput = z.infer<typeof bulkSetPricesSchema>;
export type BulkSetStockInput = z.infer<typeof bulkSetStockSchema>;
export type BulkTagCustomersInput = z.infer<typeof bulkTagCustomersSchema>;
export type BulkSetProductStatusInput = z.infer<typeof bulkSetProductStatusSchema>;
export type BulkPublishProductsInput = z.infer<typeof bulkPublishProductsSchema>;

export type BulkRunInput =
  | { kind: "variants.set_prices"; input: BulkSetPricesInput }
  | { kind: "variants.set_stock"; input: BulkSetStockInput }
  | { kind: "customers.tag"; input: BulkTagCustomersInput }
  | { kind: "products.set_status"; input: BulkSetProductStatusInput }
  | { kind: "products.publish"; input: BulkPublishProductsInput };
