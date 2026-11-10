/**
 * The apps' line inputs on cart lines (manifest `checkout.lineInputs`): which
 * input applies to which line, what each line answered, and the lines an
 * answer or a bulk action changes. The cart check is the authority: it names
 * the inputs each line takes (`items[].lineInputs`, the buy form's rule with
 * the per-SKU gate) and their words in the buyer's language. The cart page,
 * the drawer and an island's `context.cart` share this; the controls that
 * draw it load only when some line takes an input (line-input-controls.ts).
 *
 * Answers are buyer content: never put them in URLs, analytics or logs.
 */
import type { AppLineInputDeclaration } from "@scalius/shared/line-properties";
import type { CartLineProperty, VariantCartItem } from "@/store/cart";
import type { CartValidationIssue, CartValidationResult } from "@/lib/api/orders";

/** One app input as a cart line draws it. */
export interface CartLineInputView {
  /** `<app id>.<key>`: what the line's answer is keyed by. */
  key: string;
  appId: string;
  input: AppLineInputDeclaration;
}

/** What the last cart check said about the apps' inputs on the lines. */
export interface CartLineInputFacts {
  /** By `<app id>.<key>`, in the order checkout resolves them (apps by id, then declared order). */
  inputs: Map<string, CartLineInputView>;
  /** The inputs each line takes, by cart key, in that order. */
  byLine: Map<string, string[]>;
  /** By cart key, the app answers the check refused on the line (a decline of an agreement since changed). */
  refused: Map<string, Set<string>>;
}

export const NO_LINE_INPUTS: CartLineInputFacts = { inputs: new Map(), byLine: new Map(), refused: new Map() };

/**
 * The facts from a cart check's answer. A line the check refused for one of
 * its app answers (a choice whose agreement changed: `confirmation_required`
 * on that key) still takes that input, so the buyer can answer it again.
 */
export function cartLineInputFacts(
  validation: Pick<CartValidationResult, "lineInputs" | "items"> | null | undefined,
  issues: readonly CartValidationIssue[] = [],
): CartLineInputFacts {
  const inputs = new Map<string, CartLineInputView>();
  const apps = [...(validation?.lineInputs ?? [])].sort((left, right) => (left.appId < right.appId ? -1 : left.appId > right.appId ? 1 : 0));
  for (const app of apps) {
    for (const input of app.inputs) inputs.set(`${app.appId}.${input.key}`, { key: `${app.appId}.${input.key}`, appId: app.appId, input });
  }
  if (inputs.size === 0) return NO_LINE_INPUTS;
  const order = [...inputs.keys()];
  const byLine = new Map<string, string[]>();
  for (const item of validation?.items ?? []) {
    if (!item.cartKey) continue;
    const keys = (item.lineInputs ?? []).filter((key) => inputs.has(key));
    if (keys.length > 0) byLine.set(item.cartKey, keys);
  }
  const refused = new Map<string, Set<string>>();
  for (const issue of issues) {
    if (!issue.cartKey || !issue.propertyKey || !inputs.has(issue.propertyKey)) continue;
    const keys = new Set([...(byLine.get(issue.cartKey) ?? []), issue.propertyKey]);
    byLine.set(issue.cartKey, order.filter((key) => keys.has(key)));
    refused.set(issue.cartKey, new Set([...(refused.get(issue.cartKey) ?? []), issue.propertyKey]));
  }
  return { inputs, byLine, refused };
}

/** The line's answer to an input, or null when it has none. */
export function lineAnswer(item: Pick<VariantCartItem, "properties">, key: string): CartLineProperty | null {
  return item.properties?.find((property) => property.key === key) ?? null;
}

/** The choice of a select input that needs confirmation, or null. */
export function confirmedChoice(view: CartLineInputView, value: string): { label: string; confirm: NonNullable<NonNullable<AppLineInputDeclaration["options"]>[number]["confirm"]> } | null {
  if (view.input.type !== "select") return null;
  const option = view.input.options?.find((choice) => choice.value === value);
  return option?.confirm ? { label: option.label, confirm: option.confirm } : null;
}

