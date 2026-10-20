// The Custom data card's editing model: one text draft per field (a list of
// texts for list types), converted to and from the API's typed values and
// checked with the shared codec, so the card accepts exactly what the API
// accepts. Money is typed in major units of the store currency and crosses
// the API as { amountMinor, currency }, converted here once. Pure; no React.
import { getDecimalPlaces } from "@scalius/shared/currency";
import {
  customFieldItemType,
  customFieldMoneyFromMajor,
  customFieldMoneyMajorText,
  isCustomFieldMoney,
  isCustomFieldListType,
  parseCustomFieldValidations,
  parseCustomFieldValue,
  type CustomFieldCodecContext,
  type CustomFieldIssue,
  type CustomFieldType,
  type CustomFieldWireValidations,
  type CustomFieldWireValue,
} from "@scalius/shared/custom-fields";

import { parseDateOnly } from "~/lib/date-only";

export type CustomFieldDraft = string | string[];

const pad = (value: number) => String(value).padStart(2, "0");

/** A UTC instant as a date/time draft in the browser's time zone. */
export function localDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const base = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return date.getSeconds() === 0 ? base : `${base}:${pad(date.getSeconds())}`;
}

function itemDraft(type: CustomFieldType, value: unknown): string {
  if (value === null || value === undefined) return "";
  switch (customFieldItemType(type)) {
    case "json":
      return JSON.stringify(value, null, 2);
    case "boolean":
      return value === true ? "true" : value === false ? "false" : "";
    case "date_time":
      return typeof value === "string" ? localDateTime(value) : "";
    case "money":
      // The amount carries its currency, so it reads without the store's.
      return isCustomFieldMoney(value)
        ? customFieldMoneyMajorText(value, { currencyCode: value.currency, decimalPlaces: getDecimalPlaces(value.currency) })
        : "";
    default:
      return String(value);
  }
}

/** A money value from the API (`{ amountMinor, currency }`) as the major-unit number the dashboard formats, or null. */
export function moneyMajor(value: unknown): number | null {
  if (!isCustomFieldMoney(value) || !Number.isSafeInteger(value.amountMinor)) return null;
  return value.amountMinor / 10 ** getDecimalPlaces(value.currency);
}

/** The API value as the card's draft. */
export function draftFromValue(type: CustomFieldType, value: CustomFieldWireValue | null): CustomFieldDraft {
  if (isCustomFieldListType(type)) return Array.isArray(value) ? value.map((item) => itemDraft(type, item)) : [];
  return itemDraft(type, value);
}

/** Drafts are equal when they would save the same thing (blank list items never save). */
export function sameDraft(left: CustomFieldDraft, right: CustomFieldDraft): boolean {
  const normal = (draft: CustomFieldDraft) =>
    Array.isArray(draft) ? JSON.stringify(draft.filter((item) => item.trim() !== "")) : draft.trim();
  return normal(left) === normal(right);
}

type ItemResult = { ok: true; value: unknown } | { ok: false };

function itemValue(type: CustomFieldType, draft: string, context: CustomFieldCodecContext): ItemResult {
  const text = draft.trim();
  switch (customFieldItemType(type)) {
    case "money": {
      if (!text) return { ok: true, value: null };
      const money = customFieldMoneyFromMajor(text, context);
      return money ? { ok: true, value: money } : { ok: false };
    }
    case "json":
      if (!text) return { ok: true, value: null };
      try {
        return { ok: true, value: JSON.parse(text) as unknown };
      } catch {
        return { ok: false };
      }
    case "boolean":
      return { ok: true, value: text === "" ? null : text === "true" };
    case "date_time": {
      if (!text) return { ok: true, value: null };
      // The two controls can hold a partial draft; never coerce a date alone to midnight.
      const parts = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?$/.exec(text);
      if (!parts || !parseDateOnly(parts[1])) return { ok: false };
      // No offset in the draft: retain the browser's existing local-time conversion.
      const date = new Date(text);
      return Number.isNaN(date.getTime()) ? { ok: false } : { ok: true, value: date.toISOString() };
    }
    case "multi_line_text":
      return { ok: true, value: draft.replace(/\r\n?/g, "\n") };
    default:
      return { ok: true, value: text };
  }
}

/** The value to send (null clears), or null when the draft can't be read as its type (money needs the store currency). */
export function valueFromDraft(type: CustomFieldType, draft: CustomFieldDraft, context: CustomFieldCodecContext): { value: unknown } | null {
  if (Array.isArray(draft)) {
    const items: unknown[] = [];
    for (const item of draft) {
      if (item.trim() === "") continue;
      const parsed = itemValue(type, item, context);
      if (!parsed.ok) return null;
      items.push(parsed.value);
    }
    return { value: items.length > 0 ? items : null };
  }
  const parsed = itemValue(type, draft, context);
  return parsed.ok ? { value: parsed.value } : null;
}

export interface DraftProblem {
  issue: Pick<CustomFieldIssue, "code" | "index" | "limit">;
}

/** What is wrong with a draft for its definition, or null when the API will accept it. */
export function checkDraft(
  definition: { type: CustomFieldType; validations: CustomFieldWireValidations },
  draft: CustomFieldDraft,
  context: CustomFieldCodecContext,
): DraftProblem | null {
  const converted = valueFromDraft(definition.type, draft, context);
  if (converted === null) return { issue: { code: "invalid" } };
  const validations = parseCustomFieldValidations(definition.type, definition.validations, context);
  const parsed = parseCustomFieldValue(
    { type: definition.type, validations: validations.ok ? validations.value : {} },
    converted.value,
    context,
  );
  if (parsed.ok) return null;
  // List items are numbered as the merchant sees them (blank items are skipped).
  const index = parsed.issue.index === undefined || !Array.isArray(draft)
    ? undefined
    : draft.map((item, position) => (item.trim() === "" ? -1 : position)).filter((position) => position >= 0)[parsed.issue.index];
  // A money bound crosses the API in minor units; the merchant reads it in major units, as typed.
  const limit = customFieldItemType(definition.type) === "money" && typeof parsed.issue.limit === "number"
    ? customFieldMoneyMajorText({ amountMinor: parsed.issue.limit, currency: context.currencyCode }, context)
    : parsed.issue.limit;
  return { issue: { code: parsed.issue.code, limit, ...(index === undefined ? {} : { index }) } };
}
