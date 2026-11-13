// What a person reads before approving an AI assistant's change, in the
// dashboard's language: one sentence for what it wants to do, then each fact
// under a label the dashboard words (never the input's field name), money in
// its currency with its symbol, percentages as percentages, yes/no as words
// and listed values by their labels. Anything this cannot put in words is
// listed in `undescribed`, and the page does not offer Approve for it
// (approval-census.test.ts holds every operation that can ask to the
// vocabulary, in English and Bangla).
import { approvalFieldKey, approvalFieldParentKey } from "@scalius/shared/agent-approval";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { formatNumber as formatNumberIn, numberLocale } from "@scalius/shared/locale-format";
import type { PermissionName } from "@scalius/core/auth/rbac/types";
import { translate, type Locale } from "~/i18n";
import { APPROVAL_ACTIONS } from "~/i18n/agent-approval-actions";
import { APPROVAL_FIELDS } from "~/i18n/agent-approval-fields";
import { APPROVAL_VALUES } from "~/i18n/agent-approval-values";
import { notificationEventMessages } from "~/i18n/notification-events";
import { aiAccessMessages } from "~/i18n/settings-ai-access";
import { permissionMessages } from "~/i18n/settings-users";
import { webhookTopicMessages } from "~/i18n/settings-webhooks";
import { formatSavedMajorAmount } from "~/lib/order-money-format";
import { getStoreRegion } from "~/lib/store-time-zone";

/** One row of what the change does, as the platform wrote it from the operation's schema. */
export interface ChangeRow {
  kind: "change" | "money" | "target" | "setting" | "words" | "note";
  operationId: string;
  field: string | null;
  text: string;
  amount?: string;
  currency?: string | null;
  /** A string, number, boolean or null (the API's contract types it loosely). */
  value?: unknown;
  type?: "enum" | "text" | "number" | "boolean" | "id" | "empty";
  code?: "more_values" | "more_texts" | "more_rows" | "money_field" | "step_reference" | "body_not_shown";
  count?: number;
}

/** One fact the page shows: its label and its value, in words. */
export interface ApprovalLine {
  kind: "money" | "setting" | "words" | "target" | "note";
  label: string;
  value: string;
}

export interface ApprovalDescription {
  /** What the assistant wants to do, one phrase per operation ("refund money on an order"). */
  actions: string[];
  lines: ApprovalLine[];
  /** What could not be put in words (fields, values, operations): the change cannot be approved here. */
  undescribed: string[];
}

/** Fields whose number is a percentage: hundredths of a percent, or the percent itself. */
const BASIS_POINT_FIELDS = new Set(["basisPoints", "rateBps"]);
const PERCENT_FIELDS = new Set(["percent", "feePercentage", "discountPercentage", "priceAdjustmentPercent"]);
const CURRENCY_FIELDS = new Set(["currency", "currencyCode", "budgetCurrency"]);
const COUNTRY_FIELDS = new Set(["countryCode", "countries", "shippingCountryCode", "billingCountryCode"]);
const LANGUAGE_FIELDS = new Set(["language", "locale"]);
/** Ids of records the page names by the name staff know them by (the "Affects" list), not as a row. */
const NAMED_TARGET_KEYS = new Set([
  "id", "ids", "productId", "productIds", "variantId", "variantIds", "orderId", "orderIds", "customerId", "customerIds",
  "categoryId", "categoryIds", "collectionIds", "userId", "staffMemberId",
]);

function hasOwn(record: Readonly<Record<string, string>>, key: string): key is keyof typeof record {
  return Object.hasOwn(record, key);
}

function displayName(locale: Locale, type: "currency" | "region" | "language", code: string): string | null {
  try {
    return new Intl.DisplayNames([locale], { type, fallback: "none" }).of(code) ?? null;
  } catch {
    return null;
  }
}

/** The label of a field path, or null when the vocabulary has none. */
export function approvalFieldLabel(field: string, locale: Locale): string | null {
  const labels = APPROVAL_FIELDS[locale];
  const parent = approvalFieldParentKey(field);
  if (parent && hasOwn(labels, parent)) return labels[parent]!;
  const key = approvalFieldKey(field);
  return hasOwn(labels, key) ? labels[key]! : null;
}

/** A listed value in words, or null when the vocabulary has none. */
export function approvalValueLabel(field: string, value: string, locale: Locale): string | null {
  const key = approvalFieldKey(field);
  switch (key) {
    case "event":
      return hasOwn(notificationEventMessages.en, value) ? translate(notificationEventMessages, value as keyof typeof notificationEventMessages.en, undefined, locale) : null;
    case "topics":
      return hasOwn(webhookTopicMessages.en, value) ? translate(webhookTopicMessages, value as keyof typeof webhookTopicMessages.en, undefined, locale) : null;
    case "permission":
    case "permissions":
      return hasOwn(permissionMessages.en, value) ? translate(permissionMessages, value as PermissionName, undefined, locale) : null;
    case "preset":
      return hasOwn(aiAccessMessages.en, `preset_${value}`) ? translate(aiAccessMessages, `preset_${value}` as keyof typeof aiAccessMessages.en, undefined, locale) : null;
  }
  // A code the language has no name for (XDR) is shown as the code staff know it by.
  if (CURRENCY_FIELDS.has(key) && /^[A-Z]{3}$/.test(value)) return displayName(locale, "currency", value) ?? value;
  if (COUNTRY_FIELDS.has(key) && /^[A-Z]{2}$/.test(value)) return displayName(locale, "region", value) ?? value;
  if (LANGUAGE_FIELDS.has(key) && /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value)) return displayName(locale, "language", value) ?? value;
  const values = APPROVAL_VALUES[locale];
  const parent = approvalFieldParentKey(field);
  if (parent && hasOwn(values, `${parent}=${value}`)) return values[`${parent}=${value}`]!;
  return hasOwn(values, `${key}=${value}`) ? values[`${key}=${value}`]! : null;
}

