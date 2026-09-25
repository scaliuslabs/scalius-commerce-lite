import { z } from "zod";
import { validateAndFormatPhone } from "@scalius/shared/customer-utils";
import { translate } from "~/i18n";
import { orderFormMessages, type OrderFormMessageKey } from "~/i18n/order-form";
import type { BuyerPriceRange } from "~/lib/format-utils";
import type { FulfillmentKind } from "@scalius/shared/fulfilment";
import type { CustomizationSchema, LinePropertyInput, ResolvedLineProperty } from "@scalius/shared/line-properties";
import { orderNeedsAddress } from "./order-line-properties";

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

/** Validation messages are read when validation runs, so they follow the dashboard language. */
const msg = (key: OrderFormMessageKey) => ({
  error: () => translate(orderFormMessages, key),
});

/**
 * A Bangladesh mobile in any spacing, with +880/880/0 and Bangla digits, or a
 * full international number; saved as +8801XXXXXXXXX (E.164).
 */
export function toE164Phone(raw: string): string | null {
  const latin = raw.replace(/[০-৯]/g, (digit) => String(digit.charCodeAt(0) - 0x09e6)).trim();
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
  /** Asked only when something ships (see `orderNeedsAddress`); checked below. */
  shippingAddress: z
    .string()
    .trim()
    .max(500, msg("addressTooLong")),
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
          .max(99, msg("quantityMax")),
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
}).superRefine((values, context) => {
  // A pickup order or one with nothing physical has no delivery address (Wave A §2.7).
  if (!orderNeedsAddress(values)) return;
  const address = values.shippingAddress.trim();
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
