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
  to: z.string().optional().openapi({ description: "Qualified target type for object references." }),
  object: z.object({
    handle: z.string().nullable(),
    fields: z.array(z.object({ key: z.string(), name: z.string(), type: z.enum(CUSTOM_FIELD_TYPES), value: z.unknown() })).max(40),
  }).optional().openapi({ description: "One published scalar object reference, containing declared public fields only." }),
  value: z.unknown().openapi({
    description: "JSON per the type: text, dates, URLs, colours and record ids as strings; integers as numbers; decimals as decimal strings; booleans; any JSON for `json`; money in decimal major units of the store currency; lists as arrays.",
  }),
  reference: z.object({
    id: z.string(),
    url: z.string(),
    alt: z.string().optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
  }).optional().openapi({ description: "Resolved public product, collection, or image reference; absent when its target is unavailable." }),
}).openapi("StorefrontCustomField");

export const storefrontCustomFieldsSchema = z.array(storefrontCustomFieldSchema).openapi({
  description: "Storefront-visible custom fields with a value, in the merchant's order.",
});

export const storefrontCardFieldsSchema = z.record(z.string(), z.unknown()).openapi({
  description: "Requested storefront-visible card fields, keyed by namespace.key.",
});

/** One public CMS page with its storefront-visible custom fields (page lists carry none). */
export const publicPageDetailSchema = publicPageSchema.extend({ customFields: storefrontCustomFieldsSchema });
