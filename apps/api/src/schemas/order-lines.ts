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
import { BUYER_UPLOAD_TYPES } from "@scalius/shared/buyer-uploads";
import { CART_LINE_INPUT_LIMITS, LINE_ADD_ONS_MAX } from "@scalius/shared/line-identity";
import { ADD_ON_DETAILS_MAX, ADD_ON_ROWS_MAX, ADD_ON_TITLE_MAX } from "@scalius/shared/add-on-totals";
import {
  CUSTOMIZATION_FIELD_TYPES,
  LINE_INPUT_FIELD_TYPES,
  LINE_INPUT_SURFACES,
  LINE_PROPERTY_INPUT_LIMITS,
  LINE_PROPERTY_REVISION_PATTERN,
  LINE_PURCHASE_OPTIONS_MAX,
} from "@scalius/shared/line-properties";
import { APP_SCOPED_KEY_MAX_LENGTH, PURCHASE_OPTION_ID_MAX_LENGTH, PURCHASE_OPTION_ID_PATTERN } from "@scalius/shared/plugins/ids";
import { nullableTimestampSchema } from "./timestamps";
import { appOwnedField } from "./protected";
import { buyerText } from "@scalius/shared/buyer-text";

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
  key: z.string().min(1).max(APP_SCOPED_KEY_MAX_LENGTH).openapi({ description: "The product's own input key, or an app's line input as `<app id>.<key>` (manifest `checkout.lineInputs`)." }),
  value: z.string().max(LINE_PROPERTY_INPUT_LIMITS.valueLength),
  revision: z.string().regex(LINE_PROPERTY_REVISION_PATTERN).optional().openapi({ description: "The revision of the words the buyer answered (the drawn input's `textRevision`), for an app input whose words the merchant writes. Not part of the line's identity; frozen on the order line beside the answer." }),
});

export const linePropertiesInputSchema = z
  .array(linePropertyInputSchema)
  .max(LINE_PROPERTY_INPUT_LIMITS.entries)
  .optional()
  .openapi({
    description: "Buyer inputs the line carries: the product's own (engraving text, gift wrap, a fit choice) and the active apps' line inputs under `<app id>.<key>` (a gift message, a protection plan). A ticked checkbox sends \"true\"; empty optional fields are omitted. Same SKU with different inputs is a different line.",
  });

/**
 * A cart's buyer inputs together stay within CART_LINE_INPUT_LIMITS: add it
 * to every request that carries cart lines with `properties`
 * (`z.array(line).superRefine(cartInputBudget)`).
 */
export function cartInputBudget(
  lines: ReadonlyArray<{ properties?: ReadonlyArray<{ value: string }> | null }>,
  context: z.RefinementCtx,
): void {
  let entries = 0;
  let characters = 0;
  for (const line of lines) {
    for (const property of line.properties ?? []) {
      entries += 1;
      characters += property.value.length;
    }
  }
  if (entries > CART_LINE_INPUT_LIMITS.entries || characters > CART_LINE_INPUT_LIMITS.valueCharacters) {
    context.addIssue({
      code: "custom",
      message: `A cart takes at most ${CART_LINE_INPUT_LIMITS.entries} answers and ${CART_LINE_INPUT_LIMITS.valueCharacters} characters of answers together.`,
    });
  }
}

/** The purchase options a cart line is bought with (active apps' `checkout.purchaseOptions`, one per app). */
export const linePurchaseOptionsInputSchema = z
  .array(z.string().max(PURCHASE_OPTION_ID_MAX_LENGTH).regex(PURCHASE_OPTION_ID_PATTERN, "Use a purchase option id: <app id>.<key>."))
  .max(LINE_PURCHASE_OPTIONS_MAX)
  .optional()
  .openapi({
    description: "Installed apps' purchase options for the line (`<app id>.<key>`: a subscription, another app's protection plan), at most one per app; absent or empty: a one-time purchase. Part of the line's identity: the same SKU with other options is another line. An option no active app offers, or two of one app, is refused (`purchase_option_unavailable`).",
  });

/** The purchase options a validated line carries, with the titles the buyer sees. */
export const linePurchaseOptionsSchema = z.array(z.object({
  id: z.string(),
  title: z.string(),
})).openapi({ description: "The line's purchase options, sorted by id (absent: a one-time purchase). The apps that offer them price them." });

/** An add-on's detail lines: plain text an app wrote, never HTML. */
/** An add-on's detail lines on one line or one buyer row (at most ADD_ON_DETAILS_MAX). */
const addOnDetailsSchema = z.array(buyerText(z.string().max(ADD_ON_TITLE_MAX))).max(ADD_ON_DETAILS_MAX);
/** A summary row's: its lines' detail lines (at most ADD_ON_ROWS_MAX). */
const addOnRowDetailsSchema = z.array(buyerText(z.string().max(ADD_ON_TITLE_MAX))).max(ADD_ON_ROWS_MAX);

