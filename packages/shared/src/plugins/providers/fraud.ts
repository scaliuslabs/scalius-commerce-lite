// The fraud port: a courier-history or risk lookup for a buyer's phone. It
// is the merchant's tool on the order page (advice, never automatic
// blocking); an app that must stop fulfilment for review handles
// `order.created` and calls `ctx.orders.hold` instead.

import { z } from "zod";
import { providerRefSchema } from "./common";

export const FRAUD_RISK_LEVELS = ["low", "medium", "high", "unknown"] as const;

export const fraudCheckInputSchema = z.object({
  /** E.164 (`+8801XXXXXXXXX`). */
  phone: z.string().min(4).max(20),
  orderId: providerRefSchema.optional(),
}).strict();
export type FraudCheckInput = z.infer<typeof fraudCheckInputSchema>;

const count = z.number().int().min(0);
const rate = z.number().min(0).max(100);

/** Parcels one courier network reports for the phone. */
export const fraudCourierStatsSchema = z.object({ totalParcels: count, delivered: count, cancelled: count }).strict();

/** What a lookup found. Counts are parcels across the courier networks the provider sees. */
export const fraudCheckSchema = z.object({
  riskLevel: z.enum(FRAUD_RISK_LEVELS),
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
  couriers: z.record(z.string().max(64), fraudCourierStatsSchema).optional(),
}).strict();
export type FraudCheck = z.infer<typeof fraudCheckSchema>;

export const FRAUD_PORT = {
  check: { input: fraudCheckInputSchema, output: fraudCheckSchema },
} as const;
