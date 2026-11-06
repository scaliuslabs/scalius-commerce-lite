// Which of the active apps' line inputs (manifest `checkout.lineInputs`) a
// product shows. Its own module, without the buy form's copy, so an island's
// `addLine` (lib/buyer-ui/actions.ts) checks inputs without loading it.
import type { Product } from "@/lib/api/types";

/**
 * Whether the product shows an app's line input limited to some products
 * (`products: { customField }`): its storefront custom field
 * `<app id>.<customField>` is the boolean true.
 */
export function appLineInputShown(
  customFields: Product["customFields"],
): (appId: string, gate: { customField: string }) => boolean {
  return (appId, gate) => (customFields ?? []).some((field) =>
    field.namespace === appId && field.key === gate.customField && field.value === true);
}
