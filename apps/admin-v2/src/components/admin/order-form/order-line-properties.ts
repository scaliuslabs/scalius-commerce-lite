import {
  CUSTOMIZATION_SCHEMA_VERSION,
  lineInputConfirmOption,
  resolveLineProperties,
  type CustomizationField,
  type CustomizationSchema,
  type LineInputConfirm,
  type LinePropertyInput,
  type ResolvedLineProperty,
} from "@scalius/shared/line-properties";
import type { FulfillmentKind } from "@scalius/shared/fulfilment";

/** A product's buyer inputs as the product reads return them (prices in both units). */
export interface CustomizationView {
  fields: Array<{
    key: string;
    label: string;
    /** A product's own input: a stored schema never holds an app's `file` input. */
    type: Exclude<CustomizationField["type"], "file">;
    required: boolean;
    help: string | null;
    maxLength: number | null;
    priceMinor: number;
    /** `confirm`: an app's choice taken only once the buyer agrees to its agreement. */
    options: Array<{ value: string; label: string; priceMinor: number; confirm?: LineInputConfirm }>;
    /** An app's line input (`<app id>.<key>`); absent for the product's own. */
    appId?: string;
    /** The SKUs an app's input applies to (a SKU's own flag over its product's); absent: every SKU. */
    variantIds?: string[];
    /** The revision of an app input's words as drawn: an answer sends it back (`revision`). */
    textRevision?: string;
  }>;
}

/**
 * The shared schema the checkout resolves against, from a product read. Null
 * without inputs. With `variantId` (`null`: no SKU chosen yet), an app's input
 * that applies to some SKUs only is left out unless it applies to that one, so
 * staff never fill an input the order would refuse.
 */
export function customizationFromView(view: CustomizationView | null | undefined, variantId?: string | null): CustomizationSchema | null {
  const fields = (view?.fields ?? []).filter((field) => variantId === undefined || !field.variantIds || (variantId !== null && field.variantIds.includes(variantId)));
  if (fields.length === 0) return null;
  return {
    version: CUSTOMIZATION_SCHEMA_VERSION,
    fields: fields.map((field): CustomizationField => {
      const base = {
        key: field.key, label: field.label, required: field.required, help: field.help,
        ...(field.appId ? { appId: field.appId } : {}),
        ...(field.textRevision ? { textRevision: field.textRevision } : {}),
      };
      if (field.type === "select") {
        return { ...base, type: "select", options: field.options.map(({ value, label, priceMinor, confirm }) => ({ value, label, priceMinor, ...(confirm ? { confirm } : {}) })) };
      }
      if (field.type === "checkbox") return { ...base, type: "checkbox", priceMinor: field.priceMinor };
      return { ...base, type: field.type, maxLength: field.maxLength ?? (field.type === "text" ? 200 : 1000), priceMinor: field.priceMinor };
    }),
  };
}

/**
 * Typed values by field key → the payload entries (empty ones dropped, as the
 * storefront sends them). An app input whose words carry a revision answers
 * with the revision drawn, as the buy form does; a choice that needs the
 * buyer's agreement carries it only once staff tick that the buyer agrees
 * (`agreed`), so checkout takes it at the agreement shown.
 */
export function propertyEntries(
  values: Readonly<Record<string, string>>,
  schema: CustomizationSchema | null = null,
  agreed: ReadonlySet<string> = new Set(),
): LinePropertyInput[] {
  const fields = new Map((schema?.fields ?? []).map((field) => [field.key, field]));
  return Object.entries(values)
    .filter(([, value]) => value.trim() !== "")
    .map(([key, value]) => {
      const field = fields.get(key);
      const revision = field?.textRevision && (!lineInputConfirmOption(field, value.trim()) || agreed.has(key)) ? field.textRevision : undefined;
      return revision ? { key, value, revision } : { key, value };
    });
}

/**
 * A stored line's answers as the form takes them back (an abandoned checkout,
 * a past order): a choice that needs the buyer's agreement comes back only
 * when it was agreed to at the agreement drawn now; otherwise the line comes
 * back undecided on it, for staff to ask again.
 */
export function restoredAnswers(schema: CustomizationSchema | null, properties: readonly LinePropertyInput[]): { values: Record<string, string>; agreed: Set<string> } {
  const fields = new Map((schema?.fields ?? []).map((field) => [field.key, field]));
  const values: Record<string, string> = {};
  const agreed = new Set<string>();
  for (const { key, value, revision } of properties) {
    const field = fields.get(key);
    if (field && lineInputConfirmOption(field, value)) {
      if (revision === undefined || revision !== field.textRevision) continue;
      agreed.add(key);
    }
    values[key] = value;
  }
  return { values, agreed };
}

export type LinePropertiesCheck =
  | { ok: true; properties: LinePropertyInput[]; resolved: ResolvedLineProperty[]; surchargeMinor: number }
  | { ok: false; key: string | null; reason: "required" | "invalid" | "agreement" };

/**
 * The same check the server runs at commit (shared `resolveLineProperties`):
 * the line is added only with every required input, valid choices, and the
 * buyer's agreement to a choice that needs it (`agreed`).
 */
export function checkLineProperties(
  schema: CustomizationSchema | null,
  values: Readonly<Record<string, string>>,
  agreed: ReadonlySet<string> = new Set(),
): LinePropertiesCheck {
  const result = resolveLineProperties(schema, propertyEntries(values, schema, agreed));
  if (!result.ok) {
    return { ok: false, key: result.key, reason: result.code === "properties_required" ? "required" : result.code === "confirmation_required" ? "agreement" : "invalid" };
  }
  const revisions = new Map(result.properties.flatMap((property) => (property.revision ? [[property.key, property.revision] as const] : [])));
  return {
    ok: true,
    properties: result.canonical.map((entry) => (revisions.has(entry.key) ? { ...entry, revision: revisions.get(entry.key)! } : entry)),
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
