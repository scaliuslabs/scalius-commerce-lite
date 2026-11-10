/**
 * The apps' line inputs on the no-script checkout (`/checkout/quick`): each
 * line draws every app input it takes (the cart check's answer, the same rule
 * as the cart page), as plain form fields posted with the next step. A choice
 * that needs confirmation is taken only with its tick box: chosen without it,
 * the page shows the agreement with a required "I agree" box and keeps the
 * line's earlier answer (and does not place the order) until it is ticked.
 * An input that needs a decision (`decision`) left unanswered on a line keeps
 * the order from being placed: the line's field is marked, and an input with
 * a `proceedWith` choice shows its agreement once with a tick box
 * (`QUICK_LINE_PROCEED_FIELD`) that, ticked, sets that choice on every line
 * still undecided. The API refuses such an order too (`decision_required`).
 * Text, choices and ticks only: a file is uploaded on the product page.
 */
import type { CartValidationRequestItem, CartValidationResult } from "@/lib/api/orders";
import type { CartLineProperty } from "@/store/cart";
import { parseRequestProperties } from "./tax-quote-contract";
import {
  cartLineInputFacts,
  confirmedChoice,
  lineAnswer,
  lineAnswerFor,
  sameAnswer,
  undecidedLineInputs,
  withLineAnswer,
  type CartLineInputFacts,
  type CartLineInputView,
} from "@/lib/cart/line-inputs";

/** `lineInput.<line position>.<app id>.<key>`: an answer. */
export const QUICK_LINE_INPUT_FIELD = "lineInput";
/** `lineInputAgree.<line position>.<app id>.<key>` = "true": the buyer ticked "I agree". */
export const QUICK_LINE_AGREE_FIELD = "lineInputAgree";
/** `lineInputProceed.<app id>.<key>` = "true": the buyer agreed to the input's `proceedWith` choice for every undecided line. */
export const QUICK_LINE_PROCEED_FIELD = "lineInputProceed";

export interface QuickLineInputField {
  /** The form field's name (`QUICK_LINE_INPUT_FIELD`). */
  name: string;
  /** The tick box's name, for a choice that needs confirmation (`QUICK_LINE_AGREE_FIELD`). */
  agreeName: string;
  view: CartLineInputView;
  /** What the field shows: the posted choice waiting for its tick, else the line's answer. */
  value: string;
  /** A choice chosen without its tick: its agreement, drawn with a required tick box. */
  pending: { text: string; agree?: string } | null;
  /** The input needs a decision and the line has none yet. */
  undecided: boolean;
}

/** An input's `proceedWith` agreement, offered once for every line still undecided on it. */
export interface QuickLineProceed {
  /** The tick box's name (`QUICK_LINE_PROCEED_FIELD`). */
  name: string;
  view: CartLineInputView;
  confirm: { text: string; title?: string; agree?: string };
  /** The positions of the lines it would answer. */
  positions: number[];
}

export interface QuickLineInputs {
  /** The lines (`cartItems` JSON) with every answer the buyer gave applied. */
  cartItems: string;
  /** By line position: the inputs to draw. */
  fields: Map<number, QuickLineInputField[]>;
  /** Some choice waits for its tick: the order is not placed yet. */
  pendingConfirm: boolean;
  /** Some line leaves an input that needs a decision unanswered: the order is not placed yet. */
  undecided: boolean;
  /** The agreements that would decide the undecided lines. */
  proceed: QuickLineProceed[];
}

type StoredLine = { id?: unknown; variantId?: unknown; quantity?: unknown; properties?: CartLineProperty[] } & Record<string, unknown>;

/** The posted lines as the cart check takes them. */
export function quickCheckoutCheckItems(cartItems: string): CartValidationRequestItem[] {
  try {
    const lines = JSON.parse(cartItems) as Record<string, StoredLine>;
    return Object.entries(lines).flatMap(([cartKey, line]) => {
      if (typeof line?.id !== "string" || typeof line.variantId !== "string" || typeof line.quantity !== "number") return [];
      let properties: CartValidationRequestItem["properties"];
      try {
        properties = parseRequestProperties(line.properties);
      } catch {
        properties = undefined;
      }
      return [{ cartKey, productId: line.id, variantId: line.variantId, quantity: line.quantity, ...(properties ? { properties } : {}) }];
    });
  } catch {
    return [];
  }
}

