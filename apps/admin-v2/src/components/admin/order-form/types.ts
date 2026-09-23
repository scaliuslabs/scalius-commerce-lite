import { z } from "zod";
import { phoneNumberSchema } from "@scalius/shared/customer-utils";
import { translate } from "~/i18n";
import { orderFormMessages, type OrderFormMessageKey } from "~/i18n/order-form";

export { phoneNumberSchema };

export interface Product {
  id: string;
  name: string;
  price: number;
  discountPercentage: number | null;
  discountType?: string | null;
  discountAmount?: number | null;
  variantCount?: number | null;
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
  }[];
}

export interface DeliveryLocation {
  id: string;
  name: string;
  type: "city" | "zone" | "area";
  parentId: string | null;
  externalIds: Record<string, unknown>;
  metadata: Record<string, unknown>;
  isActive: boolean;
  sortOrder: number;
}

export interface OrderItem {
  orderItemId?: string;
  productId: string;
  variantId: string | null;
  quantity: number;
  price: number;
}

/**
 * create: new confirmed COD order. edit: full rewrite (PUT with expectedVersion).
 * amend: quote-backed amendment of a manual COD order (preview, then confirm).
 */
export type OrderFormMode = "create" | "edit" | "amend";

export interface OrderFormProps {
  mode: OrderFormMode;
  products?: Product[];
  defaultValues?: Partial<z.infer<typeof orderFormSchema>>;
}

/** Validation messages are read when validation runs, so they follow the dashboard language. */
const msg = (key: OrderFormMessageKey) => ({
  error: () => translate(orderFormMessages, key),
});

export const orderFormSchema = z.object({
  id: z.string().optional(),
  version: z.number().int().min(1).optional(),
  customerName: z.string().min(3, msg("nameTooShort")).max(100, msg("nameTooLong")),
  customerPhone: phoneNumberSchema,
  customerEmail: z.email().nullable(),
  shippingAddress: z
    .string()
    .min(10, msg("addressTooShort"))
    .max(500, msg("addressTooLong")),
  city: z.string().min(1, msg("cityRequired")),
  zone: z.string().min(1, msg("zoneRequired")),
  area: z.string().nullable(),
  cityName: z.string().optional(),
  zoneName: z.string().optional(),
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
        price: z.number().min(0, msg("notNegative")),
      }),
    )
    .min(1, msg("itemsRequired")),
  discountAmount: z.coerce.number<number>().min(0, msg("notNegative")).nullable(),
  shippingCharge: z.coerce.number<number>().min(0, msg("notNegative")),
  status: z.string().min(1).optional(),
});

export type OrderFormInput = z.input<typeof orderFormSchema>;
export type OrderFormValues = z.output<typeof orderFormSchema>;
