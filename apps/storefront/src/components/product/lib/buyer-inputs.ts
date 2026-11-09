/**
 * Buyer inputs on the product page (Wave A §3, §8.2): the pure part shared by
 * the buyer-inputs block, the product controller and the no-JavaScript
 * `/buy/<slug>` POST. Validation and pricing reuse the shared
 * `@scalius/shared/line-properties` functions the API runs, so the cart line
 * key and the committed line always agree. The form asks the product's own
 * inputs, then the active apps' line inputs (`withAppLineInputs`, under
 * `<app id>.<key>`), the same way checkout resolves the line.
 *
 * Values are buyer content: never put them in URLs, analytics or logs.
 */
import { checkoutText } from "@/lib/checkout-text";
import {
  canonicalizeLineProperties,
  CUSTOMIZATION_SCHEMA_VERSION,
  LINE_PROPERTY_INPUT_LIMITS,
  lineInputIssues,
  lineInputLength,
  normalizeLinePurchaseOptions,
  resolveLineProperties,
  withAppLineInputs,
  type AppLineInputs,
  type CanonicalLineProperty,
  type CustomizationField,
  type CustomizationSchema,
  type LinePropertyInput,
} from "@scalius/shared/line-properties";
import { getCheckoutLanguagePreset, type CheckoutLanguageData } from "@scalius/shared/checkout-language";
import { localizedGiftCardRecipientFields } from "@scalius/shared/gift-card-recipient";
import { BUYER_UPLOAD_DECLARATION_LIMITS, BUYER_UPLOAD_TYPES } from "@scalius/shared/buyer-upload-value";

import { fromMinor } from "@scalius/shared/money";
import { isPurchaseOptionId, purchaseOptionAppId } from "@scalius/shared/plugins/ids";
import type { OrderLineProperty, Product, ProductCustomization, ProductCustomizationField } from "@/lib/api/types";
import type { CartLineProperty } from "@/store/cart";
import { BUY_FORM_VARIANT_FIELDS, BUYER_INPUT_FIELD_PREFIX, PURCHASE_OPTION_FIELD } from "./buy-form";
import { appLineInputShown } from "./app-line-inputs";

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
      const base = { key: field.key, label: field.label, required: field.required, help: field.help, ...(field.appId ? { appId: field.appId } : {}) };
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
        case "file":
          return {
            ...base,
            type: "file",
            accept: field.accept?.length ? [...field.accept] : [...BUYER_UPLOAD_TYPES],
            maxBytes: field.maxBytes ?? BUYER_UPLOAD_DECLARATION_LIMITS.maxBytes,
            maxFiles: field.maxFiles ?? 1,
            priceMinor: 0,
          };
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

/**
 * The buyer inputs the product's buy form asks, as the page draws them: the
 * product's own, then the active apps' line inputs (`withAppLineInputs`;
 * the layout's `lineInputs`), shown on this product, priced at nothing. A
 * gift card (money) takes no app inputs; a product whose own setup is
 * unreadable asks nothing (it cannot be bought).
 */
export function productBuyerInputFields(
  product: Pick<Product, "customization" | "customizationUnavailable" | "isGiftCard" | "customFields">,
  lineInputs: readonly AppLineInputs[] | null | undefined,
  /** The page's checkout copy (`resolveProductPageCopy`): a gift card's recipient inputs speak it. */
  copy: CheckoutLanguageData,
): ProductCustomizationField[] {
  if (product.customizationUnavailable) return [];
  const own = localizedGiftCardRecipientFields(product.customization?.fields ?? [], copy);
  if (product.isGiftCard || !lineInputs?.length) return own;
  const schema = withAppLineInputs(customizationSchemaFromView(product.customization), lineInputs, appLineInputShown(product.customFields));
  const apps = (schema?.fields ?? []).filter((field) => field.appId).map((field): ProductCustomizationField => ({
    key: field.key,
    label: field.label,
    type: field.type,
    required: field.required,
    help: field.help,
    maxLength: field.type === "text" || field.type === "textarea" ? field.maxLength : null,
    price: 0,
    priceMinor: 0,
    options: field.type === "select" ? field.options.map((option) => ({ value: option.value, label: option.label, price: 0, priceMinor: 0 })) : [],
    ...(field.type === "file" ? { accept: [...field.accept], maxBytes: field.maxBytes, maxFiles: field.maxFiles } : {}),
    appId: field.appId!,
  }));
  return [...own, ...apps];
}

