// What an app checkout answer may be, without the schema code (zod): the
// storefront's checkout script and the server share these checks.
import { dateLocale, formatDateTime } from "../locale-format";
import type { CheckoutAttribute } from "./buyer-ui";

/** A valid calendar day `YYYY-MM-DD`, the form a `date` attribute stores. */
export function isAttributeDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

/**
 * Whether an extension may offer `choices` it computed for an attribute this
 * render: over free text (the app checks the answer), over a date (each a
 * valid day), and over a declared choice (each one of its declared values; the
 * extension's labels may add availability, the order keeps the declared one).
 * A computed choice labelled with its own value reads as the platform words
 * it (`offeredChoices`).
 */
export function computedChoicesFit(attribute: CheckoutAttribute, choices: ReadonlyArray<{ value: string }>): boolean {
  if (attribute.type === "text") return true;
  if (attribute.type === "date") return choices.every((choice) => isAttributeDate(choice.value));
  if (attribute.type === "choice") return choices.every((choice) => attribute.choices?.some((declared) => declared.value === choice.value));
  return false;
}

/** A `date` answer (`YYYY-MM-DD`) in the reader's language: "10 Nov 2026", "১০ নভে, ২০২৬". */
export function formatAttributeDate(value: string, language: string, region?: string | null): string {
  if (!isAttributeDate(value)) return value;
  return formatDateTime(new Date(`${value}T00:00:00Z`), dateLocale(language, region), { dateStyle: "medium", timeZone: "UTC" });
}

/**
 * The choices a field offers for an extension's computed ones, as the buyer
 * (or staff member) reads them: a date labelled with its own value is written
 * in `language`, a declared choice labelled with its own value takes its
 * declared label (already in the reader's language). Null when they do not
 * fit the attribute (the field then offers its declared choices, if any).
 */
export function offeredChoices(
  attribute: CheckoutAttribute,
  computed: ReadonlyArray<{ value: string; label: string }> | undefined,
  language: string,
): Array<{ value: string; label: string }> | null {
  if (!computed?.length || !computedChoicesFit(attribute, computed)) return null;
  return computed.map((choice) => {
    if (choice.label !== choice.value) return { value: choice.value, label: choice.label };
    if (attribute.type === "date") return { value: choice.value, label: formatAttributeDate(choice.value, language) };
    if (attribute.type === "choice") return { value: choice.value, label: attribute.choices?.find((declared) => declared.value === choice.value)?.label ?? choice.label };
    return { value: choice.value, label: choice.label };
  });
}
