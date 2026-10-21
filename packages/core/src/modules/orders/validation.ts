// src/modules/orders/validation.ts
// Zod schemas for order create/update operations.
// Imported by admin API routes and OrderService.

import { isSalesChannelId, SALES_CHANNEL_ID_MAX_LENGTH } from "@scalius/shared/sales-channels";
import { PURCHASE_OPTION_ID_MAX_LENGTH, PURCHASE_OPTION_ID_PATTERN } from "@scalius/shared/plugins/ids";
import { z } from "zod";
import { phoneNumberSchema } from "@scalius/shared/customer-utils";
import { LINE_PROPERTY_INPUT_LIMITS } from "@scalius/shared/line-properties";
import { ORDER_CHANNEL_SOURCE_MAX_LENGTH } from "@scalius/shared/order-channel";
import { normalizeOrderChannelSource } from "@scalius/shared/order-channel-source";
import { ADDRESS_FIELD_MAX_LENGTH, usesDeliveryHierarchy } from "@scalius/shared/address";
import { MAX_LINE_QUANTITY, MAX_ORDER_LINES } from "@scalius/shared/order-limits";
import { MAX_MINOR_AMOUNT } from "@scalius/shared/money";
import { RECORDED_PAYMENT_VIAS } from "@scalius/shared/payment-terms";
import { PAYMENT_TERMS_MAX_DAYS } from "@scalius/shared/payment-terms";

/** The one order line limit (`@scalius/shared/order-limits`). */
export const MAX_ORDER_LINE_ITEMS = MAX_ORDER_LINES;

const addressText = (max: number) => z.string().trim().max(max).nullable().optional();

/**
 * Bangladesh's delivery line keeps its 10-character minimum (its City/Thana
 * form's rule); another country's first line follows that country's rules.
 * Applied to the final schemas, which are not extended further.
 */
export function refineDeliveryLine(
    value: { shippingCountryCode?: string | null; shippingAddress?: string | null },
    context: z.RefinementCtx,
): void {
    const line = value.shippingAddress;
    if (line && line.length < 10 && usesDeliveryHierarchy(value.shippingCountryCode)) {
        context.addIssue({ code: "custom", path: ["shippingAddress"], message: "Address must be at least 10 characters" });
    }
}

const orderBaseContentSchema = z.object({
    customerName: z
        .string()
        .min(3, "Customer name must be at least 3 characters")
        .max(100, "Customer name must be less than 100 characters"),
    customerPhone: phoneNumberSchema,
    customerEmail: z.email().nullable(),
    /**
     * The shipping address (MARKETS-DESIGN D7), required only when something
     * ships (a physical line with a delivery method); pickup, service-only
     * and digital orders carry none. `shippingCountryCode` absent means
     * Bangladesh, whose City/Thana/Area ids (`city`, `zone`, `area`) stand in
     * for the locality; another country sends what its rules require.
     */
    shippingCountryCode: z.string().trim().min(2).max(2).nullable().optional(),
    /** The first street line. */
    shippingAddress: z
        .string()
        .max(500, "Address must be less than 500 characters")
        .nullable()
        .optional(),
    shippingAddressLine2: addressText(ADDRESS_FIELD_MAX_LENGTH.line2),
    shippingDependentLocality: addressText(ADDRESS_FIELD_MAX_LENGTH.dependentLocality),
    shippingLocality: addressText(ADDRESS_FIELD_MAX_LENGTH.locality),
    shippingAdminArea: addressText(ADDRESS_FIELD_MAX_LENGTH.adminArea),
    shippingPostalCode: addressText(ADDRESS_FIELD_MAX_LENGTH.postalCode),
    shippingCompany: addressText(ADDRESS_FIELD_MAX_LENGTH.company),
    /** Staff only: keep an address that breaks its country's rules (stored marked). */
    skipAddressValidation: z.boolean().optional(),
    /**
     * The billing address (migration 0119). An order that ships uses its
     * shipping address unless `billingSameAsShipping` is false. Otherwise
     * optional: a billing country taxes and places an order that ships
     * nothing; without a street line only the country, region and postal
     * code are kept (checked as its rules require).
     */
    billingSameAsShipping: z.boolean().nullable().optional(),
    billingCountryCode: z.string().trim().min(2).max(2).nullable().optional(),
    billingName: addressText(ADDRESS_FIELD_MAX_LENGTH.name),
    billingCompany: addressText(ADDRESS_FIELD_MAX_LENGTH.company),
    billingAddress: addressText(ADDRESS_FIELD_MAX_LENGTH.line1),
    billingAddressLine2: addressText(ADDRESS_FIELD_MAX_LENGTH.line2),
    billingDependentLocality: addressText(ADDRESS_FIELD_MAX_LENGTH.dependentLocality),
    billingLocality: addressText(ADDRESS_FIELD_MAX_LENGTH.locality),
    billingAdminArea: addressText(ADDRESS_FIELD_MAX_LENGTH.adminArea),
    billingPostalCode: addressText(ADDRESS_FIELD_MAX_LENGTH.postalCode),
    city: z.string().min(1, "City is required").nullable().optional(),
    zone: z.string().min(1, "Zone is required").nullable().optional(),
    area: z.string().nullable().optional(),
    cityName: z.string().optional(),
    zoneName: z.string().optional(),
    areaName: z.string().nullable().optional(),
    notes: z
        .string()
        .max(500, "Notes must be less than 500 characters")
        .nullable(),
    discountAmount: z
        .number()
        .min(0, "Discount must be greater than or equal to 0")
        .nullable(),
    shippingCharge: z
        .number()
        .min(0, "Shipping charge must be greater than or equal to 0"),
});

