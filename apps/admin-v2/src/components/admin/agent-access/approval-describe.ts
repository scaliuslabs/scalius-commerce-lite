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
import { dateLocale, formatDateTime as formatDateTimeIn, formatNumber as formatNumberIn, numberLocale } from "@scalius/shared/locale-format";
import type { PermissionName } from "@scalius/core/auth/rbac/types";
import { formatList } from "@scalius/shared/locale-words";
import { translate, type Locale } from "~/i18n";
import { APPROVAL_ACTIONS } from "~/i18n/agent-approval-actions";
import { APPROVAL_FIELDS } from "~/i18n/agent-approval-fields";
import { APPROVAL_VALUES } from "~/i18n/agent-approval-values";
import { notificationEventMessages } from "~/i18n/notification-events";
import { aiAccessMessages } from "~/i18n/settings-ai-access";
import { permissionMessages } from "~/i18n/settings-users";
import { webhookTopicMessages } from "~/i18n/settings-webhooks";
import { formatSavedMajorAmount } from "~/lib/order-money-format";
import { getStoreRegion, getStoreTimeZone } from "~/lib/store-time-zone";
import { orderNumberText } from "~/lib/order-number";
import { orderMessages, paymentMethodLabel } from "~/i18n/orders";
import type { ChangeTarget } from "./ChangeApprovalDetails";

/** One row of what the change does, as the platform wrote it from the operation's schema. */
export interface ChangeRow {
  kind: "change" | "money" | "target" | "setting" | "words" | "note";
  operationId: string;
  field: string | null;
  text: string;
  amount?: string;
  currency?: string | null;
  /** Every value the field carries: strings, numbers, booleans or null (the API's contract types them loosely). */
  values?: unknown[];
  type?: "enum" | "text" | "number" | "boolean" | "id" | "empty" | "masked";
  code?: "money_field" | "step_reference" | "body_not_shown";
  count?: number;
  /** A target row: the kind of record its ids name (named in `targets`), or `part` for a part of the record the change edits. */
  record?: string;
  /** A list's rows (an order's items): each value's entry, so the page shows one line per entry. */
  entries?: number[];
}

/** One fact the page shows: its label and its value, in words. */
export interface ApprovalLine {
  kind: "money" | "setting" | "words" | "target" | "note" | "entry";
  label: string;
  value: string;
}

export interface ApprovalDescription {
  /** What the assistant wants to do, one phrase per operation ("refund money on an order"). */
  actions: string[];
  lines: ApprovalLine[];
  /** What could not be put in words or shown in full (fields, values, operations, rows): the change cannot be approved. */
  undescribed: string[];
  /** Why, in words, once per reason. */
  reasons: string[];
}

