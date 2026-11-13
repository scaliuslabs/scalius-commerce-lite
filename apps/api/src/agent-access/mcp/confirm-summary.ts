// What the owner reads before approving an agent's change: written by the
// platform from the operation's declared schema, never ordered or worded by
// the caller, and kept as DATA: a list of typed rows, each rendered by the
// approval page under its own fixed label, so no value can make a row.
// - `change`: the operation (its registry summary and id);
// - `money`: every money field the input carries (x-scalius-money), as a
//   formatted amount with its ISO currency code, first and never dropped (a
//   long list is summed, not cut);
// - `target`: the records the change names, by id (filters are refused for
//   gated changes: ./confirm.ts filterSelectionOf);
// - `setting`: the change's other numbers, flags and codes;
// - `words`: free text the agent supplied, labelled as its own words;
// - `note`: the platform's own remarks (parts not shown, money fields changed).
// Every text value has control, line-break and Unicode format (direction
// override, zero-width) characters removed and is bounded, visibly cut.
import { AGENT_COMPONENT_SCHEMAS, AGENT_OPERATIONS_BY_ID } from "../../generated/agent-operations.gen";
import { moneyFieldsOf } from "../../openapi/operation-registry/money-fields";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { moneyMarkerOf, type MoneyFieldMarker } from "@scalius/shared/money-field";
import type { ConfirmStep } from "./confirm";
import { countedNoun, isConfirmGated } from "./confirm";
import { containsStepReference } from "./references";

export type SummaryRowKind = "change" | "money" | "target" | "setting" | "words" | "note";

/** One row of an approval summary; the page labels it by `kind`, never by its text. */
export interface SummaryRow {
  kind: SummaryRowKind;
  /** The operation the row belongs to. */
  operationId: string;
  /** The input field it shows (`amount`, `set.*.prices.*.amount`), or null. */
  field: string | null;
  /** The value, cleaned and bounded: a title, ids, a setting's value, the agent's words. */
  text: string;
  /** Money rows: the amount in major units, formatted (`99999.00`). */
  amount?: string;
  /** Money rows: the ISO 4217 code, or null when it cannot be resolved. */
  currency?: string | null;
}

/** The currencies an approval needs that the input alone does not name. */
export interface SummaryCurrencies {
  store?: string;
  /** Keyed by operation id: the order's or market's currency the change is in. */
  byOperation?: Readonly<Record<string, string>>;
}

export const CONFIRM_SUMMARY_MAX_ROWS = 60;
export const SUMMARY_TEXT_MAX = 240;
const LIST_SHOWN = 6;
const SECRET_KEY = /key$|token|secret|password/i;
const ID_KEY = /^(?:id|ids)$|Ids?$/;
const CURRENCY_KEY = /^(?:currency|currencyCode|[a-z]+Currency|[a-z]+CurrencyCode)$/;
/** Control characters, line and paragraph separators, and Unicode format characters (direction overrides, zero-width). */
const UNSAFE_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;