/** A resolved buyer input as priced and frozen on the order line. */
export const orderLinePropertySchema = z.object({
  key: z.string(),
  type: z.enum(LINE_INPUT_FIELD_TYPES).openapi({ description: "`file`: an app's upload input; `value` is the upload ids joined by commas (`order_uploads.list` reads the files)." }),
  label: z.string(),
  value: buyerText(z.string()),
  /** What to print after the label: the choice label for selects, "Yes" for ticked boxes, "2 files" for uploads. */
  displayValue: buyerText(z.string()),
  /** Surcharge this input adds to one unit, in major units. */
  price: z.number(),
  priceMinor: z.number().int(),
  /** The app the entry belongs to (its line input, add-on or purchase option); absent for the product's own inputs. */
  appId: z.string().optional(),
  textRevision: z.string().optional().openapi({ description: "An app input whose words the merchant writes, or with a choice that needs confirmation: the revision of the words in `label`." }),
  revision: z.string().optional().openapi({ description: "The revision of the words the buyer answered (absent: none named)." }),
  /** A choice that needs confirmation: the agreement the buyer accepted, as shown. */
  confirmation: z.object({ text: z.string() }).optional(),
  appDrawnChoice: z.literal(true).optional().openapi({ description: "A choice its app draws itself (an input with `surfaces: []`, a select or a checkbox). Where the row also holds an add-on of the same app, that add-on states it: a buyer surface prints the add-on, not this answer." }),
  /** An app add-on's (`_adjustment`) detail lines, text the app wrote; absent: none. */
  details: addOnDetailsSchema.optional(),
}).openapi("OrderLineProperty");

/**
 * The apps' add-ons as rows of the money summary (`@scalius/shared/add-on-totals`):
 * one row per app and add-on title over every line's units, and the items'
 * subtotal without them, so Subtotal + the rows is the subtotal checkout
 * charges. A bundle's add-on counts once per bundle unit.
 */
export const addOnTotalsSchema = z.object({
  itemsSubtotal: z.number(),
  itemsSubtotalMinor: z.number().int(),
  rows: z.array(z.object({
    appId: z.string().nullable(),
    title: z.string(),
    amount: z.number(),
    amountMinor: z.number().int(),
    details: addOnRowDetailsSchema.optional().openapi({ description: "What the row opens to: its lines' detail lines, in order; absent: none." }),
  })).max(ADD_ON_ROWS_MAX),
}).openapi({ description: "The apps' add-ons as their own summary rows (\"Protection ৳350\"), grouped by app and title, and `itemsSubtotal`: the subtotal less them. Draw Subtotal as `itemsSubtotal`, then each row: together they are the subtotal." });

/**
 * An order's add-on summary rows, from its real lines' frozen add-ons
 * against its saved subtotal (`buyerOrderAddOnTotals`), folded in the
 * reader's language: the receipt and the account order draw them as they are.
 */
export const orderAddOnTotalsSchema = z.object({
  itemsSubtotalMinor: z.number().int(),
  rows: z.array(z.object({
    appId: z.string().nullable(),
    title: z.string(),
    amountMinor: z.number().int(),
    details: addOnRowDetailsSchema.optional(),
  })).max(ADD_ON_ROWS_MAX),
}).openapi({ description: "The apps' add-ons as summary rows from the order's real lines: draw Subtotal as `itemsSubtotalMinor`, then each row." });

/**
 * One active app's line input as a buyer page draws it (`checkout.lineInputs`,
 * in the page's language): the layout's `lineInputs` and the cart check's.
 */
export const appLineInputViewSchema = z.object({
  key: z.string(),
  label: z.string(),
  help: z.string().optional(),
  type: z.enum(LINE_INPUT_FIELD_TYPES),
  maxLength: z.number().int().optional(),
  options: z.array(z.object({
    value: z.string(),
    label: z.string(),
    confirm: z.object({ text: z.string(), title: z.string().optional(), agree: z.string().optional() }).optional().openapi({
      description: "The choice is taken only after the buyer agrees to `text`: the host asks (a dialog, or a required checkbox without JavaScript) and the answer carries the input's `textRevision`.",
    }),
  })).optional(),
  decision: z.object({ proceedWith: z.string().optional() }).optional().openapi({
    description: "Checkout needs an answer on every line the input applies to: a buyer's order with one undecided is refused (`decision_required`). `proceedWith` names the choice (one that needs confirmation) the host sets on every undecided line once the buyer agrees to it.",
  }),
  accept: z.array(z.enum(BUYER_UPLOAD_TYPES)).optional().openapi({ description: "`file`: the types it takes." }),
  maxBytes: z.number().int().optional().openapi({ description: "`file`: the largest file, already bounded by the deployment's plan." }),
  maxFiles: z.number().int().optional().openapi({ description: "`file`: the most files of one answer, already bounded by the plan." }),
  products: z.object({ customField: z.string() }).optional(),
  variants: z.object({ customField: z.string() }).optional(),
  bulk: z.object({
    apply: z.object({ label: z.string(), value: z.string().optional() }).optional(),
    clear: z.object({ label: z.string() }).optional(),
  }).optional().openapi({ description: "Cart-wide actions the host draws: set `apply.value` (a checkbox: \"true\") on every line the input applies to, or clear it from every line." }),
  surfaces: z.array(z.enum(LINE_INPUT_SURFACES)).optional().openapi({ description: "Where the store draws its own control for the input: `product` (the buy form), `cart` (the cart line's control and bulk actions). Absent: both. Empty: the app draws it (its `cart.line.after` block or island)." }),
  textRevision: z.string().optional().openapi({ description: "Set when the merchant writes its words (a setting the app names) or a choice needs confirmation: the revision of the words shown. A line's answer sends it back as `revision`, so the app can tell an answer given to older words; a choice that needs confirmation is taken only at the current one." }),
});