/** Buyer inputs for one line, as the storefront sends them (line-item properties). */
export const orderLinePropertiesInputSchema = z.array(z.object({
    key: z.string().min(1).max(40),
    value: z.string().max(LINE_PROPERTY_INPUT_LIMITS.valueLength),
})).max(LINE_PROPERTY_INPUT_LIMITS.entries);

const sellableOrderItemSchema = z.object({
    productId: z.string().min(1, "Product is required"),
    variantId: z.string().nullable(),
    quantity: z
        .number()
        .int("Quantity must be a whole number")
        .min(1, "Quantity must be at least 1")
        .max(MAX_LINE_QUANTITY, `Quantity must be at most ${MAX_LINE_QUANTITY}`),
    /** Buyer inputs the product asks for; priced from its schema. */
    properties: orderLinePropertiesInputSchema.optional(),
    /**
     * Staff or an app sets the unit price by hand (a quote, a renewal at its
     * agreed price): it replaces the catalogue price, in minor units of the
     * store currency at its price increment, and the order's timeline
     * records it (`prices_set`). Buyer-input surcharges still apply.
     */
    unitPriceMinor: z.number().int().min(0).max(MAX_MINOR_AMOUNT).optional(),
    /**
     * An installed app's purchase option for the line (`<app id>.<key>`, a
     * subscription renewal); frozen on the line as `_purchase_option`. The
     * app prices it; one no active app offers is refused.
     */
    purchaseOption: z.string().max(PURCHASE_OPTION_ID_MAX_LENGTH).regex(PURCHASE_OPTION_ID_PATTERN, "Use a purchase option id: <app id>.<key>.").nullable().optional(),
});

const sellableOrderContentSchema = orderBaseContentSchema.extend({
    items: z
        .array(sellableOrderItemSchema)
        .min(1, "Add at least one sellable item")
        .max(MAX_ORDER_LINE_ITEMS, `Add at most ${MAX_ORDER_LINE_ITEMS} sellable items`),
});

/**
 * Where a staff-created order came in (COMMERCE-HOOKS H2): a preset
 * (`facebook`, `instagram`, `whatsapp`, `phone`, `walk_in`) or the merchant's
 * own words, stored as the slug `normalizeOrderChannelSource` makes of them.
 * Empty means none; text with nothing readable in it is refused.
 */
const orderChannelSourceInputSchema = z
    .string()
    .max(ORDER_CHANNEL_SOURCE_MAX_LENGTH, `Source must be at most ${ORDER_CHANNEL_SOURCE_MAX_LENGTH} characters`)
    .refine(
        (value) => value.trim() === "" || normalizeOrderChannelSource(value) !== null,
        "Source needs letters or numbers",
    )
    .nullable()
    .optional()
    .describe("Where the order came in: facebook, instagram, whatsapp, phone, walk_in, or free text (stored as a lowercase slug of at most 64 characters).");

/**
 * A new order's fields without the Bangladesh line rule, for a route that
 * extends them (and applies `refineDeliveryLine` again): zod refuses to
 * extend a refined object.
 */
/** How a staff or app order is paid: cash on delivery, or an invoice paid later by its due date. */
export const manualOrderPaymentMethodSchema = z.enum(["cod", "net_terms"]);