/** A text value as the page may show it: one line, no direction tricks, visibly cut. */
export function cleanSummaryText(value: string, max = SUMMARY_TEXT_MAX): string {
  const text = value.replace(UNSAFE_CHARACTERS, " ").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}… (cut, ${text.length} characters)` : text;
}

interface Leaf {
  /** `body.items.*.unitPriceMinor`: array positions as `*`. */
  path: string;
  value: unknown;
  /** The object holding the value, for a currency named beside it. */
  parent: Record<string, unknown> | null;
}

function leaves(value: unknown, path: string, parent: Record<string, unknown> | null, out: Leaf[]): void {
  if (Array.isArray(value)) {
    if (value.every((item) => item === null || typeof item !== "object")) {
      out.push({ path, value, parent });
      return;
    }
    for (const item of value) leaves(item, `${path}.*`, parent, out);
    return;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const [key, item] of Object.entries(record)) {
      if (item && typeof item === "object") leaves(item, `${path}.${key}`, record, out);
      else out.push({ path: `${path}.${key}`, value: item, parent: record });
    }
    return;
  }
  out.push({ path, value, parent });
}

function keyOf(path: string): string {
  return path.split(".").filter((segment) => segment !== "*").at(-1) ?? path;
}

function namedCurrency(parent: Record<string, unknown> | null): string | null {
  if (!parent) return null;
  for (const [key, value] of Object.entries(parent)) {
    if (CURRENCY_KEY.test(key) && typeof value === "string" && /^[A-Z]{3}$/.test(value)) return value;
  }
  return null;
}

function decimalsOf(code: string | null): number {
  if (!code) return 2;
  try {
    return getDecimalPlaces(code);
  } catch {
    return 2;
  }
}

function currencyOf(marker: MoneyFieldMarker, parent: Record<string, unknown> | null, operationId: string, currencies: SummaryCurrencies): string | null {
  if (marker.currency === "named") return namedCurrency(parent);
  if (marker.currency === "store") return currencies.store ?? null;
  return currencies.byOperation?.[operationId] ?? null;
}

/** An amount in major units, formatted at its currency's decimals. */
function majorText(value: number, unit: MoneyFieldMarker["unit"], code: string | null): string {
  const decimals = decimalsOf(code);
  return (unit === "minor" ? value / 10 ** decimals : value).toFixed(decimals);
}

function fieldLabel(path: string): string {
  return cleanSummaryText(path.replace(/^(?:body|query)\./, ""), 120);
}

function isWords(value: unknown): value is string {
  return typeof value === "string" && (/\s/.test(value) || value.length > 40 || /[^A-Za-z0-9_.:@+-]/.test(value));
}

function scalarText(value: unknown): string {
  if (Array.isArray(value)) {
    const shown = value.slice(0, LIST_SHOWN).map((item) => JSON.stringify(item)).join(", ");
    return value.length > LIST_SHOWN ? `[${shown}, and ${value.length - LIST_SHOWN} more]` : `[${shown}]`;
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

function stepRows(step: ConfirmStep, currencies: SummaryCurrencies): { head: SummaryRow[]; tail: SummaryRow[] } {
  const { operation, input } = step;
  const operationId = operation.operationId;
  const row = (kind: SummaryRowKind, field: string | null, text: string, extra: Partial<SummaryRow> = {}): SummaryRow =>
    ({ kind, operationId, field, text: cleanSummaryText(text), ...extra });
  const entry = AGENT_OPERATIONS_BY_ID[operationId];
  const all: Leaf[] = [];
  if (input.body !== undefined) leaves(input.body, "body", null, all);
  if (input.query) leaves(input.query, "query", null, all);

  const head: SummaryRow[] = [row("change", null, operation.summary || operationId)];
  if (step.changedMoneyFields && step.changedMoneyFields.length > 0) {
    head.push(row("note", null, `Changes money fields: ${step.changedMoneyFields.map((pointer) => pointer.replace(/^\/(?:body|query|path)\//, "").replace(/\//g, ".")).join(", ")}`));
  }

  // Money first, every field the schema declares, whoever ordered the body.
  const shown = new Set<Leaf>();
  const seen = new Set<string>();
  for (const field of entry ? moneyFieldsOf(entry.inputSchema, AGENT_COMPONENT_SCHEMAS) : []) {
    const marker = moneyMarkerOf(field.schema);
    // A field union variants share is one field.
    if (!marker || seen.has(field.path)) continue;
    seen.add(field.path);
    const found = all.filter((leaf) => leaf.path === field.path && leaf.value !== undefined && leaf.value !== null);
    if (found.length === 0) continue;
    found.forEach((leaf) => shown.add(leaf));
    const label = fieldLabel(field.path);
    const code = currencyOf(marker, found[0]!.parent, operationId, currencies);
    const numbers = found.map((leaf) => leaf.value).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    if (numbers.length !== found.length) {
      head.push(row("money", label, `not a number: ${found.map((leaf) => scalarText(leaf.value)).join(", ")}`, { currency: code }));
      continue;
    }
    if (found.length <= LIST_SHOWN) {
      for (const value of numbers) head.push(row("money", label, "", { amount: majorText(value, marker.unit, code), currency: code }));
      continue;
    }
    const total = numbers.reduce((sum, value) => sum + value, 0);
    const text = `${numbers.length} amounts, lowest ${majorText(Math.min(...numbers), marker.unit, code)}, highest ${majorText(Math.max(...numbers), marker.unit, code)}`;
    head.push(row("money", label, text, { amount: majorText(total, marker.unit, code), currency: code }));
  }

  for (const [key, value] of Object.entries(input.path ?? {})) head.push(row("target", key, String(value)));
  const tail: SummaryRow[] = [];
  const byPath = new Map<string, Leaf[]>();
  for (const leaf of all) {
    if (shown.has(leaf) || SECRET_KEY.test(keyOf(leaf.path))) continue;
    byPath.set(leaf.path, [...(byPath.get(leaf.path) ?? []), leaf]);
  }
  for (const [path, found] of byPath) {
    const key = keyOf(path);
    const label = fieldLabel(path);
    const values = found.map((leaf) => leaf.value);
    if (ID_KEY.test(key)) {
      const ids = values.flatMap((value) => Array.isArray(value) ? value : [value]).map(String);
      head.push(row("target", label, ids.length > LIST_SHOWN
        ? `${countedNoun(key, ids.length)}: ${ids.slice(0, LIST_SHOWN).join(", ")}, and ${ids.length - LIST_SHOWN} more`
        : ids.join(", ")));
      continue;
    }
    const textual = values.filter(isWords);
    if (textual.length > 0) {
      for (const text of textual.slice(0, LIST_SHOWN)) tail.push(row("words", label, text));
      if (textual.length > LIST_SHOWN) tail.push(row("note", label, `${textual.length - LIST_SHOWN} more texts in ${label} not shown`));
      continue;
    }
    tail.push(row("setting", label, values.length > LIST_SHOWN
      ? `${values.length} values: ${values.slice(0, 3).map(scalarText).join(", ")}, ...`
      : values.map(scalarText).join(", ")));
  }
  if (containsStepReference(input)) head.push(row("note", null, "Some values come from earlier steps and are not known yet"));
  return { head, tail };
}

/**
 * The approval summary of the gated steps as rows: money and targets first
 * and never dropped, settings and the agent's words after them. Within
 * `CONFIRM_SUMMARY_MAX_ROWS`; rows that do not fit are counted in a note.
 */
export function confirmSummaryRows(steps: readonly ConfirmStep[], currencies: SummaryCurrencies = {}): SummaryRow[] {
  const gated = steps.filter((step) => isConfirmGated(step.operation, step.changedMoneyFields));
  const parts = gated.map((step) => stepRows(step, currencies));
  const head = parts.flatMap((part) => part.head);
  const tail = parts.flatMap((part) => part.tail);
  const room = Math.max(0, CONFIRM_SUMMARY_MAX_ROWS - head.length - 1);
  const rows = [...head, ...tail.slice(0, room)];
  if (tail.length > room) {
    rows.push({ kind: "note", operationId: gated[0]?.operation.operationId ?? "", field: null, text: `${tail.length - room} more settings or texts of the request not shown` });
  }
  return rows;
}

const ROW_LABEL: Record<SummaryRowKind, string> = {
  change: "Change",
  money: "Amount",
  target: "Acts on",
  setting: "Setting",
  words: "The agent's own words (not checked by Scalius)",
  note: "Note",
};

/** The rows as one plain text, for the agent and the CLI (the page renders the rows). */
export function summaryText(rows: readonly SummaryRow[]): string {
  return rows.map((row) => {
    const value = row.kind === "money"
      ? `${row.amount ?? ""} ${row.currency ?? "(currency unknown)"}${row.text ? ` (${row.text})` : ""}`.trim()
      : row.kind === "change" ? `${row.text} (${row.operationId})` : row.text;
    return `${ROW_LABEL[row.kind]}: ${row.field ? `${row.field} ` : ""}${row.kind === "words" ? JSON.stringify(value) : value}`;
  }).join("\n");
}

/** The summary text of the gated steps (rows rendered as lines). */
export function confirmSummary(steps: readonly ConfirmStep[], currencies: SummaryCurrencies = {}): string {
  return summaryText(confirmSummaryRows(steps, currencies));
}