/** Fields whose number is a percentage: hundredths of a percent, or the percent itself. */
const BASIS_POINT_FIELDS = new Set(["basisPoints", "rateBps"]);
const PERCENT_FIELDS = new Set(["percent", "feePercentage", "discountPercentage", "priceAdjustmentPercent"]);
const CURRENCY_FIELDS = new Set(["currency", "currencyCode", "budgetCurrency"]);
const COUNTRY_FIELDS = new Set(["countryCode", "countries", "shippingCountryCode", "billingCountryCode"]);
const LANGUAGE_FIELDS = new Set(["language", "locale"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

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

/** What a role may do, in words: "can View products, Adjust stock and Process refunds". */
export function rolePermissionsText(permissions: readonly string[], locale: Locale): string {
  const t = (key: keyof typeof aiAccessMessages.en, vars?: Record<string, string | number>) => translate(aiAccessMessages, key, vars, locale);
  if (permissions.length === 0) return t("changeRoleNothing");
  const words = permissions.map((permission) => hasOwn(permissionMessages.en, permission)
    ? translate(permissionMessages, permission as PermissionName, undefined, locale)
    : permission);
  return t("changeRoleCan", { permissions: formatList(words, locale) });
}

/** Records whose name is the text staff typed when it names no record (a place typed, not picked). */
const TYPED_WHEN_UNKNOWN = new Set(["place"]);

/** A record named on the page: its stored name, else its id; with its id beside a name so two alike can be told apart. */
export function recordText(name: string | null, id: string): string {
  return name ? `${name} (${id})` : id;
}

/**
 * A record as staff know it, or null when it has no name: an order by its
 * number, a payment by its amount and method, a chargeback by its amount,
 * anything else by its stored name.
 */
export function targetRecordName(kind: ChangeTarget["kind"], record: ChangeTarget["records"][number], locale: Locale): string | null {
  const t = (key: keyof typeof aiAccessMessages.en, vars?: Record<string, string | number>) => translate(aiAccessMessages, key, vars, locale);
  const number = (value: number, options?: Intl.NumberFormatOptions) => formatNumberIn(value, numberLocale(locale, getStoreRegion()), options);
  const amount = record.amount && record.currency && Number.isFinite(Number(record.amount))
    ? formatSavedMajorAmount(Number(record.amount), { currencyCode: record.currency, decimalPlaces: safeDecimals(record.currency) }, number)
    : null;
  if (kind === "payment" && amount) {
    const method = record.name ? paymentMethodLabel((key, vars) => translate(orderMessages, key, vars, locale), record.name, null) : "";
    return t("targetPaymentName", { amount, method });
  }
  if (kind === "dispute" && amount) return t("targetDisputeName", { amount });
  if (record.name === null) return null;
  return kind === "order" ? orderNumberText(record.name) : record.name;
}

/**
 * "Changes" a person reads: every row of the change, worded, and what could
 * not be. `targets` are the records the change acts on, named: a row of ids
 * all named there is shown there; any other id is shown in its row, by name
 * when it is named, else as the id itself.
 */
export function describeApproval(rows: readonly ChangeRow[], locale: Locale, targets: readonly ChangeTarget[]): ApprovalDescription {
  const t = (key: keyof typeof aiAccessMessages.en, vars?: Record<string, string | number>) => translate(aiAccessMessages, key, vars, locale);
  const number = (value: number, options?: Intl.NumberFormatOptions) => formatNumberIn(value, numberLocale(locale, getStoreRegion()), options);
  const list = (items: readonly string[]) => formatList(items, locale);
  const actions: string[] = [];
  const lines: ApprovalLine[] = [];
  const undescribed: string[] = [];
  const reasons = new Set<string>();
  const cannot = (what: string, why: keyof typeof aiAccessMessages.en) => {
    undescribed.push(what);
    reasons.add(t(why));
  };
  const recordsOf = new Map(targets.map((target) => [target.kind as string, new Map(target.records.map((record) => [record.id, record]))]));
  const named = new Map(targets.flatMap((target) => target.records.map((record) => [record.id, targetRecordName(target.kind, record, locale)] as const)));
  /** An id as the page shows it: a listed value's label, a record's name with its id, or the id (a part's, or one it cannot name). */
  const idWords = (row: ChangeRow, id: string): string => {
    const worded = row.field ? approvalValueLabel(row.field, id, locale) : null;
    if (worded) return worded;
    const name = row.record && row.record !== "part" ? named.get(id) ?? null : null;
    return recordText(name, id);
  };
  const label = (field: string | null): string => {
    if (!field) return t("changeRowNote");
    const found = approvalFieldLabel(field, locale);
    if (found === null) cannot(`field ${field}`, "changeWhyNoWords");
    return found ?? t("changeFieldUnknown");
  };

  /** The row each line was made from, so a list's rows can give way to its entries' lines. */
  const madeFrom: ChangeRow[] = [];
  for (const row of rows) {
    const values = row.values ?? [];
    const before = lines.length;
    describeRow(row, values);
    for (let index = before; index < lines.length; index += 1) madeFrom[index] = row;
  }
  return { actions, lines: withEntryLines(rows, lines), undescribed, reasons: [...reasons] };

  function describeRow(row: ChangeRow, values: readonly unknown[]): void {
    switch (row.kind) {
      case "change": {
        const action = APPROVAL_ACTIONS[locale][row.operationId];
        if (action) actions.push(action);
        else cannot(`operation ${row.operationId}`, "changeWhyNoWords");
        break;
      }
      case "money": {
        const amount = Number(row.amount);
        const code = row.currency ?? null;
        if (!row.amount || !Number.isFinite(amount) || !code) {
          // An amount without its currency, or not an amount at all, cannot be read for what it is.
          cannot(`amount ${row.field ?? ""}`, "changeWhyMoney");
          lines.push({ kind: "money", label: label(row.field), value: row.amount && Number.isFinite(amount) ? `${number(amount)} ${t("changeCurrencyUnknown")}` : t("changeFieldUnknown") });
          break;
        }
        const money = formatSavedMajorAmount(amount, { currencyCode: code, decimalPlaces: safeDecimals(code) }, number);
        lines.push({
          kind: "money",
          label: label(row.field),
          value: row.count ? t("changeMoneyTotal", { amount: money, count: row.count }) : money,
        });
        break;
      }
      case "target": {
        const ids = values.map((value) => String(value));
        if (ids.length === 0) {
          cannot(`records ${row.field ?? ""}`, "changeWhyNoWords");
          break;
        }
        const records = row.record && row.record !== "part" ? recordsOf.get(row.record) : undefined;
        if (row.record === "role") {
          for (const id of ids) if (records?.get(id)?.name && !records.get(id)!.permissions) cannot(`role ${id}`, "changeWhyRole");
        }
        const unnamed = row.record === "part" ? [] : ids.filter((id) => !records?.get(id)?.name);
        // A record of a kind the page cannot name, or one with no name (gone, or not of that kind):
        // the change cannot be approved as named (the approve call refuses it too).
        if (unnamed.length > 0 && !TYPED_WHEN_UNKNOWN.has(row.record ?? "")) cannot(`records ${row.field ?? ""}`, "changeWhyUnnamed");
        // Every id named in "Affects" below: shown there, once (a list's entries show in their lines).
        if (row.record !== "part" && unnamed.length === 0 && !row.entries) break;
        lines.push({ kind: "target", label: label(row.field), value: list(ids.map((id) => idWords(row, id))) });
        break;
      }
      case "words":
        lines.push({ kind: "words", label: label(row.field), value: typeof values[0] === "string" ? values[0] : row.text });
        break;
      case "setting":
        lines.push({ kind: "setting", label: label(row.field), value: settingValue(row, values) });
        break;
      case "note":
        lines.push({ kind: "note", label: t("changeRowNote"), value: noteValue(row) });
        break;
    }
  }

  /**
   * A list's rows (an order's items: product, SKU, quantity, price) as one
   * line per entry, never parallel lists joined with "and": the lines made
   * from rows with `entries` give way to an entry's line, in the first one's place.
   */
  function withEntryLines(source: readonly ChangeRow[], made: ApprovalLine[]): ApprovalLine[] {
    const grouped = source.filter((row) => row.entries && row.entries.length === (row.kind === "money" ? 1 : (row.values ?? []).length));
    if (grouped.length === 0) return made;
    const entryNumbers = [...new Set(grouped.flatMap((row) => row.entries!))].sort((a, b) => a - b);
    const entryLines: ApprovalLine[] = entryNumbers.map((entry) => ({
      kind: "entry",
      label: t("changeEntry", { n: number(entry + 1) }),
      value: grouped.flatMap((row) => {
        const at = row.entries!.flatMap((value, index) => value === entry ? [index] : []);
        if (at.length === 0) return [];
        const fieldLabel = row.field ? approvalFieldLabel(row.field, locale) ?? t("changeFieldUnknown") : t("changeRowNote");
        if (row.kind === "money") {
          const amount = Number(row.amount);
          const code = row.currency ?? null;
          return [`${fieldLabel}: ${code && Number.isFinite(amount) ? formatSavedMajorAmount(amount, { currencyCode: code, decimalPlaces: safeDecimals(code) }, number) : t("changeFieldUnknown")}`];
        }
        const values = at.map((index) => (row.values ?? [])[index]);
        const shown = row.kind === "target"
          ? values.map((value) => idWords(row, String(value)))
          : values.map((value) => oneValue(row.field ?? "", value, row.type));
        return [`${fieldLabel}: ${list(shown)}`];
      }).join(" · "),
    }));
    // The lines the grouped rows made give way to the entries' lines, where the first of them stood.
    const fromGroup = new Set(grouped);
    const isGroupedLine = (_line: ApprovalLine, index: number) => fromGroup.has(madeFrom[index]!);
    const first = made.findIndex(isGroupedLine);
    const kept = made.filter((line, index) => !isGroupedLine(line, index));
    const at = first < 0 ? kept.length : made.slice(0, first).length;
    return [...kept.slice(0, at), ...entryLines, ...kept.slice(at)];
  }

  function oneValue(field: string, value: unknown, type: ChangeRow["type"]): string {
    const key = approvalFieldKey(field);
    if (value === null || value === undefined || value === "") return t("changeValueNone");
    if (type === "masked") return typeof value === "string" && value ? t("changeSecretEnding", { tail: value }) : t("changeSecret");
    if (typeof value === "boolean") return t(value ? "changeYes" : "changeNo");
    if (typeof value === "number") {
      if (BASIS_POINT_FIELDS.has(key)) return number(value / 10_000, { style: "percent", maximumFractionDigits: 2 });
      if (PERCENT_FIELDS.has(key)) return number(value / 100, { style: "percent", maximumFractionDigits: 2 });
      return number(value);
    }
    if (typeof value !== "string") {
      cannot(`value ${field}`, "changeWhyNoWords");
      return t("changeFieldUnknown");
    }
    const worded = approvalValueLabel(field, value, locale);
    if (worded !== null) return worded;
    // A date or an instant, in the dashboard's language and the store's time zone.
    if (ISO_DATE.test(value) && Number.isFinite(Date.parse(value))) {
      return formatDateTimeIn(new Date(value), dateLocale(locale, getStoreRegion()), {
        timeZone: getStoreTimeZone(),
        dateStyle: "medium",
        ...(value.length > 10 ? { timeStyle: "short", ...(locale === "bn" ? { hourCycle: "h23" as const } : {}) } : {}),
      });
    }
    if (type === "enum") {
      cannot(`value ${field}=${value}`, "changeWhyNoWords");
      return t("changeFieldUnknown");
    }
    return value;
  }

  function settingValue(row: ChangeRow, values: readonly unknown[]): string {
    const field = row.field ?? "";
    if (values.length === 0 || row.type === "empty") return t("changeValueNone");
    return list(values.map((value) => oneValue(field, value, row.type)));
  }

  function noteValue(row: ChangeRow): string {
    switch (row.code) {
      case "money_field": return t("changeNoteMoneyField", { field: row.field ? label(row.field) : "" });
      case "step_reference":
        cannot("step", "changeWhyLater");
        return t("changeNoteStepReference");
      case "body_not_shown":
        // Data a person cannot read cannot be approved.
        cannot("body", "changeWhyBody");
        return t("changeNoteBodyNotShown");
      default:
        cannot("note", "changeWhyNoWords");
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