/** The schema a product's buy form checks and checkout resolves (`productBuyerInputFields`). */
export function productBuyerInputSchema(
  product: Parameters<typeof productBuyerInputFields>[0],
  lineInputs: readonly AppLineInputs[] | null | undefined,
  copy: CheckoutLanguageData,
): CustomizationSchema | null {
  return customizationSchemaFromView({ fields: productBuyerInputFields(product, lineInputs, copy) });
}

function safeMinor(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/** Unicode characters of the NFC text (the shared count the dashboard's preview shows too). */
export function characterCount(value: string): number {
  return lineInputLength(value);
}

/** The "{count}/{max}" counter under a text field. */
export function counterText(copy: Pick<BuyerInputCopy, "customizationCounterText">, value: string, max: number): string {
  return checkoutText(copy.customizationCounterText, { count: characterCount(value), max });
}

/** "+৳200" for a surcharge, or null when the input is free. */
export function surchargeText(
  copy: Pick<BuyerInputCopy, "customizationSurchargeText">,
  priceMinor: number,
  places: number,
  formatMoney: (amount: number) => string,
): string | null {
  if (!(priceMinor > 0)) return null;
  return checkoutText(copy.customizationSurchargeText, {
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
  return checkoutText(template, { field: field.label });
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
  // The shared per-field rule (`lineInputIssues`): the dashboard's preview shows the same.
  const errors: BuyerInputError[] = lineInputIssues(schema, values).map(({ key, problem }) => {
    const field = schema.fields.find((candidate) => candidate.key === key)!;
    return {
      key,
      message: problem.kind === "too_long"
        ? checkoutText(copy.customizationTooLongText, { max: problem.maxLength })
        : requiredMessage(field, copy),
    };
  });
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
  | {
    ok: true;
    variantId: string | null;
    quantity: string | null;
    properties: LinePropertyInput[];
    /** The apps' purchase options (`<app id>.<key>`, one per app, sorted); empty: one-time. */
    purchaseOptions: string[];
  }
  | { ok: false };

/**
 * Reads the no-JavaScript form body: the SKU (`BUY_FORM_VARIANT_FIELDS`: the
 * pressed button's, else the picker's, else the form's last, whatever their
 * order in the body; a repeated button or picker field refuses it),
 * `quantity`, the purchase options (`purchaseOption`, or one
 * `purchaseOption.<app id>` per app: empty is that app's "none"; a malformed
 * one, one of another app than its field names, or two of one app refuse
 * the body) and bounded `property.<key>` fields (the product's and the
 * apps', at most `LINE_PROPERTY_INPUT_LIMITS.entries`, each at most 1,000
 * characters). Anything else in the body is ignored.
 */
export function readPostedBuyerInputs(entries: Iterable<[string, FormDataEntryValue]>): PostedBuyerInputs {
  const variants = new Map<string, string | null>();
  let quantity: string | null = null;
  const purchaseOptions: string[] = [];
  const properties: LinePropertyInput[] = [];
  const seen = new Set<string>();
  for (const [name, entry] of entries) {
    if (typeof entry !== "string") return { ok: false };
    if (Object.values(BUY_FORM_VARIANT_FIELDS).some((field) => field === name)) {
      // A page from the build before the picker had its own name posts
      // `variant` twice (the form's, then the picker's): its last one is the
      // buyer's. The newer fields come once from a real page.
      if (variants.has(name) && name !== BUY_FORM_VARIANT_FIELDS.form) return { ok: false };
      variants.set(name, entry.trim().slice(0, 128) || null);
      continue;
    }
    if (name === "quantity" || name === "qty") {
      quantity = entry.trim().slice(0, 16);
      continue;
    }
    if (name === PURCHASE_OPTION_FIELD || name.startsWith(`${PURCHASE_OPTION_FIELD}.`)) {
      const value = entry.trim();
      const appId = name === PURCHASE_OPTION_FIELD ? null : name.slice(PURCHASE_OPTION_FIELD.length + 1);
      if (!value) continue;
      if (!isPurchaseOptionId(value) || (appId !== null && purchaseOptionAppId(value) !== appId)) return { ok: false };
      purchaseOptions.push(value);
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
  const variantId = variants.get(BUY_FORM_VARIANT_FIELDS.button)
    ?? variants.get(BUY_FORM_VARIANT_FIELDS.picker)
    ?? variants.get(BUY_FORM_VARIANT_FIELDS.form)
    ?? null;
  const options = normalizeLinePurchaseOptions(purchaseOptions);
  if (!options.ok) return { ok: false };
  return { ok: true, variantId, quantity, properties, purchaseOptions: options.options };
}