/** "Changes" a person reads: every row of the change, worded, and what could not be. */
export function describeApproval(rows: readonly ChangeRow[], locale: Locale, hasNamedTargets: boolean): ApprovalDescription {
  const t = (key: keyof typeof aiAccessMessages.en, vars?: Record<string, string | number>) => translate(aiAccessMessages, key, vars, locale);
  const number = (value: number, options?: Intl.NumberFormatOptions) => formatNumberIn(value, numberLocale(locale, getStoreRegion()), options);
  const actions: string[] = [];
  const lines: ApprovalLine[] = [];
  const undescribed: string[] = [];
  const label = (field: string | null): string => {
    if (!field) return t("changeRowNote");
    const found = approvalFieldLabel(field, locale);
    if (found === null) undescribed.push(`field ${field}`);
    return found ?? t("changeFieldUnknown");
  };

  for (const row of rows) {
    switch (row.kind) {
      case "change": {
        const action = APPROVAL_ACTIONS[locale][row.operationId];
        if (action) actions.push(action);
        else undescribed.push(`operation ${row.operationId}`);
        break;
      }
      case "money": {
        const amount = Number(row.amount);
        if (!row.amount || !Number.isFinite(amount)) {
          undescribed.push(`amount ${row.field ?? ""}`);
          lines.push({ kind: "money", label: label(row.field), value: t("changeFieldUnknown") });
          break;
        }
        const code = row.currency ?? null;
        const money = code
          ? formatSavedMajorAmount(amount, { currencyCode: code, decimalPlaces: safeDecimals(code) }, number)
          : `${number(amount)} ${t("changeCurrencyUnknown")}`;
        lines.push({
          kind: "money",
          label: label(row.field),
          value: row.count ? t("changeMoneyTotal", { amount: money, count: row.count }) : money,
        });
        break;
      }
      case "target": {
        const key = row.field ? approvalFieldKey(row.field) : "";
        // The records named below by the names staff know them by.
        if (hasNamedTargets && NAMED_TARGET_KEYS.has(key)) break;
        const named = typeof row.value === "string" && row.field ? approvalValueLabel(row.field, row.value, locale) : null;
        lines.push({
          kind: "target",
          label: label(row.field),
          value: named ?? t("changeRecords", { count: typeof row.value === "number" ? row.value : 1 }),
        });
        break;
      }
      case "words":
        lines.push({ kind: "words", label: label(row.field), value: typeof row.value === "string" ? row.value : row.text });
        break;
      case "setting":
        lines.push({ kind: "setting", label: label(row.field), value: settingValue(row) });
        break;
      case "note":
        lines.push({ kind: "note", label: t("changeRowNote"), value: noteValue(row) });
        break;
    }
  }
  return { actions, lines, undescribed };

  function settingValue(row: ChangeRow): string {
    const field = row.field ?? "";
    const key = approvalFieldKey(field);
    const value = row.value === undefined ? row.text : row.value;
    if (value === null || value === "" || row.type === "empty") return t("changeValueNone");
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      undescribed.push(`value ${field}`);
      return t("changeFieldUnknown");
    }
    if (typeof value === "boolean") return t(value ? "changeYes" : "changeNo");
    if (typeof value === "number") {
      if (BASIS_POINT_FIELDS.has(key)) return number(value / 10_000, { style: "percent", maximumFractionDigits: 2 });
      if (PERCENT_FIELDS.has(key)) return number(value / 100, { style: "percent", maximumFractionDigits: 2 });
      return number(value);
    }
    const worded = approvalValueLabel(field, value, locale);
    if (worded !== null) return worded;
    if (row.type === "enum") {
      undescribed.push(`value ${field}=${value}`);
      return t("changeFieldUnknown");
    }
    return value;
  }

  function noteValue(row: ChangeRow): string {
    const count = row.count ?? 0;
    switch (row.code) {
      case "more_values": return t("changeNoteMoreValues", { count, field: row.field ? label(row.field) : "" });
      case "more_texts": return t("changeNoteMoreTexts", { count, field: row.field ? label(row.field) : "" });
      case "more_rows": return t("changeNoteMoreRows", { count });
      case "money_field": return t("changeNoteMoneyField", { field: row.field ? label(row.field) : "" });
      case "step_reference": return t("changeNoteStepReference");
      case "body_not_shown":
        // Data a person cannot read cannot be approved.
        undescribed.push("body");
        return t("changeNoteBodyNotShown");
      default:
        undescribed.push("note");
        return t("changeFieldUnknown");
    }
  }
}

function safeDecimals(code: string): number {
  try {
    return getDecimalPlaces(code);
  } catch {
    return 2;
  }
}