/**
 * The answer a line keeps for `value` ("" or null: none). Its words are what
 * the page shows until the cart check answers its own; a choice that needs
 * confirmation carries the input's revision, which the buyer just agreed to.
 */
export function lineAnswerFor(view: CartLineInputView, value: string | null, checkedText: string): CartLineProperty | null {
  const text = value?.normalize("NFC").trim() ?? "";
  if (!text || (view.input.type === "checkbox" && text !== "true")) return null;
  const option = view.input.type === "select" ? view.input.options?.find((choice) => choice.value === text) : undefined;
  if (view.input.type === "select" && !option) return null;
  return {
    key: view.key,
    value: text,
    label: view.input.label,
    displayValue: option?.label ?? (view.input.type === "checkbox" ? checkedText : text),
    priceMinor: 0,
    ...(view.input.textRevision ? { revision: view.input.textRevision } : {}),
  };
}

/**
 * The line's inputs with one app input answered (or cleared), in checkout's
 * order: the product's own inputs as they were, then the apps' by the order
 * the check gave. The line key hashes this order, so an edited line keeps the
 * key the server answers for it.
 */
export function withLineAnswer(
  item: Pick<VariantCartItem, "properties">,
  key: string,
  answer: CartLineProperty | null,
  facts: CartLineInputFacts,
): CartLineProperty[] {
  const kept = (item.properties ?? []).filter((property) => property.key !== key);
  const next = answer ? [...kept, answer] : kept;
  const order = [...facts.inputs.keys()];
  const rank = (property: CartLineProperty) => {
    const position = order.indexOf(property.key);
    return position === -1 ? -1 : position;
  };
  const own = next.filter((property) => rank(property) === -1);
  const apps = next.filter((property) => rank(property) !== -1).sort((left, right) => rank(left) - rank(right));
  return [...own, ...apps];
}

/** Whether the line's answer to an input is `answer` already (same value and revision). */
export function sameAnswer(current: CartLineProperty | null, answer: CartLineProperty | null): boolean {
  if (!current || !answer) return current === answer;
  return current.value === answer.value && (current.revision ?? null) === (answer.revision ?? null);
}

/**
 * The lines a bulk action changes: `apply` every line the input applies to
 * whose answer is not the value yet; `clear` every line that has an answer.
 */
export function bulkTargets(
  items: Readonly<Record<string, VariantCartItem>>,
  facts: CartLineInputFacts,
  key: string,
  action: "apply" | "clear",
  checkedText: string,
): Array<{ lineKey: string; properties: CartLineProperty[] }> {
  const view = facts.inputs.get(key);
  if (!view) return [];
  const value = action === "apply" ? (view.input.bulk?.apply?.value ?? (view.input.type === "checkbox" ? "true" : null)) : null;
  if (action === "apply" && (!value || confirmedChoice(view, value))) return [];
  const answer = value ? lineAnswerFor(view, value, checkedText) : null;
  const targets: Array<{ lineKey: string; properties: CartLineProperty[] }> = [];
  for (const [lineKey, item] of Object.entries(items)) {
    const current = lineAnswer(item, key);
    const applies = facts.byLine.get(lineKey)?.includes(key) ?? false;
    if (action === "apply" ? applies && !sameAnswer(current, answer) : current !== null) {
      targets.push({ lineKey, properties: withLineAnswer(item, key, answer, facts) });
    }
  }
  return targets;
}

/** The bulk actions to offer now, per input that declares them: each only when it would change a line. */
export function bulkActions(
  items: Readonly<Record<string, VariantCartItem>>,
  facts: CartLineInputFacts,
  checkedText: string,
): Array<{ view: CartLineInputView; apply: boolean; clear: boolean }> {
  const actions: Array<{ view: CartLineInputView; apply: boolean; clear: boolean }> = [];
  for (const view of facts.inputs.values()) {
    const bulk = view.input.bulk;
    if (!bulk) continue;
    const apply = Boolean(bulk.apply) && bulkTargets(items, facts, view.key, "apply", checkedText).length > 0;
    const clear = Boolean(bulk.clear) && bulkTargets(items, facts, view.key, "clear", checkedText).length > 0;
    if (apply || clear) actions.push({ view, apply, clear });
  }
  return actions;
}

