// What the owner reads before approving an agent's change: written by the
// platform from the operation's declared schema, never ordered or worded by
// the caller. The approval page is the only proof a person approved, so:
// - every money field the input carries (x-scalius-money) comes first, as
//   an amount with its unit and currency, and is never pushed out (a long
//   list is summed instead of cut);
// - then what the change acts on: the records it names, or a filter and how
//   many records it selected when a preview could count them;
// - then the change's settings (numbers, flags, codes);
// - last, free text the agent supplied, quoted and labelled as its own words.
// Nothing material is cut silently: what does not fit is counted.
import { AGENT_COMPONENT_SCHEMAS, AGENT_OPERATIONS_BY_ID } from "../../generated/agent-operations.gen";
import { moneyFieldsOf } from "../../openapi/operation-registry/money-fields";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { moneyMarkerOf, type MoneyFieldMarker } from "@scalius/shared/money-field";
import type { ConfirmStep } from "./confirm";
import { countedNoun, isConfirmGated } from "./confirm";
import { containsStepReference } from "./references";

/** The store currency, to show minor units as an amount. */
export interface SummaryCurrency {
  code: string;
  decimalPlaces: number;
}

export const CONFIRM_SUMMARY_MAX_CHARS = 3_500;
const LIST_SHOWN = 6;
const WORDS_SHOWN = 240;
const SECRET_KEY = /key$|token|secret|password/i;
const ID_KEY = /^(?:id|ids)$|Ids?$/;
const SELECTION_KEY = /^(?:filter|matching)$/;
const CURRENCY_KEY = /^(?:currency|currencyCode|[a-z]+Currency|[a-z]+CurrencyCode)$/;

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
      if (SELECTION_KEY.test(key) && item && typeof item === "object" && !Array.isArray(item)) {
        out.push({ path: `${path}.${key}`, value: item, parent: record });
        continue;
      }
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

function decimalsOf(code: string): number | null {
  try {
    return getDecimalPlaces(code);
  } catch {
    return null;
  }
}

function amountText(value: unknown, marker: MoneyFieldMarker, parent: Record<string, unknown> | null, store?: SummaryCurrency): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return JSON.stringify(value ?? null);
  const named = marker.currency === "named" ? namedCurrency(parent) : null;
  const code = named ?? (marker.currency === "store" ? store?.code : undefined);
  const where = `(${marker.currency} currency)`;
  if (marker.unit === "major") return code ? `${value} ${code}` : `${value} ${where}`;
  const decimals = code ? (code === store?.code ? store.decimalPlaces : decimalsOf(code)) : null;
  return decimals === null || decimals === undefined
    ? `${value} minor units ${where}`
    : `${(value / 10 ** decimals).toFixed(decimals)} ${code} (${value} minor units)`;
}

