// The edit order form's saved lines and products, prepared in the page
// component (not the route loader, which ships with the dashboard's first
// download).
import type { FulfillmentKind, FulfillmentType } from "@scalius/shared/fulfilment";
import type { ResolvedLineProperty } from "@scalius/shared/line-properties";
import type { OrderItem, Product } from "./types";
import { customizationFromView, type CustomizationView } from "./order-line-properties";

export type FormDataProduct = {
  id: string;
  variants: Array<{ id: string; fulfillmentKind?: FulfillmentKind }>;
  customizationSchema?: CustomizationView | null;
};
export type FormDataItem = Pick<OrderItem, "orderItemId" | "productId" | "variantId" | "quantity" | "price"> & {
  fulfillmentType?: FulfillmentType;
  properties?: Array<Pick<ResolvedLineProperty, "key" | "label" | "displayValue" | "priceMinor"> & Partial<ResolvedLineProperty>>;
};

/** What a saved line is, from how it reaches the buyer (frozen at commit). */
function kindOfType(type: FulfillmentType): FulfillmentKind {
  return type === "ship" || type === "pickup" ? "physical" : type === "service" ? "service" : "digital";
}

/** The edit form's products, with the buyer inputs each asks for (for lines added while editing). */
export function formProducts<P extends FormDataProduct>(products: readonly P[]): Array<P & Pick<Product, "customization">> {
  return products.map((product) => ({ ...product, customization: customizationFromView(product.customizationSchema ?? null) }));
}

/**
 * Saved lines as the edit form holds them: what each SKU is (a pickup or
 * service order asks no address) and the inputs frozen on it, shown but never
 * sent again (a kept line keeps them).
 */
export function formItems(items: readonly FormDataItem[], products: readonly FormDataProduct[]): OrderItem[] {
  const kinds = new Map(products.flatMap((product) => product.variants.map((variant) => [variant.id, variant.fulfillmentKind] as const)));
  return items.map(({ properties, fulfillmentType, ...item }) => ({
    ...item,
    fulfillmentKind: fulfillmentType
      ? kindOfType(fulfillmentType)
      : (item.variantId ? kinds.get(item.variantId) : undefined) ?? "physical",
    ...(properties?.length
      ? {
          propertiesDisplay: properties.map((property) => ({
            key: property.key,
            type: property.type ?? "text",
            label: property.label,
            value: property.value ?? property.displayValue,
            displayValue: property.displayValue,
            priceMinor: property.priceMinor,
          })),
        }
      : {}),
  }));
}
