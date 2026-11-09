// The words an order's app checkout answers are shown with
// (`presentCheckoutAttributes`): each app's name, declared attributes and the
// translations of both, so a surface writes them in its reader's language.
import { z } from "@hono/zod-openapi";
import { CHECKOUT_ATTRIBUTE_TYPES } from "@scalius/shared/plugins/buyer-ui";

const words = z.object({
  label: z.string().optional(),
  help: z.string().optional(),
  choices: z.record(z.string(), z.string()).optional(),
});

export const checkoutAttributeAppsSchema = z.array(z.object({
  appId: z.string(),
  name: z.string(),
  attributes: z.array(z.object({
    key: z.string(),
    label: z.string(),
    help: z.string().optional(),
    type: z.enum(CHECKOUT_ATTRIBUTE_TYPES),
    required: z.boolean().optional(),
    maxLength: z.number().int().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    choices: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
    maxFiles: z.number().int().optional(),
  })),
  translations: z.record(z.string(), z.object({
    name: z.string().optional(),
    checkout: z.object({ attributes: z.record(z.string(), words).optional() }).optional(),
  })).optional(),
})).openapi("CheckoutAttributeApps", {
  description: "The apps the order's checkout answers belong to: their names, declared questions (labels, choices, types) and translations, to show each answer under its label and with its choice's label, in the reader's language.",
});
