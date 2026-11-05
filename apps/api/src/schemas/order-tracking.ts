import { z } from "@hono/zod-openapi";
import { nullableTimestampSchema } from "./timestamps";

/** One step tracker (placed, confirmed, on its way, delivered), in buyer words. */
export const buyerOrderProgressSchema = z.object({
  steps: z.array(z.object({
    key: z.enum(["placed", "confirmed", "shipped", "delivered"]),
    label: z.string(),
    done: z.boolean(),
    happenedAt: nullableTimestampSchema,
  })),
  outcome: z.object({
    key: z.string(),
    label: z.string(),
    happenedAt: nullableTimestampSchema,
  }).nullable(),
});

/** What happened to an order, newest first, in buyer words. */
export const buyerOrderTimelineSchema = z.array(z.object({
  id: z.string(),
  type: z.enum(["order", "payment", "refund", "request"]),
  status: z.string(),
  label: z.string(),
  happenedAt: nullableTimestampSchema,
  details: z.string().nullable().optional(),
}));

/** The tracked-order view: where the order is and who is delivering it. */
export const buyerOrderTrackingSchema = z.object({
  progress: buyerOrderProgressSchema,
  timeline: buyerOrderTimelineSchema,
  shipments: z.array(z.object({
    /** The shipment's state key, so a storefront words it in the page's language; `statusLabel` is the English word. */
    status: z.string().openapi({ description: "The shipment's state key (booked, in_transit, delivered and so on); a storefront words it in its page's language" }),
    statusLabel: z.string(),
    courierName: z.string().nullable(),
    trackingId: z.string().nullable(),
    trackingUrl: z.string().nullable().openapi({ description: "http(s) courier tracking link" }),
  })),
});
