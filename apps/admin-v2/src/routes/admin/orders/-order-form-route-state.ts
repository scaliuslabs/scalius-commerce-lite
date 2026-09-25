import type { OrderFormMessageKey } from "~/i18n/order-form";
import type { FulfillmentKind, FulfillmentType } from "@scalius/shared/fulfilment";
import type { ResolvedLineProperty } from "@scalius/shared/line-properties";
import type { OrderItem, Product } from "~/components/admin/order-form/types";
import { customizationFromView, type CustomizationView } from "~/components/admin/order-form/order-line-properties";

interface EditState {
  allowed: boolean;
  reason: string | null;
}

const LOCK_MESSAGE: Record<string, OrderFormMessageKey> = {
  shipped: "lockShipped",
  closed: "lockClosed",
  paid: "lockPaid",
  online_payment: "lockOnlinePayment",
  discount: "lockDiscount",
  history: "lockHistory",
  inventory: "lockInventory",
  archived: "lockArchived",
  busy: "lockBusy",
  unavailable: "lockUnavailable",
};

/** The plain sentence for a server edit-lock reason code. */
export function editLockMessageKey(reason: string | null): OrderFormMessageKey {
  return (reason && LOCK_MESSAGE[reason]) || "lockUnknown";
}

/**
 * Edit order has one mode: change the items before shipment (the server's
 * amendment quote). Otherwise the page explains why, and whether the customer
 * and address can still be edited from the order page.
 */
export function orderEditState(readiness: { items: EditState; details: EditState }):
  | { mode: "amend" }
  | { mode: "locked"; message: OrderFormMessageKey; canEditDetails: boolean } {
  if (readiness.items.allowed) return { mode: "amend" };
  return {
    mode: "locked",
    message: editLockMessageKey(readiness.items.reason),
    canEditDetails: readiness.details.allowed,
  };
}

/**
 * The edit form's delivery method. The form data carries none, so the order's
 * saved method is preselected (and named even when no longer offered), never
 * "Custom charge" for an order placed with a named method.
 */
export function savedDeliveryMethod(order: {
  shippingMethodId: string | null;
  shippingMethodName: string | null;
  /** Pickup orders keep no address; the edit form must not ask for one. */
  shippingMethodKind?: "delivery" | "pickup" | null;
}) {
  const shippingMethodKind = order.shippingMethodKind ?? null;
  if (!order.shippingMethodId) return { shippingMethodId: null, shippingMethodKind, savedShippingMethod: null };
  return {
    shippingMethodId: order.shippingMethodId,
    shippingMethodKind,
    savedShippingMethod: {
      id: order.shippingMethodId,
      name: order.shippingMethodName ?? order.shippingMethodId,
      kind: shippingMethodKind,
    },
  };
}

type FormDataProduct = {
  id: string;
  variants: Array<{ id: string; fulfillmentKind?: FulfillmentKind }>;
  customizationSchema?: CustomizationView | null;
};
type FormDataItem = Pick<OrderItem, "orderItemId" | "productId" | "variantId" | "quantity" | "price"> & {
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