export const createOrderObjectSchema = sellableOrderContentSchema.extend({
    requestKey: z.uuid("A valid manual-order request key is required"),
    /**
     * The delivery method picked: a pickup method needs no address, a
     * delivery method needs one. Required when a line is physical. The charge
     * may still be edited.
     */
    shippingMethodId: z.string().trim().min(1).max(180).nullable().optional(),
    channelSource: orderChannelSourceInputSchema,
    /**
     * The sales channel the order sells from (MARKETS-DESIGN D6): an active
     * channel; omitted, the online store. Staff may sell any product.
     */
    salesChannelId: z.string().max(SALES_CHANNEL_ID_MAX_LENGTH).refine(isSalesChannelId, "Use a sales channel id.").nullable().optional(),
    /** File the order under this customer instead of the guest record of its phone. */
    customerId: z.string().trim().min(1).max(128).nullable().optional(),
    /** Validated app checkout attributes (the route checks them against the apps' declarations). */
    attributes: z.record(z.string(), z.string()).optional(),
    /** Who placed it: staff ("admin", the default) or an app ("app"). */
    channel: z.enum(["admin", "app"]).optional(),
    /** Cash on delivery (the default), or an invoice paid later (`net_terms`). */
    paymentMethod: manualOrderPaymentMethodSchema.optional(),
    /** An invoice's terms in days; omitted: the store's net days (Settings → Payments). */
    paymentTermsDays: z.number().int().min(1).max(PAYMENT_TERMS_MAX_DAYS).optional(),
    /**
     * Mark as paid: the whole amount was already received (cash at the
     * counter, a bank transfer, a mobile wallet). The order is placed as an
     * invoice and the payment is recorded right after, so it is paid and its
     * downloads and gift cards are handed over.
     */
    paid: z.object({
        via: z.enum(RECORDED_PAYMENT_VIAS),
        reference: z.string().trim().max(120).nullable().optional(),
    }).strict().optional(),
});

/** Schema for creating a new order (POST /api/orders). */
export const createOrderSchema = createOrderObjectSchema.superRefine(refineDeliveryLine);

export type CreateOrderInput = z.infer<typeof createOrderSchema>;

/**
 * Read-only authoritative preview used by the manual-order form. Contact facts
 * are intentionally excluded: tax and money depend only on the sellable lines,
 * destination, shipping, and order-level discount.
 */
export const quoteManualOrderSchema = sellableOrderContentSchema.pick({
    shippingCountryCode: true,
    city: true,
    zone: true,
    area: true,
    // Shipping zones outside Bangladesh match on them (apps' delivery options).
    shippingAdminArea: true,
    shippingPostalCode: true,
    // An order that ships nothing is taxed at its billing address.
    billingCountryCode: true,
    billingAdminArea: true,
    billingPostalCode: true,
    items: true,
    discountAmount: true,
    shippingCharge: true,
}).extend({
    /** Decides pickup vs delivery (and so whether the address is taxed). */
    shippingMethodId: z.string().trim().min(1).max(180).nullable().optional(),
    /** Cash on delivery (the default) must collect the total exactly; an invoice need not. */
    paymentMethod: manualOrderPaymentMethodSchema.optional(),
});

export type QuoteManualOrderInput = z.infer<typeof quoteManualOrderSchema>;

const amendableOrderItemSchema = sellableOrderItemSchema.extend({
    orderItemId: z.string().min(1).optional(),
});

export const previewManualOrderAmendmentSchema = orderBaseContentSchema.extend({
    expectedVersion: z.number().int().min(1),
    /**
     * Kept lines (with `orderItemId`) keep their frozen buyer inputs; new lines
     * may send `properties`.
     */
    items: z.array(amendableOrderItemSchema)
        .min(1, "Add at least one sellable item")
        .max(MAX_ORDER_LINE_ITEMS, `Add at most ${MAX_ORDER_LINE_ITEMS} sellable items`),
});

/** The confirmed amendment's fields without the Bangladesh line rule (see `createOrderObjectSchema`). */
export const confirmManualOrderAmendmentObjectSchema = previewManualOrderAmendmentSchema.extend({
    requestKey: z.uuid("A valid amendment request key is required"),
    quoteFingerprint: z.string().regex(
        /^[a-f0-9]{64}$/,
        "A valid amendment quote fingerprint is required",
    ),
});

export const confirmManualOrderAmendmentSchema = confirmManualOrderAmendmentObjectSchema.superRefine(refineDeliveryLine);

export type PreviewManualOrderAmendmentInput = z.infer<typeof previewManualOrderAmendmentSchema>;
export type ConfirmManualOrderAmendmentInput = z.infer<typeof confirmManualOrderAmendmentSchema>;

