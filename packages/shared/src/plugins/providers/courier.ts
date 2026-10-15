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
//
// A courier that books by its own location ids (Pathao's city, zone and
// area) declares `locations` in its manifest entry: the platform reads those
// ids from the store's places (`externalIds.<key>`), refuses a booking that
// lacks a required one before anything is written, and passes them as
// `recipient.locationIds`.

import { z } from "zod";
import {
  providerCountrySchema,
  providerCurrencySchema,
  providerDetailsSchema,
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
  /**
   * The courier's own ids of the recipient's city, zone and area, read from
   * the store's places (`externalIds.<key>` of the courier's declared
   * `locations`). Present only for a courier that declares `locations`.
   */
  locationIds: z.object({
    city: text(128).nullable(),
    zone: text(128).nullable(),
    area: text(128).nullable(),
  }).strict().optional(),
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
  itemCount: z.number().int().min(1).max(1_000_000).nullable(),
  itemDescription: text(500).nullable(),
  /** Staff choices on the booking form (within its bounds); each courier reads the ones it understands. */
  options: z.object({
    deliveryType: z.number().int().min(0).max(1_000_000).nullable(),
    itemType: z.number().int().min(0).max(1_000_000).nullable(),
    itemWeightKg: z.number().min(0).max(10_000).nullable(),
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
  /** The courier's own booking facts kept with the shipment for staff (fee, invoice): never contact data or secrets. */
  details: providerDetailsSchema.optional(),
}).strict();
export type CourierShipment = z.infer<typeof courierShipmentSchema>;

export const courierTrackInputSchema = z.object({ externalId: providerRefSchema }).strict();
export type CourierTrackInput = z.infer<typeof courierTrackInputSchema>;

export const courierTrackingSchema = z.object({
  status: courierShipmentStatusSchema,
  rawStatus: text(100),
  /** When the courier recorded this state (ISO 8601). */
  updatedAt: z.string().datetime({ offset: true }),
  /** The courier's own tracking facts kept with the shipment for staff: never contact data or secrets. */
  details: providerDetailsSchema.optional(),
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

const HEADER_NAME = /^[a-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
/** Headers a courier's answer may carry (an integration secret it echoes): never cookies, a redirect or the content type. */
const REPLY_HEADER = z.string().regex(HEADER_NAME).refine(
  (name) => !/^(?:set-cookie|location|refresh|content-type|content-length|cache-control|content-security-policy|access-control-.*|transfer-encoding|connection)$/i.test(name),
  "The platform sets this header.",
);
type ReplyJson = string | number | boolean | null | ReplyJson[] | { [key: string]: ReplyJson };
const replyJson: z.ZodType<ReplyJson> = z.lazy(() => z.union([
  z.string().max(500),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(replyJson).max(20),
  z.record(z.string().max(64), replyJson),
]));

/**
 * The answer the courier expects (some check the status, a header or the
 * body). The platform sends it for a push it accepted, applied or not; it
 * stays JSON, uncached and without cookies. Absent: `200 { received: true }`.
 */
export const courierWebhookReplySchema = z.object({
  status: z.number().int().min(200).max(299),
  headers: z.record(REPLY_HEADER, z.string().max(1024)).refine((headers) => Object.keys(headers).length <= 8, "At most 8 headers.").optional(),
  body: z.record(z.string().max(64), replyJson).optional(),
}).strict();
export type CourierWebhookReply = z.infer<typeof courierWebhookReplySchema>;

/**
 * An authenticated tracking push, or why nothing applies. The platform
 * applies a push once: by the courier's own `eventId` when it sends one, else
 * by the shipment, state and time the push reports.
 *
 * - `update`: a new state of the shipment `externalId`. With `orderId` (the
 *   order number the courier echoes), the platform refuses a push whose order
 *   differs from the shipment's, and binds the booking id to a shipment of
 *   that order whose booking the courier confirmed by lookup
 *   (`findShipment`) but whose id it never learned.
 * - `note`: facts about the shipment (a tracking message) without a state change.
 * - `ignored`: authentic but not about a shipment (an integration check).
 * - `invalid`: not authentic (401), or authentic but malformed when it
 *   carries `rejectStatus` (a 4xx the courier expects).
 */
export const courierWebhookSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("update"),
    eventId: providerRefSchema.optional(),
    externalId: providerRefSchema,
    orderId: providerRefSchema.optional(),
    tracking: courierTrackingSchema,
    reply: courierWebhookReplySchema.optional(),
  }).strict(),
  z.object({
    status: z.literal("note"),
    eventId: providerRefSchema,
    externalId: providerRefSchema,
    orderId: providerRefSchema.optional(),
    /** Merged into the shipment's details: never contact data or secrets. */
    details: providerDetailsSchema,
    reply: courierWebhookReplySchema.optional(),
  }).strict(),
  z.object({ status: z.literal("ignored"), reason: providerReasonSchema, reply: courierWebhookReplySchema.optional() }).strict(),
  z.object({
    status: z.literal("invalid"),
    reason: providerReasonSchema,
    /** A malformed push from an authenticated sender: the 4xx it gets instead of 401. */
    rejectStatus: z.number().int().min(400).max(499).optional(),
  }).strict(),
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

/** Checkout rates disclose parcel and region facts only, never buyer contact or street data. */
export const courierRatesInputSchema = z.object({
  destination: z.object({
    country: providerCountrySchema,
    adminArea: text(128).nullable(),
    city: text(200).nullable(),
    postalCode: text(40).nullable(),
    placeIds: z.object({ city: text(128).nullable(), zone: text(128).nullable(), area: text(128).nullable() }).strict().optional(),
  }).strict(),
  origin: z.object({ locationId: text(128), country: providerCountrySchema, postalCode: text(40).nullable() }).strict().nullable(),
  parcel: z.object({
    lines: z.array(z.object({
      variantId: text(128), quantity: z.number().int().min(1).max(1_000_000),
      weightGrams: z.number().min(0).max(10_000_000).nullable(), unitPriceMinor: providerMinorSchema,
    }).strict()).max(100),
    weightGrams: z.number().min(0).max(1_000_000_000).nullable(),
  }).strict(),
  currency: providerCurrencySchema,
  decimalPlaces: z.number().int().min(0).max(4),
  cod: z.boolean(),
}).strict();
export type CourierRatesInput = z.infer<typeof courierRatesInputSchema>;
export const courierRatesSchema = z.object({
  rates: z.array(z.object({
    service: text(128).min(1), name: text(200).min(1), amountMinor: providerMinorSchema,
    estimatedDays: z.object({ min: z.number().int().min(0).max(365), max: z.number().int().min(0).max(365) }).strict()
      .refine((days) => days.max >= days.min).nullable(),
  }).strict()).max(10),
}).strict();
export type CourierRates = z.infer<typeof courierRatesSchema>;

export const COURIER_PORT = {
  rates: { input: courierRatesInputSchema, output: courierRatesSchema },
  createShipment: { input: courierShipmentInputSchema, output: courierShipmentSchema },
  trackShipment: { input: courierTrackInputSchema, output: courierTrackingSchema },
  findShipment: { input: courierFindInputSchema, output: courierFindSchema },
  cancelShipment: { input: courierCancelInputSchema, output: courierCancelSchema },
  quote: { input: courierQuoteInputSchema, output: courierQuoteSchema },
  verifyWebhook: { input: providerHttpRequestSchema, output: courierWebhookSchema },
  reconcileCod: { input: courierCodInputSchema, output: courierCodSchema },
} as const;
