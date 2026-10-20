// The courier-history port: what courier networks know about a buyer's phone
// (parcels booked, delivered and cancelled, per network). It is the
// merchant's tool on the order page (advice, never automatic blocking); an
// app that must stop fulfilment for review handles `order.created` and calls
// `ctx.orders.hold` instead. A general order-risk port (an order in, a score
// and recommendation out) is not this port: it is planned as a separate beta
// `risk` port, and `ctx.orders.assessRisk` covers app risk until then.

import { z } from "zod";
import { providerRefSchema } from "./common";

export const COURIER_HISTORY_RISK_LEVELS = ["low", "medium", "high", "unknown"] as const;

export const courierHistoryInputSchema = z.object({
  /** E.164 (`+8801XXXXXXXXX`). */
  phone: z.string().min(4).max(20),
  orderId: providerRefSchema.optional(),
}).strict();
export type CourierHistoryInput = z.infer<typeof courierHistoryInputSchema>;

const count = z.number().int().min(0);
const rate = z.number().min(0).max(100);

/** Parcels one courier network reports for the phone. */
export const courierHistoryNetworkSchema = z.object({ totalParcels: count, delivered: count, cancelled: count }).strict();

/** What a lookup found. Counts are parcels across the courier networks the provider sees. */
export const courierHistorySchema = z.object({
  /** The provider's reading of the history. */
  riskLevel: z.enum(COURIER_HISTORY_RISK_LEVELS),
  /** The phone as the provider looked it up. */
  phone: z.string().max(20),
  totalParcels: count,
  delivered: count,
  cancelled: count,
  successRate: rate.optional(),
  cancelRate: rate.optional(),
  /** The provider's customer tag ("returning", "risky"), in its own words. */
  customerTag: z.string().max(80).optional(),
  providerStatus: z.string().max(80).optional(),
  /** The provider's own note for the merchant. */
  message: z.string().max(500).optional(),
  /** Per courier network, keyed by its name. */
  couriers: z.record(z.string().max(64), courierHistoryNetworkSchema).optional(),
}).strict();
export type CourierHistory = z.infer<typeof courierHistorySchema>;

export const COURIER_HISTORY_PORT = {
  check: { input: courierHistoryInputSchema, output: courierHistorySchema },
} as const;
