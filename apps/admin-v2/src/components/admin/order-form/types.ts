import { z } from "zod";
import { validateAndFormatPhone } from "@scalius/shared/customer-utils";
import { MAX_LINE_QUANTITY } from "@scalius/shared/order-limits";
import { translate } from "~/i18n";
import { orderFormMessages, type OrderFormMessageKey } from "~/i18n/order-form";
import type { BuyerPriceRange } from "~/lib/price-range";
import type { FulfillmentKind } from "@scalius/shared/fulfilment";
import type { CustomizationSchema, LinePropertyInput, ResolvedLineProperty } from "@scalius/shared/line-properties";
import { ORDER_CHANNEL_SOURCE_MAX_LENGTH, ORDER_CHANNEL_SOURCE_PRESETS } from "@scalius/shared/order-channel";
import { normalizeOrderChannelSource } from "@scalius/shared/order-channel-source";
import { orderNeedsAddress } from "./order-line-properties";
import { toLatinDigits } from "@scalius/shared/phone-input";

export interface Product {
  id: string;
  name: string;
  price: number;
  discountPercentage: number | null;
  discountType?: string | null;
  discountAmount?: number | null;
  variantCount?: number | null;
  /** Catalog search rows only: thumbnail, what buyers pay and stock before a variant is chosen. */
  primaryImage?: string | null;
  priceRange?: BuyerPriceRange | null;
  availableStock?: number | null;
  /** Buyer inputs the product asks for (engraving, gift wrap, a fit); null or absent without any. */
  customization?: CustomizationSchema | null;
  variants: {
    id: string;
    optionCombinationKey: string | null;
    selectedOptions: Array<{ name: string; value: string }>;
    weight: number | null;
    sku: string;
    price: number;
    stock: number;
    reservedStock?: number | null;
    isDefault?: boolean;
    trackInventory?: boolean;
    discountType?: string | null;
    discountPercentage?: number | null;
    discountAmount?: number | null;
    /** physical ships or is picked up; a service needs no delivery. */
    fulfillmentKind?: FulfillmentKind;
  }[];
}

export interface OrderItem {
  orderItemId?: string;
  productId: string;
  variantId: string | null;
  quantity: number;
  price: number;
  /** Display only (lines added or prefilled here): never sent to the server. */
  name?: string;
  variantLabel?: string | null;
  /** New orders: the SKU's sellable stock when the line was added (null = not tracked). */
  available?: number | null;
  /** Display and delivery rules only: what the SKU is. Never sent. */
  fulfillmentKind?: FulfillmentKind;
  /** Buyer inputs sent with the line (same SKU, different inputs = another line). */
  properties?: LinePropertyInput[];
  /** Display only: the inputs as the order will print them, with their surcharges. */
  propertiesDisplay?: ResolvedLineProperty[];
}

/**
 * create: new confirmed COD order.
 * amend: quote-backed change of an unshipped, unpaid order (preview, then confirm).
 */
export type OrderFormMode = "create" | "amend";

export interface OrderFormProps {
  mode: OrderFormMode;
  products?: Product[];
  defaultValues?: Partial<z.infer<typeof orderFormSchema>>;
  /** Amend only: "#1001" and the cash still to collect before the change. */
  orderLabel?: string;
  cashToCollect?: number | null;
  /** Amend only: the order was placed without a delivery method (it ships nothing). */
  amendShipsNothing?: boolean;
  /** Amend only: the order's saved delivery method. */
  savedShippingMethod?: { id: string; name: string; kind?: "delivery" | "pickup" | null } | null;
}

/** The Sales channel picker: a preset source, or "other" with the merchant's own name for it. */
export const ORDER_SOURCE_CHOICES = [...ORDER_CHANNEL_SOURCE_PRESETS, "other"] as const;
export type OrderSourceChoice = (typeof ORDER_SOURCE_CHOICES)[number];

/**
 * What a new order sends as `channelSource`: the preset, the typed name
 * (the server stores it as a slug), or nothing.
 */
export function orderChannelSourceInput(values: {
  sourceChoice?: OrderSourceChoice | null;
  sourceName?: string;
}): string | null {
  if (!values.sourceChoice) return null;
  if (values.sourceChoice !== "other") return values.sourceChoice;
  return values.sourceName?.trim() || null;
}

/** Validation messages are read when validation runs, so they follow the dashboard language. */
const msg = (key: OrderFormMessageKey) => ({
  error: () => translate(orderFormMessages, key),
});

/**
 * A Bangladesh mobile in any spacing, with +880/880/0 and Bangla digits, or a
 * full international number; saved as +8801XXXXXXXXX (E.164).
 */
export function toE164Phone(raw: string): string | null {
  const latin = toLatinDigits(raw).trim();
  const bdMobile = /^(?:\+?880|0)?(1[3-9]\d{8})$/.exec(latin.replace(/[\s\-().]/g, ""));
  if (bdMobile) return `+880${bdMobile[1]}`;
  try {
    return validateAndFormatPhone(latin);
  } catch {
    return null;
  }
}