function scalarText(value: unknown): string {
  if (Array.isArray(value)) {
    const shown = value.slice(0, LIST_SHOWN).map((item) => JSON.stringify(item)).join(", ");
    return value.length > LIST_SHOWN ? `[${shown}, and ${value.length - LIST_SHOWN} more]` : `[${shown}]`;
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** A string an agent wrote in its own words, rather than a code or a flag. */
function isWords(value: unknown): value is string {
  return typeof value === "string" && (/\s/.test(value) || value.length > 40 || /[^A-Za-z0-9_.:@+-]/.test(value));
}

function quoted(text: string): string {
  return text.length > WORDS_SHOWN
    ? `"${text.slice(0, WORDS_SHOWN)}" (cut, ${text.length} characters in all)`
    : `"${text}"`;
}

/** Values of one path, shown in full or, past a few, as a count with totals. */
function moneyLine(path: string, found: Leaf[], marker: MoneyFieldMarker, store?: SummaryCurrency): string {
  const label = path.replace(/^body\./, "").replace(/^query\./, "");
  if (found.length <= LIST_SHOWN) {
    return found.map((leaf) => `${label} ${amountText(leaf.value, marker, leaf.parent, store)}`).join("; ");
  }
  const numbers = found.map((leaf) => leaf.value).filter((value): value is number => typeof value === "number");
  const total = numbers.reduce((sum, value) => sum + value, 0);
  const lowest = Math.min(...numbers);
  const highest = Math.max(...numbers);
  const parent = found[0]!.parent;
  return `${label}: ${found.length} amounts, total ${amountText(total, marker, parent, store)}, lowest ${amountText(lowest, marker, parent, store)}, highest ${amountText(highest, marker, parent, store)}`;
}

function describeStep(step: ConfirmStep, store?: SummaryCurrency): { head: string[]; tail: string[] } {
  const { operation, input } = step;
  const entry = AGENT_OPERATIONS_BY_ID[operation.operationId];
  const title = `${operation.summary || operation.operationId} (${operation.operationId})`;
  const all: Leaf[] = [];
  if (input.body !== undefined) leaves(input.body, "body", null, all);
  if (input.query) leaves(input.query, "query", null, all);

  // Money first, every field the schema declares, whoever ordered the body.
  const moneyPaths = new Map<string, MoneyFieldMarker>();
  for (const field of entry ? moneyFieldsOf(entry.inputSchema, AGENT_COMPONENT_SCHEMAS) : []) {
    const marker = moneyMarkerOf(field.schema);
    if (marker) moneyPaths.set(field.path, marker);
  }
  const money: string[] = [];
  const shown = new Set<Leaf>();
  for (const [path, marker] of moneyPaths) {
    const found = all.filter((leaf) => leaf.path === path && leaf.value !== undefined && leaf.value !== null);
    if (found.length === 0) continue;
    found.forEach((leaf) => shown.add(leaf));
    money.push(moneyLine(path, found, marker, store));
  }

  const targets: string[] = [];
  for (const [key, value] of Object.entries(input.path ?? {})) targets.push(`${key} ${String(value)}`);
  const settings: string[] = [];
  const words: string[] = [];
  const byPath = new Map<string, Leaf[]>();
  for (const leaf of all) {
    if (shown.has(leaf) || SECRET_KEY.test(keyOf(leaf.path))) continue;
    byPath.set(leaf.path, [...(byPath.get(leaf.path) ?? []), leaf]);
  }
  for (const [path, found] of byPath) {
    const key = keyOf(path);
    const label = path.replace(/^body\./, "").replace(/^query\./, "");
    if (SELECTION_KEY.test(key)) {
      const selection = found[0]!.value as Record<string, unknown>;
      const json = JSON.stringify(selection);
      const what = Object.keys(selection).length === 0 ? "every record (no filter)" : `every record matching ${json.length > 400 ? `${json.slice(0, 400)}... (${json.length} characters)` : json}`;
      targets.push(`${what}${step.selectionCount !== undefined ? `: ${step.selectionCount} now` : ", count not known until it runs"}`);
      continue;
    }
    const values = found.map((leaf) => leaf.value);
    if (ID_KEY.test(key)) {
      const ids = values.flatMap((value) => Array.isArray(value) ? value : [value]).map(String);
      targets.push(ids.length > LIST_SHOWN ? `${countedNoun(key, ids.length)} (${ids.slice(0, LIST_SHOWN).join(", ")}, ...)` : `${key} ${ids.join(", ")}`);
      continue;
    }
    const textual = values.filter(isWords);
    if (textual.length > 0) {
      words.push(`${label} ${textual.slice(0, LIST_SHOWN).map(quoted).join(", ")}${textual.length > LIST_SHOWN ? `, and ${textual.length - LIST_SHOWN} more` : ""}`);
      continue;
    }
    if (values.length > LIST_SHOWN) settings.push(`${label}: ${values.length} values (${values.slice(0, 3).map(scalarText).join(", ")}, ...)`);
    else settings.push(`${label}=${values.map(scalarText).join(", ")}`);
  }

  const head = [title];
  if (step.changedMoneyFields && step.changedMoneyFields.length > 0) {
    head.push(`Changes money fields: ${step.changedMoneyFields.map((pointer) => pointer.replace(/^\/body\//, "").replace(/\//g, ".")).join(", ")}`);
  }
  if (money.length > 0) head.push(`Money: ${money.join("; ")}`);
  if (targets.length > 0) head.push(`Acts on: ${targets.join("; ")}`);
  if (containsStepReference(input)) head.push("Some values come from earlier steps and are not known yet");
  const tail: string[] = [];
  if (settings.length > 0) tail.push(`Settings: ${settings.join(", ")}`);
  if (words.length > 0) tail.push(`In the agent's own words (not checked by Scalius): ${words.join("; ")}`);
  return { head, tail };
}

/**
 * The approval summary of the gated steps: money, targets and settings from
 * the schema, the agent's words last. Within `CONFIRM_SUMMARY_MAX_CHARS`;
 * settings and words that do not fit are counted, money and targets never
 * dropped.
 */
export function confirmSummary(steps: readonly ConfirmStep[], options: { storeCurrency?: SummaryCurrency } = {}): string {
  const gated = steps.filter((step) => isConfirmGated(step.operation, step.changedMoneyFields));
  const blocks = gated.map((step) => describeStep(step, options.storeCurrency));
  const intro = gated.length > 1 ? [`${gated.length} changes, approved together:`] : [];
  const render = (keepTail: number) => [
    ...intro,
    ...blocks.map(({ head, tail }) => [...head, ...tail.slice(0, keepTail)].join("\n")),
  ].join("\n\n");
  for (const keep of [2, 1, 0]) {
    const text = render(keep);
    if (text.length <= CONFIRM_SUMMARY_MAX_CHARS) {
      const dropped = blocks.reduce((sum, block) => sum + Math.max(0, block.tail.length - keep), 0);
      return dropped > 0 ? `${text}\n(${dropped} more ${dropped === 1 ? "part" : "parts"} of the request not shown: settings or the agent's words)` : text;
    }
  }
  // Money and targets alone exceed the room: say so rather than cut silently.
  const text = render(0);
  return `${text.slice(0, CONFIRM_SUMMARY_MAX_CHARS - 120)}\n(The request is too large to show in full: ${text.length} characters of money and targets; approve only after checking it with the agent.)`;
}
