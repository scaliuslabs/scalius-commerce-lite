// The values and client-side checks of an app's form (inputs in
// packages/shared/src/plugins/ui.ts). The checks only spare a round trip:
// the app validates again and may answer `errors` by input name.
import type { PluginUiInput, PluginUiJson } from "@scalius/shared/plugins/ui";
import type { AppUiMessageKey } from "~/i18n/app-ui";

/** A field's draft: text and dates as typed, numbers (NaN while not a number), choices, ticks. */
export type InputValue = string | number | boolean | null;

export interface InputProblem {
  key: AppUiMessageKey;
  vars?: Record<string, string | number>;
  /** The vars are ISO dates (shown in the dashboard's date format). */
  dates?: boolean;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function initialInputValue(input: PluginUiInput): InputValue {
  switch (input.type) {
    case "text-field":
    case "textarea":
      return input.value ?? "";
    case "number-field":
      return input.value ?? null;
    case "select":
      return input.value ?? null;
    case "checkbox":
      return input.value ?? false;
    case "date-field":
      return input.value ?? null;
  }
}

function isRealDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isWebAddress(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/** The first problem with a field's draft, or null. */
export function checkInput(input: PluginUiInput, value: InputValue): InputProblem | null {
  switch (input.type) {
    case "text-field":
    case "textarea": {
      const text = typeof value === "string" ? value : "";
      if (text.trim() === "") return input.required ? { key: "required" } : null;
      if (input.type === "text-field" && input.minLength !== undefined && text.length < input.minLength) return { key: "tooShort", vars: { min: input.minLength } };
      if (input.maxLength !== undefined && text.length > input.maxLength) return { key: "tooLong", vars: { max: input.maxLength } };
      if (input.type === "text-field" && input.format === "email" && !EMAIL.test(text.trim())) return { key: "notEmail" };
      if (input.type === "text-field" && input.format === "url" && !isWebAddress(text.trim())) return { key: "notUrl" };
      return null;
    }
    case "number-field": {
      if (value === null || value === "") return input.required ? { key: "required" } : null;
      if (typeof value !== "number" || Number.isNaN(value)) return { key: "notNumber" };
      if (input.integer && !Number.isInteger(value)) return { key: "notInteger" };
      if (input.min !== undefined && value < input.min) return { key: "belowMin", vars: { min: input.min } };
      if (input.max !== undefined && value > input.max) return { key: "aboveMax", vars: { max: input.max } };
      return null;
    }
    case "select": {
      if (value === null || value === "") return input.required ? { key: "required" } : null;
      return input.options.some((option) => option.value === value) ? null : { key: "notOption" };
    }
    case "checkbox":
      return input.required && value !== true ? { key: "required" } : null;
    case "date-field": {
      if (value === null || value === "") return input.required ? { key: "required" } : null;
      if (typeof value !== "string" || !isRealDate(value)) return { key: "notDate" };
      if (input.min !== undefined && value < input.min) return { key: "dateBefore", vars: { min: input.min }, dates: true };
      if (input.max !== undefined && value > input.max) return { key: "dateAfter", vars: { max: input.max }, dates: true };
      return null;
    }
  }
}

/** What a field sends under `values` (empty choices and dates are null). */
export function inputValueToJson(input: PluginUiInput, value: InputValue): PluginUiJson {
  switch (input.type) {
    case "text-field":
    case "textarea":
      return typeof value === "string" ? value : "";
    case "number-field":
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    case "select":
    case "date-field":
      return typeof value === "string" && value !== "" ? value : null;
    case "checkbox":
      return value === true;
  }
}
