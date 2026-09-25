/**
 * Buyer inputs on the product page (Wave A §3, §8.2): the pure part shared by
 * the buyer-inputs block, the product controller and the no-JavaScript
 * `/buy/<slug>` POST. Validation and pricing reuse the shared
 * `@scalius/shared/line-properties` functions the API runs, so the cart line
 * key and the committed line always agree.
 *
 * Values are buyer content: never put them in URLs, analytics or logs.
 */
import {
  canonicalizeLineProperties,
  CUSTOMIZATION_SCHEMA_VERSION,
  LINE_PROPERTY_INPUT_LIMITS,
  normalizePropertyText,
  resolveLineProperties,
  type CanonicalLineProperty,
  type CustomizationField,
  type CustomizationSchema,
  type LinePropertyInput,
} from "@scalius/shared/line-properties";
import { getCheckoutLanguagePreset, type CheckoutLanguageData } from "@scalius/shared/checkout-language";
import { formatCheckoutLanguageText } from "@scalius/shared/checkout-language-format";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { fromMinor, toMinor } from "@scalius/shared/money";
import type { OrderLineProperty, ProductCustomization } from "@/lib/api/types";
import type { CartLineProperty } from "@/store/cart";

/** Form field names of the no-JavaScript buyer-inputs form: `property.<key>`. */
export const BUYER_INPUT_FIELD_PREFIX = "property.";

export const BUYER_INPUT_COPY_KEYS = [
  "customizationRequiredText",
  "customizationRequiredChoiceText",
  "customizationRequiredCheckText",
  "customizationTooLongText",
  "customizationCounterText",
  "customizationSurchargeText",
  "customizationOptionalText",
  "customizationChoosePlaceholderText",
  "customizationUnavailableText",
  "customizationNeededText",
  "updateCartItemText",
  "noDeliveryNeededBadgeText",
  "payAtServiceText",
] as const satisfies readonly (keyof CheckoutLanguageData)[];

export type BuyerInputCopy = Pick<CheckoutLanguageData, (typeof BUYER_INPUT_COPY_KEYS)[number]>;

/**
 * Product-page copy: the built-in preset of the store's checkout language,
 * overlaid with whatever the layout's `storefrontCopy` carries (merchant edits).
 */
export function resolveProductPageCopy<T extends { languageCode?: string } & Partial<Record<string, unknown>>>(
  storefrontCopy: T | null | undefined,
): CheckoutLanguageData {
  const preset = getCheckoutLanguagePreset(storefrontCopy?.languageCode);
  const overrides = Object.fromEntries(
    Object.entries(storefrontCopy ?? {}).filter(
      ([key, value]) => key !== "languageCode" && key in preset && typeof value === "string" && value.trim() !== "",
    ),
  );
  return { ...preset, ...overrides };
}

export function pickBuyerInputCopy(copy: CheckoutLanguageData): BuyerInputCopy {
  return Object.fromEntries(BUYER_INPUT_COPY_KEYS.map((key) => [key, copy[key]])) as BuyerInputCopy;
}

/** The shared schema from the product page view; null when the product asks nothing. */
export function customizationSchemaFromView(
  view: ProductCustomization | null | undefined,
): CustomizationSchema | null {
  const fields = view?.fields ?? [];
  if (fields.length === 0) return null;
  return {
    version: CUSTOMIZATION_SCHEMA_VERSION,
    fields: fields.map((field): CustomizationField => {
      const base = { key: field.key, label: field.label, required: field.required, help: field.help };
      switch (field.type) {
        case "select":
          return {
            ...base,
            type: "select",
            options: field.options.map((option) => ({
              value: option.value,
              label: option.label,
              priceMinor: safeMinor(option.priceMinor),
            })),
          };
        case "checkbox":
          return { ...base, type: "checkbox", priceMinor: safeMinor(field.priceMinor) };
        default:
          return {
            ...base,
            type: field.type,
            maxLength: field.maxLength ?? LINE_PROPERTY_INPUT_LIMITS.valueLength,
            priceMinor: safeMinor(field.priceMinor),
          };
      }
    }),
  };
}

