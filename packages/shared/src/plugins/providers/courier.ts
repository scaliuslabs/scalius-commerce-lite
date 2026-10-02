// The courier port. A courier books a parcel for an order, reports where it
// is, and (optionally) quotes, cancels, finds a booking by the order number,
// pushes tracking through a webhook and reconciles cash on delivery.
//
// The platform inserts the local shipment row (status `creating`) before it
// calls `createShipment`, and passes that row's id as `idempotencyKey`: a
// retry after a lost answer reuses it, and a booking the courier made but
// never confirmed is found again with `findShipment` instead of booking
// twice. A call that may have reached the courier but gave no answer raises
// `ProviderError("retryable", …, { uncertain: true })`.

import { z } from "zod";
import {
  providerCountrySchema,
  providerCurrencySchema,
  providerHttpRequestSchema,
  providerIdempotencyKeySchema,
  providerMinorSchema,
  providerReasonSchema,
  providerRefSchema,
} from "./common";

/** The normalized shipment states every courier maps its own statuses to. */
export const COURIER_SHIPMENT_STATUSES = [
  "pending",
  "pickup_assigned",
  "picked_up",
  "pickup_failed",
  "in_transit",
  "out_for_delivery",
  "delivered",
  "partial_delivered",
  "delivery_failed",
  "on_hold",
  "failed",
  "cancelled",
  "returned",
  "unknown",
] as const;
export const courierShipmentStatusSchema = z.enum(COURIER_SHIPMENT_STATUSES);
export type CourierShipmentStatus = z.infer<typeof courierShipmentStatusSchema>;

const text = (max: number) => z.string().max(max);

/** Where the parcel goes. Location ids are the store's delivery locations; names are for couriers that take text. */
export const courierRecipientSchema = z.object({
  name: text(200),
  phone: text(40),
  address: text(2000),
  cityId: text(128).nullable(),
  zoneId: text(128).nullable(),
  areaId: text(128).nullable(),
  cityName: text(200).nullable(),
  zoneName: text(200).nullable(),
  areaName: text(200).nullable(),
  postalCode: text(40).nullable(),
  country: providerCountrySchema.nullable(),
}).strict();
export type CourierRecipient = z.infer<typeof courierRecipientSchema>;

export const courierShipmentInputSchema = z.object({
  /** The local shipment id: stable across retries of this booking. */
  idempotencyKey: providerIdempotencyKeySchema,
  /** The order number the courier records (its "merchant order id" or invoice). */
  orderId: providerRefSchema,
  recipient: courierRecipientSchema,
  /** Cash the courier collects on delivery, in minor units of `currency` (0 for prepaid). */
  codAmountMinor: providerMinorSchema,
  currency: providerCurrencySchema,
  /** The currency's decimal places, for couriers that take major units. */
  decimalPlaces: z.number().int().min(0).max(4),
  note: text(1000).nullable(),
  itemCount: z.number().int().min(1).max(10_000).nullable(),
  itemDescription: text(500).nullable(),
  /** Staff choices on the booking form; each courier reads the ones it understands. */
  options: z.object({
    deliveryType: z.number().int().min(0).max(1000).nullable(),
    itemType: z.number().int().min(0).max(1000).nullable(),
    itemWeightKg: z.number().min(0).max(1000).nullable(),
  }).strict(),
}).strict();
export type CourierShipmentInput = z.infer<typeof courierShipmentInputSchema>;

/** A booking as the courier confirmed it. */
export const courierShipmentSchema = z.object({
  /** The courier's booking id (consignment id): what tracking asks about. */
  externalId: providerRefSchema,
  /** What the buyer tracks with, when it differs from `externalId`. */
  trackingId: providerRefSchema.nullable(),
  status: courierShipmentStatusSchema,
  /** The courier's own status text, kept for staff. */
  rawStatus: text(100),
  /** The delivery charge the courier quoted for this booking, in minor units of the order currency. */
  chargeMinor: providerMinorSchema.nullable(),
  /** A printable label: a URL the courier hosts, or a PDF the platform stores privately. */
  label: z.union([
    z.object({ url: z.string().url().max(2048).refine((value) => value.startsWith("https://"), "Use an https URL.") }).strict(),
    z.object({ pdfBase64: z.string().min(8).max(1_400_000).regex(/^[A-Za-z0-9+/]+={0,2}$/) }).strict(),
  ]).nullable(),
}).strict();
export type CourierShipment = z.infer<typeof courierShipmentSchema>;

export const courierTrackInputSchema = z.object({ externalId: providerRefSchema }).strict();
export type CourierTrackInput = z.infer<typeof courierTrackInputSchema>;

export const courierTrackingSchema = z.object({
  status: courierShipmentStatusSchema,
  rawStatus: text(100),
  /** When the courier recorded this state (ISO 8601). */
  updatedAt: z.string().datetime({ offset: true }),
}).strict();
export type CourierTracking = z.infer<typeof courierTrackingSchema>;

export const courierFindInputSchema = z.object({ orderId: providerRefSchema }).strict();
/** Positive-only: `found: false` never means "not booked", only "not confirmed". */
export const courierFindSchema = z.discriminatedUnion("found", [
  z.object({ found: z.literal(true), externalId: providerRefSchema.nullable(), tracking: courierTrackingSchema }).strict(),
  z.object({ found: z.literal(false), message: providerReasonSchema }).strict(),
]);
export type CourierFind = z.infer<typeof courierFindSchema>;

export const courierCancelInputSchema = z.object({
  externalId: providerRefSchema,
  idempotencyKey: providerIdempotencyKeySchema,
  reason: text(300).nullable(),
}).strict();
export const courierCancelSchema = z.object({ cancelled: z.boolean(), message: text(300) }).strict();

export const courierQuoteInputSchema = courierShipmentInputSchema.omit({ idempotencyKey: true, orderId: true }).strict();
export const courierQuoteSchema = z.object({
  amountMinor: providerMinorSchema,
  currency: providerCurrencySchema,
  estimatedDays: z.number().int().min(0).max(365).nullable(),
}).strict();

/** An authenticated tracking push, or why nothing applies. */
export const courierWebhookSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("update"), externalId: providerRefSchema, tracking: courierTrackingSchema }).strict(),
  z.object({ status: z.literal("ignored"), reason: providerReasonSchema }).strict(),
  z.object({ status: z.literal("invalid"), reason: providerReasonSchema }).strict(),
]);
export type CourierWebhook = z.infer<typeof courierWebhookSchema>;

export const courierCodInputSchema = z.object({
  externalId: providerRefSchema,
  /** What the order expected the courier to collect. */
  expectedMinor: providerMinorSchema,
  currency: providerCurrencySchema,
}).strict();
/** What the courier says it collected and paid out for one parcel. */
export const courierCodSchema = z.object({
  collectedMinor: providerMinorSchema,
  remittedMinor: providerMinorSchema,
  currency: providerCurrencySchema,
  status: z.enum(["pending", "collected", "remitted", "disputed"]),
}).strict();

export const COURIER_PORT = {
  createShipment: { input: courierShipmentInputSchema, output: courierShipmentSchema },
  trackShipment: { input: courierTrackInputSchema, output: courierTrackingSchema },
  findShipment: { input: courierFindInputSchema, output: courierFindSchema },
  cancelShipment: { input: courierCancelInputSchema, output: courierCancelSchema },
  quote: { input: courierQuoteInputSchema, output: courierQuoteSchema },
  verifyWebhook: { input: providerHttpRequestSchema, output: courierWebhookSchema },
  reconcileCod: { input: courierCodInputSchema, output: courierCodSchema },
} as const;
