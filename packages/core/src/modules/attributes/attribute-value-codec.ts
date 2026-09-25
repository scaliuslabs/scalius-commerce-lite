// src/modules/attributes/attribute-value-codec.ts
// Pure (browser-safe) rules that turn a merchant-typed value into the stored
// columns of one typed product attribute value. The product writer and the
// type conversion share them, so a value that converts also saves.
import {
    ATTRIBUTE_VALUE_MAX_LENGTH,
    canonicalAttributeNumber,
    parseAttributeNumber,
    type AttributeValueType,
} from "@scalius/shared/catalog-attributes";

/** Display text plus `value_number` (null for text and enum values). */
export interface EncodedAttributeValue {
    value: string;
    valueNumber: number | null;
}

const TRUE_WORDS = new Set(["yes", "true", "1", "হ্যাঁ", "হ্যা"]);
const FALSE_WORDS = new Set(["no", "false", "0", "না"]);

/** 1 for yes/true/1 (and Bangla হ্যাঁ), 0 for no/false/0 (না), else null. */
export function parseAttributeBoolean(input: string): 0 | 1 | null {
    const word = input.normalize("NFC").trim().toLowerCase();
    if (TRUE_WORDS.has(word)) return 1;
    if (FALSE_WORDS.has(word)) return 0;
    return null;
}

/**
 * A number, optionally followed by the attribute's unit ("15.6 inch" when the
 * unit is "inch"; "15.6" too). Null when it is not one.
 */
export function parseAttributeNumberWithUnit(input: string, unit: string | null): number | null {
    let text = input.trim();
    if (unit) {
        const suffix = unit.trim().toLowerCase();
        if (suffix && text.toLowerCase().endsWith(suffix)) {
            text = text.slice(0, text.length - suffix.length).trim();
        }
    }
    return parseAttributeNumber(text);
}

/** The display text of a number: canonical number plus " unit" when there is one. */
export function formatAttributeNumber(value: number, unit: string | null): string {
    const number = canonicalAttributeNumber(value);
    return unit ? `${number} ${unit}` : number;
}

/** The display text of a text or enum value: trimmed, 1-200 characters, else null. */
export function attributeDisplayText(input: string): string | null {
    const value = input.trim();
    return value.length > 0 && value.length <= ATTRIBUTE_VALUE_MAX_LENGTH ? value : null;
}

/**
 * Stored columns of `input` for an attribute of `type`, or null when it does
 * not convert. Enum values return their display text; the caller resolves
 * (or creates) the `attribute_values` row that names them.
 */
export function encodeAttributeValue(
    type: AttributeValueType,
    input: string,
    unit: string | null,
): EncodedAttributeValue | null {
    switch (type) {
        case "text":
        case "enum": {
            const value = attributeDisplayText(input);
            return value === null ? null : { value, valueNumber: null };
        }
        case "number": {
            const number = parseAttributeNumberWithUnit(input, unit);
            return number === null ? null : { value: formatAttributeNumber(number, unit), valueNumber: number };
        }
        case "boolean": {
            const flag = parseAttributeBoolean(input);
            return flag === null ? null : { value: flag === 1 ? "Yes" : "No", valueNumber: flag };
        }
    }
}