export const orderFormSchema = z.object({
  id: z.string().optional(),
  version: z.number().int().min(1).optional(),
  customerName: z.string().trim().min(1, msg("nameRequired")).min(3, msg("nameTooShort")).max(100, msg("nameTooLong")),
  customerPhone: z.string().trim().min(1, msg("phoneRequired")).transform((raw, context) => {
    const phone = toE164Phone(raw);
    if (phone) return phone;
    context.addIssue({ code: "custom", message: translate(orderFormMessages, "phoneInvalid") });
    return z.NEVER;
  }),
  customerEmail: z.email(msg("emailInvalid")).nullable(),
  /**
   * The shipping country (MARKETS-DESIGN D7): Bangladesh uses the street
   * address and City → Thana → Area; another country the fields its rules
   * use (the API checks them).
   */
  shippingCountryCode: z.string().length(2).optional(),
  /** Asked only when something ships (see `orderNeedsAddress`); checked below. */
  shippingAddress: z
    .string()
    .trim()
    .max(500, msg("addressTooLong")),
  shippingAddressLine2: z.string().optional(),
  shippingDependentLocality: z.string().optional(),
  shippingLocality: z.string().optional(),
  shippingAdminArea: z.string().optional(),
  shippingPostalCode: z.string().optional(),
  shippingCompany: z.string().optional(),
  /** Keep an address the API refused, marked (shown once it refused). */
  skipAddressValidation: z.boolean().optional(),
  city: z.string(),
  zone: z.string(),
  area: z.string().nullable(),
  /** Labels of the chosen places (the server stores the names it validates). */
  cityName: z.string().nullable().optional(),
  zoneName: z.string().nullable().optional(),
  areaName: z.string().nullable().optional(),
  notes: z.string().max(500, msg("notesTooLong")).nullable(),
  items: z
    .array(
      z.object({
        orderItemId: z.string().optional(),
        productId: z.string().min(1, msg("productRequired")),
        variantId: z.string().nullable(),
        quantity: z
          .number()
          .int()
          .min(1, msg("quantityMin"))
          .max(MAX_LINE_QUANTITY, msg("quantityMax")),
        price: z.number().min(0),
        name: z.string().optional(),
        variantLabel: z.string().nullable().optional(),
        available: z.number().nullable().optional(),
        fulfillmentKind: z.enum(["physical", "digital", "service"]).optional(),
        properties: z.array(z.object({ key: z.string(), value: z.string() })).max(10).optional(),
        propertiesDisplay: z.array(z.custom<ResolvedLineProperty>()).optional(),
      }),
    )
    .min(1, msg("itemsRequired"))
    // Lines of one SKU share its stock; the quantity field shows "Only N available" itself.
    .superRefine((items, context) => {
      items.forEach((item, index) => {
        if (item.available == null || !item.variantId) return;
        const others = items.reduce(
          (sum, other, otherIndex) => (otherIndex !== index && other.variantId === item.variantId ? sum + other.quantity : sum),
          0,
        );
        const remaining = Math.max(0, item.available - others);
        if (item.quantity > remaining) {
          context.addIssue({
            code: "custom",
            path: [index, "quantity"],
            message: translate(orderFormMessages, remaining === 0 ? "outOfStock" : "onlyAvailable", { count: remaining }),
          });
        }
      });
    }),
  discountAmount: z.number(msg("amountNotNumber")).min(0, msg("discountNegative")).nullable(),
  shippingCharge: z.number(msg("amountNotNumber")).min(0, msg("deliveryChargeNegative")),
  /** The delivery method picked for the charge; null for a custom charge. */
  shippingMethodId: z.string().nullable().optional(),
  /** The picked method's kind: a pickup needs no address. Null for a custom charge (delivery). */
  shippingMethodKind: z.enum(["delivery", "pickup"]).nullable().optional(),
  /** New orders: where the order came in (Sales channel card); none by default. */
  sourceChoice: z.enum(ORDER_SOURCE_CHOICES).nullable().optional(),
  /** The name typed for an "Other" source. */
  sourceName: z.string().optional(),
  /** New orders: cash on delivery (the default) or an invoice paid later (Payment card). */
  paymentMethod: z.enum(["cod", "net_terms"]).optional(),
  /** An invoice's days; null: the store's net days. */
  paymentTermsDays: z.number().int().min(1).max(365).nullable().optional(),
}).superRefine((values, context) => {
  if (values.sourceChoice === "other") {
    const name = values.sourceName?.trim() ?? "";
    const message = !name
      ? "sourceRequired"
      : name.length > ORDER_CHANNEL_SOURCE_MAX_LENGTH
        ? "sourceTooLong"
        : normalizeOrderChannelSource(name) === null ? "sourceInvalid" : null;
    if (message) {
      context.addIssue({ code: "custom", path: ["sourceName"], message: translate(orderFormMessages, message) });
    }
  }
  // A pickup order or one with nothing physical has no delivery address (Wave A §2.7).
  if (!orderNeedsAddress(values)) return;
  const address = values.shippingAddress.trim();
  if (values.shippingCountryCode && values.shippingCountryCode !== "BD") {
    // Another country's rules are checked by the API; the first line is always asked.
    if (!address) context.addIssue({ code: "custom", path: ["shippingAddress"], message: translate(orderFormMessages, "addressRequired") });
    return;
  }
  if (address.length < 10) {
    context.addIssue({
      code: "custom",
      path: ["shippingAddress"],
      message: translate(orderFormMessages, address ? "addressTooShort" : "addressRequired"),
    });
  }
  if (!values.city) context.addIssue({ code: "custom", path: ["city"], message: translate(orderFormMessages, "cityRequired") });
  if (!values.zone) context.addIssue({ code: "custom", path: ["zone"], message: translate(orderFormMessages, "zoneRequired") });
});

export type OrderFormInput = z.input<typeof orderFormSchema>;
export type OrderFormValues = z.output<typeof orderFormSchema>;