/** Customer and delivery details of an order that has not shipped yet. */
export const updateOrderDetailsSchema = orderBaseContentSchema.pick({
    customerName: true,
    customerPhone: true,
    customerEmail: true,
    shippingCountryCode: true,
    shippingAddress: true,
    shippingAddressLine2: true,
    shippingDependentLocality: true,
    shippingLocality: true,
    shippingAdminArea: true,
    shippingPostalCode: true,
    shippingCompany: true,
    skipAddressValidation: true,
    city: true,
    zone: true,
    area: true,
    billingSameAsShipping: true,
    billingCountryCode: true,
    billingName: true,
    billingCompany: true,
    billingAddress: true,
    billingAddressLine2: true,
    billingDependentLocality: true,
    billingLocality: true,
    billingAdminArea: true,
    billingPostalCode: true,
}).extend({
    expectedVersion: z.number().int().min(1),
}).superRefine(refineDeliveryLine);

export type UpdateOrderDetailsInput = z.infer<typeof updateOrderDetailsSchema>;

const orderRevisionSchema = z.object({
    id: z.string().min(1, "Order is required"),
    expectedVersion: z
        .number()
        .int("Order version must be a whole number")
        .min(1, "Order version is required"),
});

/**
 * Archive is an organizational visibility change, not a commerce-state
 * mutation. Requiring every browser-loaded revision prevents a stale list from
 * hiding an order that changed while the merchant was reviewing it.
 */
export const archiveOrdersSchema = z.object({
    orders: z
        .array(orderRevisionSchema)
        .min(1, "Select at least one order")
        .max(90, "Archive at most 90 orders at a time")
        .superRefine((entries, ctx) => {
            const seen = new Set<string>();
            entries.forEach((entry, index) => {
                if (seen.has(entry.id)) {
                    ctx.addIssue({
                        code: "custom",
                        message: "Each order can appear only once",
                        path: [index, "id"],
                    });
                }
                seen.add(entry.id);
            });
        }),
});

export type ArchiveOrdersInput = z.infer<typeof archiveOrdersSchema>;

export const restoreOrderSchema = orderRevisionSchema.pick({ expectedVersion: true });

const shipmentResourceIdSchema = z.string().trim().min(1).max(180);

/**
 * Provider shipment inputs that a merchant may choose. Money, line count, and
 * item description are deliberately absent: those facts are derived from the
 * current order immediately before the provider call.
 */
export const shipmentCreationOptionsSchema = z.object({
    deliveryType: z.number().int().min(0).max(1_000_000).optional(),
    itemType: z.number().int().min(0).max(1_000_000).optional(),
    itemWeight: z.number().finite().positive().max(10_000).optional(),
    note: z.string().trim().max(500).optional(),
}).strict();

export type ShipmentCreationOptionsInput = z.infer<typeof shipmentCreationOptionsSchema>;

const unknownShipmentResolutionBase = z.object({
    expectedOrderVersion: z.number().int().min(1),
    operationKey: z.string().uuid(),
    evidenceSource: z.enum(["courier_portal", "courier_support"]),
    evidenceNote: z.string().trim().min(8).max(500),
    confirmationAccepted: z.literal(true),
});

export const unknownShipmentResolutionSchema = z.discriminatedUnion("outcome", [
    unknownShipmentResolutionBase.extend({
        outcome: z.literal("confirmed_existing"),
        externalId: z.string().trim().min(1).max(180),
        trackingId: z.string().trim().min(1).max(180).optional(),
    }).strict(),
    unknownShipmentResolutionBase.extend({
        outcome: z.enum(["confirmed_not_created", "confirmed_cancelled"]),
    }).strict(),
]);

export type UnknownShipmentResolutionInput = z.infer<typeof unknownShipmentResolutionSchema>;

export const bulkShipOrderSchema = z.object({
    orderIds: z
        .array(shipmentResourceIdSchema)
        .min(1, "Select at least one order")
        .max(90, "Ship at most 90 orders at a time")
        .superRefine((orderIds, ctx) => {
            const seen = new Set<string>();
            orderIds.forEach((orderId, index) => {
                if (seen.has(orderId)) {
                    ctx.addIssue({
                        code: "custom",
                        message: "Each order can appear only once",
                        path: [index],
                    });
                }
                seen.add(orderId);
            });
        }),
    providerId: shipmentResourceIdSchema,
    options: shipmentCreationOptionsSchema.optional(),
}).strict();
