// App surfaces in the theme document: homepage sections and product-page
// blocks that installed apps draw (`storefront.sections` and
// `storefront.productBlocks` of their manifests), named `<plugin id>/<type>`.
// The document holds where they go and the merchant's values; the app's own
// manifest owns the settings schema, so the document only bounds the values
// and the API resolves them against the active app when it renders. An app
// that is gone, inactive or no longer declares the type renders nothing.

import { z } from "zod";
import { PLUGIN_SETTING_KEY, PLUGIN_SETTING_LIST_MAX } from "../plugins/settings-schema";
import { PLUGIN_PRODUCT_BLOCKS_MAX, PLUGIN_SURFACE_KEY_PATTERN } from "../plugins/storefront";

/** One `list` item's field value. */
const appSettingItemValue = z.union([z.string().max(5000), z.number().finite(), z.boolean(), z.null()]);

/** One setting value (`PluginSettingValue`), bounded. */
const appSettingValue = z.union([
  z.string().max(5000),
  z.number().finite(),
  z.boolean(),
  z.array(z.string().max(64)).max(50),
  // A `list` setting's items.
  z.array(z.record(z.string().regex(PLUGIN_SETTING_KEY), appSettingItemValue)
    .refine((item) => Object.keys(item).length <= 12, "At most 12 fields per item."))
    .max(PLUGIN_SETTING_LIST_MAX),
  z.null(),
]);

export const storefrontAppValuesSchema = z.record(z.string().regex(PLUGIN_SETTING_KEY), appSettingValue)
  .refine((values) => Object.keys(values).length <= 40, "At most 40 settings.");

export const storefrontAppKeySchema = z.string().regex(PLUGIN_SURFACE_KEY_PATTERN, "Use <app id>/<type>.");

/** A product-page block of an app; its placement (buy box or below) is the app's. */
export const storefrontProductAppBlockSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/),
  app: storefrontAppKeySchema,
  values: storefrontAppValuesSchema,
}).strict();
export type StorefrontProductAppBlock = z.infer<typeof storefrontProductAppBlockSchema>;

/** The product page's app blocks, in the merchant's order: unique ids, at most `PLUGIN_PRODUCT_BLOCKS_MAX`. */
export const storefrontProductAppBlocksSchema = z.array(storefrontProductAppBlockSchema).max(PLUGIN_PRODUCT_BLOCKS_MAX)
  .refine((blocks) => new Set(blocks.map((block) => block.id)).size === blocks.length, "Each block id appears once.");

/**
 * A theme slot an app fills (`storefront.slots` of its manifest): the app's
 * `<plugin id>/<slot id>` and the merchant's values for it. While the app is
 * inactive, no longer declares the slot or draws nothing, the core block of
 * that slot renders, so a slot never leaves the page without a header,
 * footer or card.
 */
export const storefrontAppSlotSchema = z.object({
  app: storefrontAppKeySchema,
  values: storefrontAppValuesSchema,
}).strict();
export type StorefrontAppSlot = z.infer<typeof storefrontAppSlotSchema>;

/**
 * The document's `apps`: the slots apps fill, and the app template the look
 * was applied from (a label, like `template`).
 */
export const storefrontThemeAppsSchema = z.object({
  header: storefrontAppSlotSchema.optional(),
  footer: storefrontAppSlotSchema.optional(),
  productCard: storefrontAppSlotSchema.optional(),
  template: storefrontAppKeySchema.optional(),
}).strict();
export type StorefrontThemeApps = z.infer<typeof storefrontThemeAppsSchema>;

/** The document key of each slot (`header`, `footer`, `productCard`). */
export const STOREFRONT_APP_SLOT_KEYS = { header: "header", footer: "footer", "product-card": "productCard" } as const;
