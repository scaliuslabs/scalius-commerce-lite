// Wave A order-line contract shared by the storefront, buyer and dashboard
// order routes: line fulfilment types, buyer inputs (line-item properties),
// pickup snapshots and the fulfilment ledger projection.
import { z } from "@hono/zod-openapi";
import {
  DELIVERY_METHOD_KINDS,
  FULFILLMENT_KINDS,
  FULFILLMENT_RECORD_STATUSES,
  FULFILLMENT_TYPES,
} from "@scalius/shared/fulfilment";
import {
  CUSTOMIZATION_FIELD_TYPES,
  LINE_PROPERTY_INPUT_LIMITS,
} from "@scalius/shared/line-properties";
import { nullableTimestampSchema } from "./timestamps";

export const fulfillmentKindSchema = z.enum(FULFILLMENT_KINDS).openapi({
  description: "What the SKU is: `physical` (shipped or picked up), `digital`, or `service` (performed, nothing delivered).",
});

export const fulfillmentTypeSchema = z.enum(FULFILLMENT_TYPES).openapi({
  description: "How the order line reaches the buyer, frozen when the order is placed.",
});

export const deliveryMethodKindSchema = z.enum(DELIVERY_METHOD_KINDS).openapi({
  description: "`delivery` ships to the buyer's address; `pickup` is collected at the store.",
});

/** One buyer input sent with a cart line. Buyer content: sent in the body only, never in a URL. */
export const linePropertyInputSchema = z.object({
  key: z.string().min(1).max(40),
  value: z.string().max(LINE_PROPERTY_INPUT_LIMITS.valueLength),
});

export const linePropertiesInputSchema = z
  .array(linePropertyInputSchema)
  .max(LINE_PROPERTY_INPUT_LIMITS.entries)
  .optional()
  .openapi({
    description: "Buyer inputs the product asks for (engraving text, gift wrap, a fit choice). A ticked checkbox sends \"true\"; empty optional fields are omitted. Same SKU with different inputs is a different line.",
  });

/** A resolved buyer input as priced and frozen on the order line. */
export const orderLinePropertySchema = z.object({
  key: z.string(),
  type: z.enum(CUSTOMIZATION_FIELD_TYPES),
  label: z.string(),
  value: z.string(),
  /** What to print after the label: the choice label for selects, "Yes" for ticked boxes. */
  displayValue: z.string(),
  /** Surcharge this input adds to one unit, in major units. */
  price: z.number(),
  priceMinor: z.number().int(),
});

/** Buyer-input fields every order line projection carries. */
export const orderLineFulfilmentShape = {
  fulfillmentType: fulfillmentTypeSchema,
  /** Units handed over so far (sent, picked up, performed or delivered digitally). */
  fulfilledQuantity: z.number().int(),
  properties: z.array(orderLinePropertySchema),
  /** Sum of the surcharges included in the unit price, in major units. */
  propertiesPrice: z.number(),
  propertiesPriceMinor: z.number().int(),
  /** Unit price before surcharges; null only for lines placed before Wave A. */
  baseUnitPriceMinor: z.number().int().nullable(),
};

export const orderPickupSchema = z.object({
  address: z.string().nullable(),
  hours: z.string().nullable(),
  /** When staff marked the order ready to collect; null until then. */
  readyAt: z.string().nullable(),
});

export const orderFulfilmentLineSchema = z.object({
  orderItemId: z.string(),
  quantity: z.number().int().positive(),
});

export const orderFulfilmentTrackingSchema = z.object({
  shipmentId: z.string(),
  courierName: z.string().nullable(),
  trackingId: z.string().nullable(),
  trackingUrl: z.string().nullable(),
  status: z.string(),
});

/** One handed-over action as the buyer sees it (active fulfilments only). */
export const buyerOrderFulfilmentSchema = z.object({
  id: z.string(),
  kind: fulfillmentTypeSchema,
  createdAt: z.string().nullable(),
  lines: z.array(orderFulfilmentLineSchema),
  tracking: orderFulfilmentTrackingSchema.nullable(),
});

/** One ledger fulfilment as staff see it, including voided ones. */
export const adminOrderFulfilmentSchema = buyerOrderFulfilmentSchema.extend({
  status: z.enum(FULFILLMENT_RECORD_STATUSES),
  actorType: z.enum(["admin", "system"]),
  /** Cash taken at the pickup counter or the service in the same action, in major units. */
  cashCollected: z.number().nullable(),
  voidedAt: nullableTimestampSchema,
  /**
   * Void is allowed now: an active own-rider parcel, pickup or service
   * fulfilment of an order still confirmed. Courier-booked parcels follow the
   * courier's status (webhooks), so they are never voided here.
   */
  canVoid: z.boolean(),
  voidBlockedReason: z.enum(["voided", "courier", "delivered", "order_not_confirmed"]).nullable(),
});

/** Order-level fields every order projection carries after Wave A. */
export const orderFulfilmentShape = {
  /** Some line ships, so the order has a delivery address. */
  requiresShipping: z.boolean(),
  /** The one delivery method of the order; null when nothing physical was bought. */
  shippingMethodKind: deliveryMethodKindSchema.nullable(),
  pickup: orderPickupSchema.nullable(),
};

/** Order-level fields the dashboard list and detail both carry. */
export const orderFulfilmentListShape = {
  requiresShipping: z.boolean().openapi({ description: "Some line ships, so the order has a delivery address." }),
  shippingMethodKind: deliveryMethodKindSchema.nullable().openapi({
    description: "The order's one delivery method; null when nothing physical was bought (service or digital only).",
  }),
  /** When staff marked a pickup order ready to collect. */
  pickupReadyAt: nullableTimestampSchema,
};

/** A product's buyer inputs, as the product page and the editor render them. */
export const customizationViewSchema = z.object({
  fields: z.array(z.object({
    key: z.string(),
    label: z.string(),
    type: z.enum(CUSTOMIZATION_FIELD_TYPES),
    required: z.boolean(),
    help: z.string().nullable(),
    /** text/textarea only; null otherwise. */
    maxLength: z.number().int().nullable(),
    /** text/textarea/checkbox surcharge per unit, in major units; 0 for selects. */
    price: z.number(),
    priceMinor: z.number().int(),
    /** select choices, each with its own surcharge; empty for other types. */
    options: z.array(z.object({
      value: z.string(),
      label: z.string(),
      price: z.number(),
      priceMinor: z.number().int(),
    })),
  })),
}).openapi({ description: "Buyer inputs asked on the product page, in schema order." });

export const allowedPaymentMethodsSchema = z.array(z.string()).openapi({
  description: "Payment methods this cart may use. Cash on delivery is offered only when something is shipped, collected or performed.",
});
