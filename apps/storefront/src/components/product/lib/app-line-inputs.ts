// Which of the active apps' line inputs (manifest `checkout.lineInputs`) a
// product or one of its SKUs shows: the one rule checkout applies
// (`appLineInputApplies`), over the storefront custom fields the product page
// carries. Its own module, without the buy form's copy, so an island's
// `addLine` (lib/buyer-ui/actions.ts) checks inputs without loading it.
import {
  appLineInputApplies,
  type AppLineInputDeclaration,
  type AppLineInputFlags,
} from "@scalius/shared/line-properties";
import type { Product, ProductVariant } from "@/lib/api/types";

type Fields = Product["customFields"];

/** An owner's app flags: its storefront boolean fields of an app (`<app id>.<key>`). */
export function storefrontAppFlags(customFields: Fields): AppLineInputFlags {
  const flags = new Map<string, boolean>();
  for (const field of customFields ?? []) {
    if (field.namespace !== "custom" && typeof field.value === "boolean") flags.set(`${field.namespace}.${field.key}`, field.value);
  }
  return flags;
}

/**
 * Whether an app's line input applies to this product and SKU (`variant`
 * null: no SKU chosen, so an input shown by SKU does not yet).
 */
export function appLineInputShown(
  product: Pick<Product, "customFields">,
  variant: Pick<ProductVariant, "customFields"> | null,
): (appId: string, input: AppLineInputDeclaration) => boolean {
  const flags = { product: storefrontAppFlags(product.customFields), variant: variant ? storefrontAppFlags(variant.customFields) : null };
  return (appId, input) => appLineInputApplies(appId, input, flags);
}

/**
 * The SKUs among `variants` an app's input applies to: null when it applies
 * to every one (or names no SKU flag), [] when to none.
 */
export function appLineInputVariantIds(
  appId: string,
  input: AppLineInputDeclaration,
  product: Pick<Product, "customFields">,
  variants: ReadonlyArray<Pick<ProductVariant, "id" | "customFields">>,
): string[] | null {
  if (!input.variants) return appLineInputShown(product, null)(appId, input) ? null : [];
  const ids = variants.filter((variant) => appLineInputShown(product, variant)(appId, input)).map((variant) => variant.id);
  return ids.length === variants.length && ids.length > 0 ? null : ids;
}