function safeMinor(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/** Unicode characters of the NFC text, as the server counts them. */
export function characterCount(value: string): number {
  let count = 0;
  for (const _character of value.normalize("NFC")) count += 1;
  return count;
}

/** The "{count}/{max}" counter under a text field. */
export function counterText(copy: Pick<BuyerInputCopy, "customizationCounterText">, value: string, max: number): string {
  return formatCheckoutLanguageText(copy.customizationCounterText, { count: characterCount(value), max });
}

/** Currency places the money helpers accept (0–3), else the currency's own. */
export function moneyPlaces(decimalPlaces: number | null | undefined, currencyCode: string): number {
  return Number.isInteger(decimalPlaces) && decimalPlaces! >= 0 && decimalPlaces! <= 3
    ? decimalPlaces!
    : getDecimalPlaces(currencyCode);
}

/** "+৳200" for a surcharge, or null when the input is free. */
export function surchargeText(
  copy: Pick<BuyerInputCopy, "customizationSurchargeText">,
  priceMinor: number,
  places: number,
  formatMoney: (amount: number) => string,
): string | null {
  if (!(priceMinor > 0)) return null;
  return formatCheckoutLanguageText(copy.customizationSurchargeText, {
    price: formatMoney(fromMinor(priceMinor, places)),
  });
}

/** What the filled inputs add to one unit, in minor units (lenient, for the live price). */
export function buyerInputsSurchargeMinor(
  schema: CustomizationSchema | null,
  values: readonly LinePropertyInput[],
): number {
  if (!schema) return 0;
  const canonical = new Map(canonicalizeLineProperties(schema, values).map((entry) => [entry.key, entry.value]));
  let total = 0;
  for (const field of schema.fields) {
    const value = canonical.get(field.key);
    if (value === undefined) continue;
    if (field.type === "select") {
      total += field.options.find((option) => option.value === value)?.priceMinor ?? 0;
    } else {
      total += field.priceMinor;
    }
  }
  return total;
}

/**
 * One unit with its inputs: the base (the SKU's sale price, the product's own
 * discount applied to the base only) plus the surcharges, in exact minor units.
 */
export function unitPriceWithSurcharge(basePrice: number, surchargeMinor: number, places: number): number {
  if (!(surchargeMinor > 0)) return basePrice;
  try {
    return fromMinor(toMinor(Math.max(0, basePrice), places) + surchargeMinor, places);
  } catch {
    return basePrice;
  }
}

export interface BuyerInputError {
  key: string;
  message: string;
}

export type BuyerInputsValidation =
  | {
      ok: true;
      canonical: CanonicalLineProperty[];
      /** The cart line's `properties`: schema order, empty optional inputs dropped. */
      properties: CartLineProperty[];
      propertiesPriceMinor: number;
    }
  | { ok: false; errors: BuyerInputError[] };

function requiredMessage(field: CustomizationField, copy: BuyerInputCopy): string {
  const template = field.type === "select"
    ? copy.customizationRequiredChoiceText
    : field.type === "checkbox"
      ? copy.customizationRequiredCheckText
      : copy.customizationRequiredText;
  return formatCheckoutLanguageText(template, { field: field.label });
}

/**
 * Checks every input before a line is added: a message per missing or too
 * long field (in schema order, so the first one is focused), then the shared
 * strict `resolveLineProperties` as the final gate.
 */
export function validateBuyerInputs(
  schema: CustomizationSchema | null,
  values: readonly LinePropertyInput[],
  copy: BuyerInputCopy,
): BuyerInputsValidation {
  if (!schema) return { ok: true, canonical: [], properties: [], propertiesPriceMinor: 0 };
  const byKey = new Map<string, string>();
  for (const entry of values) if (!byKey.has(entry.key)) byKey.set(entry.key, entry.value);

  const errors: BuyerInputError[] = [];
  for (const field of schema.fields) {
    const raw = byKey.get(field.key) ?? "";
    const value = field.type === "checkbox"
      ? (normalizePropertyText(raw) === "true" ? "true" : "")
      : normalizePropertyText(raw);
    if (!value) {
      if (field.required) errors.push({ key: field.key, message: requiredMessage(field, copy) });
      continue;
    }
    if ((field.type === "text" || field.type === "textarea") && characterCount(value) > field.maxLength) {
      errors.push({
        key: field.key,
        message: formatCheckoutLanguageText(copy.customizationTooLongText, { max: field.maxLength }),
      });
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  const canonical = canonicalizeLineProperties(schema, values);
  const resolved = resolveLineProperties(schema, canonical);
  if (!resolved.ok) {
    const field = schema.fields.find((candidate) => candidate.key === resolved.key) ?? schema.fields[0]!;
    return { ok: false, errors: [{ key: field.key, message: requiredMessage(field, copy) }] };
  }
  return {
    ok: true,
    canonical: resolved.canonical,
    properties: resolved.properties.map(({ key, value, label, displayValue, priceMinor }) => ({
      key,
      value,
      label,
      displayValue,
      priceMinor,
    })),
    propertiesPriceMinor: resolved.propertiesPriceMinor,
  };
}

/** The server's resolved inputs (cart validation) as cart line properties. */
export function cartLinePropertiesFromOrderLine(
  properties: readonly OrderLineProperty[] | null | undefined,
): CartLineProperty[] {
  return (properties ?? []).map(({ key, value, label, displayValue, priceMinor }) => ({
    key,
    value,
    label,
    displayValue,
    priceMinor: safeMinor(priceMinor),
  }));
}

export type PostedBuyerInputs =
  | { ok: true; variantId: string | null; quantity: string | null; properties: LinePropertyInput[] }
  | { ok: false };

/**
 * Reads the no-JavaScript form body: `variant`, `quantity` and bounded
 * `property.<key>` fields (at most 10, each at most 1,000 characters).
 * Anything else in the body is ignored.
 */
export function readPostedBuyerInputs(entries: Iterable<[string, FormDataEntryValue]>): PostedBuyerInputs {
  let variantId: string | null = null;
  let quantity: string | null = null;
  const properties: LinePropertyInput[] = [];
  const seen = new Set<string>();
  for (const [name, entry] of entries) {
    if (typeof entry !== "string") return { ok: false };
    if (name === "variant") {
      variantId = entry.trim().slice(0, 128) || null;
      continue;
    }
    if (name === "quantity" || name === "qty") {
      quantity = entry.trim().slice(0, 16);
      continue;
    }
    if (!name.startsWith(BUYER_INPUT_FIELD_PREFIX)) continue;
    const key = name.slice(BUYER_INPUT_FIELD_PREFIX.length);
    if (seen.has(key)) return { ok: false };
    seen.add(key);
    if (
      properties.length >= LINE_PROPERTY_INPUT_LIMITS.entries ||
      characterCount(entry) > LINE_PROPERTY_INPUT_LIMITS.valueLength
    ) {
      return { ok: false };
    }
    properties.push({ key, value: entry });
  }
  return { ok: true, variantId, quantity, properties };
}