/** Applies the posted answers (`QUICK_LINE_INPUT_FIELD`) to the lines, by the cart check's facts. */
export function applyQuickCheckoutLineInputs(
  cartItems: string,
  posted: Pick<FormData, "get" | "getAll">,
  validation: Pick<CartValidationResult, "lineInputs" | "items" | "issues"> | null,
  checkedText: string,
): QuickLineInputs {
  const facts: CartLineInputFacts = cartLineInputFacts(validation, validation?.issues ?? []);
  const fields = new Map<number, QuickLineInputField[]>();
  const none = { cartItems, fields, pendingConfirm: false, undecided: false, proceed: [] };
  if (facts.inputs.size === 0) return none;
  let lines: Record<string, StoredLine>;
  try {
    lines = JSON.parse(cartItems) as Record<string, StoredLine>;
  } catch {
    return none;
  }
  let pendingConfirm = false;
  Object.entries(lines).forEach(([cartKey, line], position) => {
    const drawn: QuickLineInputField[] = [];
    for (const key of facts.byLine.get(cartKey) ?? []) {
      const view = facts.inputs.get(key)!;
      if (view.input.type === "file") continue;
      const name = `${QUICK_LINE_INPUT_FIELD}.${position}.${key}`;
      const agreeName = `${QUICK_LINE_AGREE_FIELD}.${position}.${key}`;
      // A tick box posts its hidden "" first and "true" when ticked: the last one is the buyer's.
      const raw = posted.getAll(name).at(-1) ?? null;
      const item = { properties: Array.isArray(line.properties) ? line.properties : [] };
      let pending: QuickLineInputField["pending"] = null;
      let shown = lineAnswer(item, key)?.value ?? "";
      if (typeof raw === "string") {
        const answer = lineAnswerFor(view, raw, checkedText);
        const current = lineAnswer(item, key);
        const choice = answer ? confirmedChoice(view, answer.value) : null;
        if (!sameAnswer(current, answer)) {
          if (choice && posted.get(agreeName) !== "true") {
            // Chosen without the tick: asked for it, nothing recorded yet.
            pending = { text: choice.confirm.text, ...(choice.confirm.agree ? { agree: choice.confirm.agree } : {}) };
            pendingConfirm = true;
            shown = answer!.value;
          } else {
            line.properties = withLineAnswer(item, key, answer, facts);
            shown = answer?.value ?? "";
          }
        }
      }
      drawn.push({ name, agreeName, view, value: shown, pending, undecided: false });
    }
    if (drawn.length > 0) fields.set(position, drawn);
  });
  // Inputs that need a decision: an agreed `proceedWith` answers every line still without one; the rest stay marked.
  const entries = Object.entries(lines);
  const items = Object.fromEntries(entries.map(([cartKey, line]) => [cartKey, { properties: Array.isArray(line.properties) ? line.properties : [] }]));
  const undecided = undecidedLineInputs(items, facts).filter(({ lineKey, key }) => {
    const position = entries.findIndex(([cartKey]) => cartKey === lineKey);
    return !fields.get(position)?.find((field) => field.view.key === key)?.pending;
  });
  const proceed: QuickLineProceed[] = [];
  const left: typeof undecided = [];
  for (const key of [...new Set(undecided.map((entry) => entry.key))]) {
    const view = facts.inputs.get(key)!;
    const value = view.input.decision?.proceedWith;
    const choice = value ? confirmedChoice(view, value) : null;
    const answer = value ? lineAnswerFor(view, value, checkedText) : null;
    const forKey = undecided.filter((entry) => entry.key === key);
    const name = `${QUICK_LINE_PROCEED_FIELD}.${key}`;
    if (choice && answer && posted.get(name) === "true") {
      for (const { lineKey } of forKey) {
        const line = lines[lineKey]!;
        line.properties = withLineAnswer({ properties: Array.isArray(line.properties) ? line.properties : [] }, key, answer, facts);
        const field = fields.get(entries.findIndex(([cartKey]) => cartKey === lineKey))?.find((each) => each.view.key === key);
        if (field) field.value = answer.value;
      }
      continue;
    }
    left.push(...forKey);
    if (choice) proceed.push({ name, view, confirm: choice.confirm, positions: forKey.map(({ lineKey }) => entries.findIndex(([cartKey]) => cartKey === lineKey)) });
  }
  for (const { lineKey, key } of left) {
    const field = fields.get(entries.findIndex(([cartKey]) => cartKey === lineKey))?.find((each) => each.view.key === key);
    if (field) field.undecided = true;
  }
  return { cartItems: JSON.stringify(lines), fields, pendingConfirm, undecided: left.length > 0, proceed };
}
