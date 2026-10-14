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
 * An app's skin of a core-owned unit (`storefront.skins` of its manifest):
 * the app's `<plugin id>/<skin id>` and the merchant's values for it. While
 * the app is inactive, no longer declares the skin for that unit, or draws
 * nothing, core draws the unit, so a page never lacks its header, footer,
 * card, product page, listing or section.
 */
export const storefrontSkinRefSchema = z.object({
  app: storefrontAppKeySchema,
  values: storefrontAppValuesSchema,
}).strict();
export type StorefrontSkinRef = z.infer<typeof storefrontSkinRefSchema>;

/**
 * The document's `apps`: the units app skins draw, by skin target (a core
 * section's skin sits on its placement instead), and the app template the
 * look was applied from (a label, like `template`). `skin` is the skin
 * reference schema (the API passes its named one, so its contract states it once).
 */
export function storefrontThemeAppsSchemaOf(skin: typeof storefrontSkinRefSchema) {
  return z.object({
    skins: z.object({
      header: skin.optional(),
      footer: skin.optional(),
      "product-card": skin.optional(),
      "product-main": skin.optional(),
      "listing-main": skin.optional(),
    }).strict().optional(),
    template: storefrontAppKeySchema.optional(),
  }).strict();
}

export const storefrontThemeAppsSchema = storefrontThemeAppsSchemaOf(storefrontSkinRefSchema);
export type StorefrontThemeApps = z.infer<typeof storefrontThemeAppsSchema>;
export type StorefrontThemeSkins = NonNullable<StorefrontThemeApps["skins"]>;
export type StorefrontThemeSkinUnit = keyof StorefrontThemeSkins;
