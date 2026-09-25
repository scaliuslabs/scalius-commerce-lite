// Buyer inputs a product asks for (Wave A §3.1): the merchant's customization
// schema in the decimal HTTP contract, converted once at the edge to the
// stored minor-unit JSON validated by `@scalius/shared/line-properties`.
// The column is part of the product aggregate (writes advance the aggregate
// revision) and of the checkout authority fence (a change fails in-flight
// checkouts).
import {
    CUSTOMIZATION_SCHEMA_VERSION,
    parseCustomizationSchema,
    parseStoredCustomizationSchema,
    serializeCustomizationSchema,
    type CustomizationField,
    type CustomizationSchema,
} from "@scalius/shared/line-properties";
import { fromMinor } from "@scalius/shared/money";
import { ValidationError } from "@scalius/core/errors";
import { toStoreMinor, type StoreCurrency } from "../settings/store-money";
import type { CustomizationSchemaInput } from "./customization-schema";

export * from "./customization-schema";

/**
 * Converts the decimal HTTP schema into the stored column value, validating
 * every limit and the store's cash step (whole taka in BDT). Null means no
 * buyer inputs.
 */
export function toStoredCustomizationSchema(
    input: CustomizationSchemaInput | null,
    currency: StoreCurrency,
): string | null {
    if (input === null || input.fields.length === 0) return null;
    const minor = (price: number | undefined) => price === undefined ? undefined : toStoreMinor(price, currency);
    const result = parseCustomizationSchema({
        version: CUSTOMIZATION_SCHEMA_VERSION,
        fields: input.fields.map((field) => ({
            key: field.key,
            label: field.label,
            type: field.type,
            required: field.required ?? false,
            help: field.help ?? null,
            ...(field.maxLength !== undefined ? { maxLength: field.maxLength } : {}),
            ...(field.type === "select"
                ? {
                    options: (field.options ?? []).map((option) => ({
                        value: option.value,
                        label: option.label,
                        priceMinor: minor(option.price) ?? 0,
                    })),
                }
                : { priceMinor: minor(field.price) ?? 0 }),
        })),
    });
    if (!result.ok) throw new ValidationError(result.issues[0] ?? "The buyer inputs are invalid.", { issues: result.issues });
    return result.schema ? serializeCustomizationSchema(result.schema) : null;
}

export interface CustomizationOptionView {
    value: string;
    label: string;
    price: number;
    priceMinor: number;
}

export interface CustomizationFieldView {
    key: string;
    label: string;
    type: CustomizationField["type"];
    required: boolean;
    help: string | null;
    /** text/textarea only; null otherwise. */
    maxLength: number | null;
    /** text/textarea/checkbox surcharge; 0 for selects (their options carry prices). */
    price: number;
    priceMinor: number;
    /** select choices; empty for other types. */
    options: CustomizationOptionView[];
}

export interface CustomizationView {
    fields: CustomizationFieldView[];
}

function presentField(field: CustomizationField, decimalPlaces: number): CustomizationFieldView {
    const priceMinor = field.type === "select" ? 0 : field.priceMinor;
    return {
        key: field.key,
        label: field.label,
        type: field.type,
        required: field.required,
        help: field.help,
        maxLength: field.type === "text" || field.type === "textarea" ? field.maxLength : null,
        price: fromMinor(priceMinor, decimalPlaces),
        priceMinor,
        options: field.type === "select"
            ? field.options.map((option) => ({
                value: option.value,
                label: option.label,
                price: fromMinor(option.priceMinor, decimalPlaces),
                priceMinor: option.priceMinor,
            }))
            : [],
    };
}

export function presentCustomizationSchema(
    schema: CustomizationSchema | null,
    decimalPlaces: number,
): CustomizationView | null {
    if (!schema) return null;
    return { fields: schema.fields.map((field) => presentField(field, decimalPlaces)) };
}

export interface StoredCustomizationRead {
    customization: CustomizationView | null;
    requiresCustomization: boolean;
    /** The stored schema did not validate: the product cannot be bought until it is fixed. */
    invalid: boolean;
}

/**
 * Reads the stored column for a buyer or staff projection. A malformed
 * value is reported (a readiness issue), never silently treated as "no
 * inputs".
 */
export function readStoredCustomization(
    stored: string | null | undefined,
    decimalPlaces: number,
): StoredCustomizationRead {
    const parsed = parseStoredCustomizationSchema(stored);
    if (!parsed.ok) return { customization: null, requiresCustomization: false, invalid: true };
    return {
        customization: presentCustomizationSchema(parsed.schema, decimalPlaces),
        requiresCustomization: parsed.schema?.fields.some((field) => field.required) ?? false,
        invalid: false,
    };
}
