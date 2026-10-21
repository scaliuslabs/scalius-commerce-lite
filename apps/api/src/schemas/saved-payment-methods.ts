// OpenAPI schemas for a customer's saved payment methods as the buyer (their
// account) and staff (the customer page) see them (security audit N3): the
// display facts and what the method was kept for, never the provider's
// reference. Apps read them through `payment_methods.list`
// (routes/admin/resources-payment-methods.ts).
import { z } from "@hono/zod-openapi";
import type { CustomerPaymentMethodView } from "@scalius/core/modules/payments";

const isoTimestamp = z.string().openapi({ format: "date-time" });
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

/** What the buyer sees in their account. */
export const customerSavedPaymentMethodSchema = z.object({
  id: z.string().openapi({ description: "The saved method (`cpm_…`)." }),
  brand: z.string().nullable().openapi({ description: "The card network or wallet, lower case (`visa`)." }),
  last4: z.string().nullable().openapi({ description: "The last four digits; the full number never reaches the store." }),
  expiryMonth: z.number().int().nullable(),
  expiryYear: z.number().int().nullable(),
  label: z.string().nullable(),
  savedFor: z.string().nullable().openapi({ description: "The purchase option it was kept for, as the buyer chose it at checkout (\"Subscribe and save\")." }),
  createdAt: isoTimestamp,
}).openapi("CustomerSavedPaymentMethod");

/** What staff see on the customer page: also who may charge it and the order that kept it. */
export const staffSavedPaymentMethodSchema = customerSavedPaymentMethodSchema.extend({
  providerId: z.string().openapi({ description: "The payment provider that keeps it (`<app id>:<provider id>`, or a built-in gateway)." }),
  ownerAppId: z.string().nullable().openapi({ description: "The app whose purchase option kept it: the only app that may charge it. Null: only staff may." }),
  purchaseOptionId: z.string().nullable(),
  sourceOrderId: z.string().nullable().openapi({ description: "The order whose payment kept it." }),
}).openapi("StaffSavedPaymentMethod");

export function customerSavedPaymentMethod(method: CustomerPaymentMethodView): z.infer<typeof customerSavedPaymentMethodSchema> {
  return {
    id: method.id,
    brand: method.brand,
    last4: method.last4,
    expiryMonth: method.expiryMonth,
    expiryYear: method.expiryYear,
    label: method.label,
    savedFor: method.purchaseOptionTitle,
    createdAt: iso(method.createdAt),
  };
}

export function staffSavedPaymentMethod(method: CustomerPaymentMethodView): z.infer<typeof staffSavedPaymentMethodSchema> {
  return {
    ...customerSavedPaymentMethod(method),
    providerId: method.providerId,
    ownerAppId: method.ownerPluginId,
    purchaseOptionId: method.purchaseOptionId,
    sourceOrderId: method.sourceOrderId,
  };
}
