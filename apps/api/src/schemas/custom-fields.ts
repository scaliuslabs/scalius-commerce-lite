// The public shape of a storefront-visible custom field (COMMERCE-HOOKS H4),
// shared by every buyer read that carries `customFields`.
import { z } from "@hono/zod-openapi";
import { CUSTOM_FIELD_TYPES } from "@scalius/shared/custom-fields";
import { publicPageSchema } from "./entities";

export const storefrontCustomFieldSchema = z.object({
  namespace: z.string().openapi({ description: "`custom` for the merchant's fields, a plugin id for a plugin's." }),
  key: z.string(),
  name: z.string(),
  type: z.enum(CUSTOM_FIELD_TYPES),
  value: z.unknown().openapi({
    description: "JSON per the type: text, dates, URLs, colours and record ids as strings; integers as numbers; decimals as decimal strings; booleans; any JSON for `json`; money in decimal major units of the store currency; lists as arrays.",
  }),
}).openapi("StorefrontCustomField");

export const storefrontCustomFieldsSchema = z.array(storefrontCustomFieldSchema).openapi({
  description: "Storefront-visible custom fields with a value, in the merchant's order.",
});

/** One public CMS page with its storefront-visible custom fields (page lists carry none). */
export const publicPageDetailSchema = publicPageSchema.extend({ customFields: storefrontCustomFieldsSchema });
