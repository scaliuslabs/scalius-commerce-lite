import {
  CUSTOMIZATION_SCHEMA_VERSION,
  resolveLineProperties,
  type CustomizationField,
  type CustomizationSchema,
  type LinePropertyInput,
  type ResolvedLineProperty,
} from "@scalius/shared/line-properties";
import type { FulfillmentKind } from "@scalius/shared/fulfilment";

/** A product's buyer inputs as the product reads return them (prices in both units). */
export interface CustomizationView {
  fields: Array<{
    key: string;
    label: string;
    type: CustomizationField["type"];
    required: boolean;
    help: string | null;
    maxLength: number | null;
    priceMinor: number;
    options: Array<{ value: string; label: string; priceMinor: number }>;
  }>;
}

/** The shared schema the checkout resolves against, from a product read. Null without inputs. */
export function customizationFromView(view: CustomizationView | null | undefined): CustomizationSchema | null {
  if (!view || view.fields.length === 0) return null;
  return {
    version: CUSTOMIZATION_SCHEMA_VERSION,
    fields: view.fields.map((field): CustomizationField => {
      const base = { key: field.key, label: field.label, required: field.required, help: field.help };
      if (field.type === "select") {
        return { ...base, type: "select", options: field.options.map(({ value, label, priceMinor }) => ({ value, label, priceMinor })) };
      }
      if (field.type === "checkbox") return { ...base, type: "checkbox", priceMinor: field.priceMinor };
      return { ...base, type: field.type, maxLength: field.maxLength ?? (field.type === "text" ? 200 : 1000), priceMinor: field.priceMinor };
    }),
  };
}

/** Typed values by field key → the payload entries (empty ones dropped, as the storefront sends them). */
export function propertyEntries(values: Readonly<Record<string, string>>): LinePropertyInput[] {
  return Object.entries(values)
    .filter(([, value]) => value.trim() !== "")
    .map(([key, value]) => ({ key, value }));
}

export type LinePropertiesCheck =
  | { ok: true; properties: LinePropertyInput[]; resolved: ResolvedLineProperty[]; surchargeMinor: number }
  | { ok: false; key: string | null; reason: "required" | "invalid" };

/**
 * The same check the server runs at commit (shared `resolveLineProperties`):
 * the line is added only with every required input and valid choices.
 */
export function checkLineProperties(
  schema: CustomizationSchema | null,
  values: Readonly<Record<string, string>>,
): LinePropertiesCheck {
  const properties = propertyEntries(values);
  const result = resolveLineProperties(schema, properties);
  if (!result.ok) return { ok: false, key: result.key, reason: result.code === "PROPERTIES_REQUIRED" ? "required" : "invalid" };
  return {
    ok: true,
    properties: result.canonical,
    resolved: result.properties,
    surchargeMinor: result.propertiesPriceMinor,
  };
}

/** Whether a line needs a delivery method: physical goods do, services and digital goods don't. */
export function isPhysicalLine(item: { fulfillmentKind?: FulfillmentKind | null }): boolean {
  return (item.fulfillmentKind ?? "physical") === "physical";
}

/**
 * The address is asked only when something ships: a physical line delivered
 * to the buyer. A pickup method or a cart of services needs none.
 */
export function orderNeedsAddress(values: {
  items: ReadonlyArray<{ fulfillmentKind?: FulfillmentKind | null }>;
  shippingMethodKind?: "delivery" | "pickup" | null;
}): boolean {
  const physical = values.items.length === 0 || values.items.some(isPhysicalLine);
  return physical && values.shippingMethodKind !== "pickup";
}