/** Buyer-input fields every order line projection carries. */
export const orderLineFulfilmentShape = {
  fulfillmentType: fulfillmentTypeSchema,
  /** Units handed over so far (sent, picked up, performed or delivered digitally). */
  fulfilledQuantity: z.number().int(),
  /** The frozen buyer inputs: an app reads the product's own and its own entries, never another app's. */
  properties: appOwnedField("items", z.array(orderLinePropertySchema)),
  /** Sum of the surcharges included in the unit price, in major units. */
  propertiesPrice: z.number(),
  propertiesPriceMinor: z.number().int(),
  /** Unit price before surcharges; null only for lines placed before Wave A. */
  baseUnitPriceMinor: z.number().int().nullable(),
};

/** The bundle an order line was bought in, for the buyer's own order (Buy again puts a kit back as the kit). */
export const orderLineBundleSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.enum(["expand", "merge", "kit"]),
  kit: z.object({ variantId: z.string(), productId: z.string() }).nullable(),
  anchor: z.boolean(),
  units: z.number().int().nullable(),
  perUnit: z.number().int().nullable(),
});

/** One app add-on of a buyer's order row, read from what the line froze (`buyerLineAddOns`). */
export const buyerLineAddOnSchema = z.object({
  appId: z.string().nullable(),
  title: buyerText(z.string()),
  total: z.number(),
  totalMinor: z.number().int().openapi({ description: "What the row's lines were charged for it, exactly." }),
  amount: z.number().nullable(),
  amountMinor: z.number().int().nullable().openapi({ description: "Per unit (`per: unit`) or per bundle unit (`per: bundle`), when one amount is exact for every unit; null: show `totalMinor`." }),
  per: z.enum(["unit", "bundle"]).openapi({ description: "From what the line froze: `bundle` for a kit's or an expanded bundle's add-on (on its anchor item's row), else `unit`." }),
  units: z.number().int().nullable().openapi({ description: "How many units (`per: unit`) or bundle units (`per: bundle`) the row holds; null when no longer known. `totalMinor = amountMinor × units` whenever `amountMinor` is a number." }),
  details: addOnDetailsSchema.optional(),
}).openapi("BuyerLineAddOn", { description: "What an app's `cart.line_prices` charged on this row (\"Protection ৳350\"), from the order's real lines." });

/** A buyer's row holds at most two real lines (a split kit item), each with a line's add-ons. */
const ROW_ADD_ONS_MAX = 2 * LINE_ADD_ONS_MAX;

/** The add-ons of a buyer's row: its lines' (a split kit item is two lines). */
export const buyerLineAddOnsSchema = z.array(buyerLineAddOnSchema).max(ROW_ADD_ONS_MAX).openapi({
  description: "Every app add-on the row was charged, exactly; empty: none. The app's own line answers are in `properties` (entries with its `appId`); an add-on is never in `properties` unless it is what each unit pays.",
});

/** The real order lines a buyer's row shows (`foldBuyerOrderLines`). */
export const buyerLineIdsSchema = z.array(z.string()).min(1).openapi({
  description: "The order lines this row shows: one, or two for a kit's item charged at its exact share (its quantities and amounts summed, `unitPriceMinor` null when the total does not divide). The row's `id` is the first. Returns, fulfilments and refunds name these lines.",
});

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
      confirm: z.object({ text: z.string(), title: z.string().optional(), agree: z.string().optional() }).optional().openapi({
        description: "An app's choice taken only once the buyer agrees to `text` (read it out on a staff order): the answer then carries the input's `textRevision` as `revision`.",
      }),
    })),
    /** An app's line input (`<app id>.<key>`); absent for the product's own. */
    appId: z.string().optional(),
    /** The SKUs an app's input applies to (a SKU's own flag over its product's); absent: every SKU. */
    variantIds: z.array(z.string()).optional(),
    textRevision: z.string().optional().openapi({ description: "An app input's words as drawn (merchant-written words, or a choice that needs agreement): send it back as the answer's `revision`." }),
  })),
}).openapi({ description: "Buyer inputs asked on the product page, in schema order." });

export const allowedPaymentMethodsSchema = z.array(z.string()).openapi({
  description: "Payment methods this cart may use. Cash on delivery is offered only when something is shipped, collected or performed.",
});