/** One line's input that needs a decision and has no answer. */
export interface UndecidedLineInput {
  lineKey: string;
  key: string;
}

/**
 * The lines' inputs checkout needs answered (`decision`) that have none, in
 * cart order then checkout's input order: what Place order asks about. With
 * `appId`, only that app's inputs (an island's own).
 */
export function undecidedLineInputs(
  items: Readonly<Record<string, Pick<VariantCartItem, "properties">>>,
  facts: CartLineInputFacts,
  appId?: string,
): UndecidedLineInput[] {
  const undecided: UndecidedLineInput[] = [];
  for (const [lineKey, item] of Object.entries(items)) {
    for (const key of facts.byLine.get(lineKey) ?? []) {
      const view = facts.inputs.get(key);
      if (!view?.input.decision || (appId !== undefined && view.appId !== appId) || lineAnswer(item, key)) continue;
      undecided.push({ lineKey, key });
    }
  }
  return undecided;
}

/**
 * The lines that need the buyer before checkout: an undecided input that
 * needs a decision, or an app answer the check refused (a decline of an
 * agreement since changed). Each must be visible and editable without
 * unfolding anything.
 */
export function linesNeedingDecision(
  items: Readonly<Record<string, Pick<VariantCartItem, "properties">>>,
  facts: CartLineInputFacts,
): string[] {
  const needed = new Set([...undecidedLineInputs(items, facts).map((entry) => entry.lineKey), ...facts.refused.keys()]);
  return Object.keys(items).filter((lineKey) => needed.has(lineKey));
}

/** What proceeding with undecided lines takes: the agreements to ask once, and each line's answers after it. */
export interface ProceedPlan {
  /** Each input's choice to agree to, once, with the lines it goes on. */
  agreements: Array<{ view: CartLineInputView; confirm: NonNullable<NonNullable<AppLineInputDeclaration["options"]>[number]["confirm"]>; lineKeys: string[] }>;
  /** Each undecided line with its inputs answered by their `proceedWith` choice. */
  edits: Array<{ lineKey: string; properties: CartLineProperty[] }>;
}

/**
 * The plan for `undecided`, or the first entry no choice can answer (an
 * input without `proceedWith`: the buyer must choose it on the line).
 */
export function proceedPlan(
  items: Readonly<Record<string, VariantCartItem>>,
  facts: CartLineInputFacts,
  undecided: readonly UndecidedLineInput[],
  checkedText: string,
): { plan: ProceedPlan } | { blocked: UndecidedLineInput } {
  const agreements = new Map<string, ProceedPlan["agreements"][number]>();
  const lines = new Map<string, CartLineProperty[]>();
  for (const entry of undecided) {
    const view = facts.inputs.get(entry.key);
    const item = items[entry.lineKey];
    const value = view?.input.decision?.proceedWith;
    const choice = view && value ? confirmedChoice(view, value) : null;
    const answer = view && value ? lineAnswerFor(view, value, checkedText) : null;
    if (!view || !item || !choice || !answer) return { blocked: entry };
    const agreement = agreements.get(entry.key) ?? { view, confirm: choice.confirm, lineKeys: [] };
    if (!agreement.lineKeys.includes(entry.lineKey)) agreement.lineKeys.push(entry.lineKey);
    agreements.set(entry.key, agreement);
    lines.set(entry.lineKey, withLineAnswer({ properties: lines.get(entry.lineKey) ?? item.properties }, entry.key, answer, facts));
  }
  return { plan: { agreements: [...agreements.values()], edits: [...lines].map(([lineKey, properties]) => ({ lineKey, properties })) } };
}
