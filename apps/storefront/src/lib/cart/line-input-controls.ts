/**
 * The controls of the apps' line inputs on cart lines, drawn by the host on
 * the cart page and in the drawer (lib/cart/line-inputs.ts decides what).
 * Every input a line takes is drawn, answered or not: a select (its empty
 * choice is "Not chosen"), a tick box, a text field with Save, or, for a file,
 * a link to the product page. A change replaces the line in the cart (its
 * key follows its inputs), so the page's own cart check prices it again. A
 * choice that needs confirmation asks first (confirm-dialog.ts, loaded on
 * demand); Go back leaves the line as it was. The bulk actions an input
 * declares are one cart change each. Place order with lines an input needs
 * a decision on asks once for the input's `proceedWith` choice and sets it on
 * them all in one cart change (`decideUndecidedLines`). On a phone, the lines
 * that need the buyer show above the folded order summary. Loaded only when
 * some line takes an input; nothing here reaches app code (app code is
 * barred on these pages).
 */
import { cartLineKeyFor, cartLinePropertyInputs, cartStore, normalizeCartLineAdjustments, replaceCartLines, type CartLineProperty, type VariantCartItem } from "@/store/cart";
import { cartLineInputCopy, type CartLineInputCopy } from "@/lib/cart-line-input-copy";
import { lineEntryWords } from "@scalius/shared/line-entry-words";
import { formatCount, pageLanguage } from "@/lib/store-time-zone";
import { cartItemVariantLabel, cartLineName } from "./item-options";
import { isCartLineRefusal, validateCartLinesInBrowser } from "./new-line";
import { purchaseOptionsField } from "./purchase-option";
import {
  bulkActions,
  bulkTargets,
  confirmedChoice,
  lineAnswer,
  lineAnswerFor,
  linesNeedingDecision,
  proceedPlan,
  sameAnswer,
  undecidedLineInputs,
  withLineAnswer,
  type CartLineInputFacts,
  type CartLineInputView,
  type UndecidedLineInput,
} from "./line-inputs";

/** The control to focus after its line is drawn again under its new key. */
let pendingFocus: { lineKey: string; inputKey: string } | null = null;
let controlSequence = 0;

function words(): { copy: CartLineInputCopy; checked: string } {
  const language = pageLanguage();
  return { copy: cartLineInputCopy(language), checked: lineEntryWords(language).lineCheckedText };
}

/** Says a result in the surface's live region, if it has one. */
function announce(root: ParentNode, message: string): void {
  const region = root.querySelector<HTMLElement>("[data-cart-line-input-status]");
  if (region) region.textContent = message;
}

/** A line as it will be after its inputs change: the old line's key and the edited line. */
export type LineEdit = { oldLineKey: string; item: Omit<VariantCartItem, "propertiesHash"> };

/**
 * The edited lines at the store's price, checked without one as a new line
 * is: an add-on the new answer brings (or drops) is the line's price and its
 * add-ons, never a "price changed" refusal. Null, changing nothing, when the
 * store refuses an answer or cannot be reached.
 */
export async function pricedLineEdits(edits: readonly LineEdit[]): Promise<LineEdit[] | null> {
  const result = await validateCartLinesInBrowser(edits.map(({ item }, index) => ({
    cartKey: String(index),
    productId: item.id,
    variantId: item.variantId,
    quantity: item.quantity,
    productName: item.name,
    variantLabel: cartItemVariantLabel(item.options),
    ...(item.properties?.length ? { properties: cartLinePropertyInputs(item) } : {}),
    ...purchaseOptionsField(item),
  })));
  if (!result || isCartLineRefusal(result)) return null;
  if (result.issues.some((issue) => issue.code === "properties_invalid" || issue.code === "properties_required" || issue.code === "confirmation_required")) return null;
  const checked = new Map(result.items.map((line) => [line.index, line]));
  return edits.map((edit, index) => {
    const line = checked.get(index);
    if (!line) return edit;
    const { adjustments: _old, ...item } = edit.item;
    const adjustments = normalizeCartLineAdjustments(line.adjustments);
    return { ...edit, item: { ...item, price: line.unitPrice, ...(adjustments.length > 0 ? { adjustments } : {}) } };
  });
}

/** Replaces the edited lines at the store's price, in one cart change: false when nothing changed. */
export async function applyLineEdits(edits: readonly LineEdit[]): Promise<boolean> {
  const priced = await pricedLineEdits(edits);
  return priced !== null && replaceCartLines(priced);
}

/**
 * Sets one line's answer to one input, asking first when the choice needs
 * confirmation. False when the buyer went back or the cart could not change.
 */
export async function setLineAnswer(
  lineKey: string,
  view: CartLineInputView,
  value: string | null,
  facts: CartLineInputFacts,
  opener?: HTMLElement,
): Promise<boolean> {
  const item = cartStore.get().items[lineKey];
  if (!item) return false;
  const { checked } = words();
  const choice = value ? confirmedChoice(view, value) : null;
  if (choice && !await (await import("./confirm-dialog")).confirmCartChoice(choice.confirm, opener)) return false;
  const answer = lineAnswerFor(view, value, checked);
  if (sameAnswer(lineAnswer(item, view.key), answer)) return true;
  const properties = withLineAnswer(item, view.key, answer, facts);
  const { quantity, propertiesHash: _hash, ...rest } = item;
  const nextKey = await cartLineKeyFor({ id: item.id, variantId: item.variantId, properties, purchaseOptions: item.purchaseOptions }).catch(() => null);
  if (nextKey) pendingFocus = { lineKey: nextKey, inputKey: view.key };
  return applyLineEdits([{ oldLineKey: lineKey, item: { ...rest, properties, quantity } }]);
}

/** A bulk action: every line it changes, in one cart change. */
export async function runBulkAction(facts: CartLineInputFacts, key: string, action: "apply" | "clear"): Promise<number> {
  const { checked } = words();
  const { items } = cartStore.get();
  const targets = bulkTargets(items, facts, key, action, checked);
  if (targets.length === 0) return 0;
  const edits = targets.map(({ lineKey, properties }) => {
    const { quantity, propertiesHash: _hash, ...rest } = items[lineKey]!;
    return { oldLineKey: lineKey, item: { ...rest, properties, quantity } };
  });
  return (await applyLineEdits(edits)) ? targets.length : -1;
}

/** What deciding the undecided lines did: changed lines, or why nothing changed. */
export type DecideResult =
  | { ok: true; changed: number }
  | { ok: false; reason: "cancelled" | "failed" }
  /** An input with no choice to proceed with: the buyer chooses it on the line. */
  | { ok: false; reason: "undecided"; first: UndecidedLineInput };

/**
 * Place order with lines an input needs a decision on (`decision`): asks the
 * buyer once, in the host's dialog, to agree to each input's `proceedWith`
 * choice (naming the items), then sets it on every undecided line as one
 * cart change at the store's price. Go back and Escape record nothing. With
 * `appId`, only that app's inputs (an island's own).
 */
export async function decideUndecidedLines(
  facts: CartLineInputFacts,
  options: { appId?: string; opener?: HTMLElement } = {},
): Promise<DecideResult> {
  const { copy, checked } = words();
  const { items } = cartStore.get();
  const undecided = undecidedLineInputs(items, facts, options.appId);
  if (undecided.length === 0) return { ok: true, changed: 0 };
  const planned = proceedPlan(items, facts, undecided, checked);
  if ("blocked" in planned) return { ok: false, reason: "undecided", first: planned.blocked };
  const { agreements, edits } = planned.plan;
  const one = agreements.length === 1 ? agreements[0]! : null;
  const names = edits.map(({ lineKey }) => {
    const item = items[lineKey]!;
    return item.quantity > 1 ? `${cartLineName(item)} × ${formatCount(item.quantity)}` : cartLineName(item);
  });
  const { confirmLineChoice } = await import("./confirm-dialog");
  const agreed = await confirmLineChoice({
    title: one?.confirm.title ?? copy.confirmTitle,
    // Several apps' agreements: each under its input's name.
    text: one ? one.confirm.text : agreements.map(({ view, confirm }) => `${view.input.label}: ${confirm.text}`).join("\n\n"),
    agree: one?.confirm.agree ?? copy.agree,
    goBack: copy.goBack,
    confirm: copy.continue,
    items: { heading: copy.appliesTo, names },
  }, document, options.opener);
  if (!agreed) return { ok: false, reason: "cancelled" };
  const changes = edits.map(({ lineKey, properties }) => {
    const { quantity, propertiesHash: _hash, ...rest } = items[lineKey]!;
    return { oldLineKey: lineKey, item: { ...rest, properties, quantity } };
  });
  return (await applyLineEdits(changes)) ? { ok: true, changed: changes.length } : { ok: false, reason: "failed" };
}

/** The control of a line's input the buyer can reach now (the one on screen, where a line shows twice). */
export function lineInputControl(root: ParentNode, lineKey: string, key: string): HTMLElement | null {
  const controls = [...root.querySelectorAll<HTMLElement>(`[data-cart-line-inputs][data-line-key="${CSS.escape(lineKey)}"] [data-cart-line-input="${CSS.escape(key)}"] :is(input,select,textarea,button,a)`)];
  return controls.find((control) => control.getClientRects().length > 0) ?? controls[0] ?? null;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const FIELD = "min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground sm:min-h-9";

/** One input's control on one line. */
function inputControl(
  root: ParentNode,
  lineKey: string,
  item: VariantCartItem,
  view: CartLineInputView,
  facts: CartLineInputFacts,
  copy: CartLineInputCopy,
): HTMLElement {
  const id = `cart-line-input-${++controlSequence}`;
  const answer = lineAnswer(item, view.key);
  const name = copy.inputFor(view.input.label, cartLineName(item));
  const wrap = element("div", "grid gap-1");
  wrap.dataset.cartLineInput = view.key;
  if (!answer) wrap.dataset.unanswered = "";
  const fail = () => announce(root, copy.failed);
  const run = (control: HTMLElement, value: string | null, reset: () => void) => {
    control.setAttribute("aria-busy", "true");
    void setLineAnswer(lineKey, view, value, facts, control)
      .then((changed) => { if (!changed) reset(); })
      .catch(() => { reset(); fail(); })
      .finally(() => control.removeAttribute("aria-busy"));
  };
  if (view.input.type === "checkbox") {
    const label = element("label", "flex min-h-11 cursor-pointer items-center gap-2 text-sm font-medium text-foreground sm:min-h-9");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.id = id;
    box.className = "size-5 accent-primary";
    box.checked = answer?.value === "true";
    box.setAttribute("aria-label", name);
    box.addEventListener("change", () => run(box, box.checked ? "true" : null, () => { box.checked = !box.checked; }));
    label.append(box, element("span", "", view.input.label));
    wrap.append(label);
  } else if (view.input.type === "select") {
    wrap.append(Object.assign(element("label", "text-sm font-medium text-foreground", view.input.label), { htmlFor: id }));
    const select = element("select", FIELD);
    select.id = id;
    select.setAttribute("aria-label", name);
    select.append(Object.assign(document.createElement("option"), { value: "", textContent: copy.notChosen }));
    for (const option of view.input.options ?? []) select.append(Object.assign(document.createElement("option"), { value: option.value, textContent: option.label }));
    // An answer the check refused (a decline of an agreement since changed) shows as not chosen,
    // so choosing it again asks for the agreement shown now.
    select.value = facts.refused.get(lineKey)?.has(view.key) ? "" : answer?.value ?? "";
    const previous = select.value;
    select.addEventListener("change", () => run(select, select.value || null, () => { select.value = previous; }));
    wrap.append(select);
  } else if (view.input.type === "text" || view.input.type === "textarea") {
    wrap.append(Object.assign(element("label", "text-sm font-medium text-foreground", view.input.label), { htmlFor: id }));
    const row = element("div", "flex gap-2");
    const field = view.input.type === "text" ? element("input", FIELD) : element("textarea", `${FIELD} py-2`);
    field.id = id;
    field.setAttribute("aria-label", name);
    if (view.input.maxLength) field.maxLength = view.input.maxLength;
    field.value = answer?.value ?? "";
    const save = element("button", "min-h-11 shrink-0 rounded-md border border-border px-3 text-sm font-medium text-foreground hover:bg-muted sm:min-h-9", copy.save);
    save.type = "button";
    save.setAttribute("aria-label", copy.saveFor(view.input.label, cartLineName(item)));
    const previous = field.value;
    save.addEventListener("click", () => run(save, field.value || null, () => { field.value = previous; }));
    row.append(field, save);
    wrap.append(row);
  } else {
    // A file is chosen and uploaded on the product page, which edits the line.
    const link = element("a", "inline-flex min-h-11 items-center text-sm font-medium text-foreground underline underline-offset-2 sm:min-h-9", `${view.input.label}: ${copy.editOnProduct}`);
    const edit = root.querySelector<HTMLAnchorElement>(`[data-line-key="${CSS.escape(lineKey)}"] [data-cart-line-edit]`);
    link.href = edit?.href ?? "#";
    if (!edit) link.hidden = true;
    link.addEventListener("click", (event) => { if (edit) { event.preventDefault(); edit.click(); } });
    wrap.append(link);
  }
  if (view.input.help) {
    const help = element("p", "text-xs text-muted-foreground", view.input.help);
    help.id = `${id}-help`;
    wrap.querySelector("input,select,textarea")?.setAttribute("aria-describedby", help.id);
    wrap.append(help);
  }
  return wrap;
}

/**
 * Draws every line's input controls into its `[data-cart-line-inputs]` mount
 * (`data-line-key`), hides the line's plain text rows of those inputs, and the
 * bulk actions into `[data-cart-line-input-bulk]`. Safe to call after every
 * render: each mount is drawn again from the cart as it is now.
 */
export function mountCartLineInputs(root: ParentNode, facts: CartLineInputFacts): void {
  const { copy, checked } = words();
  const { items } = cartStore.get();
  // Phones fold the lines into the order summary: a line that needs the buyer (an undecided
  // input, a refused answer) shows above it too, editable without unfolding.
  for (const panel of root.querySelectorAll<HTMLElement>("[data-cart-line-decisions]")) {
    const lines = linesNeedingDecision(items, facts);
    panel.replaceChildren();
    panel.hidden = lines.length === 0;
    if (lines.length === 0) continue;
    const headingId = `cart-line-decisions-${++controlSequence}`;
    const section = element("section", "grid gap-3 rounded-xl border border-border bg-card p-4");
    section.setAttribute("aria-labelledby", headingId);
    const heading = element("h2", "text-base font-semibold text-foreground", copy.decisionsHeading);
    heading.id = headingId;
    section.append(heading);
    for (const lineKey of lines) {
      const item = items[lineKey]!;
      const row = element("div", "grid gap-2 border-t border-border pt-3 first-of-type:border-t-0");
      row.dataset.cartLineDecision = lineKey;
      row.append(element("p", "text-sm font-medium text-foreground", item.quantity > 1 ? `${cartLineName(item)} × ${formatCount(item.quantity)}` : cartLineName(item)));
      const mount = element("div", "grid gap-2");
      mount.dataset.cartLineInputs = "";
      mount.dataset.lineKey = lineKey;
      row.append(mount);
      section.append(row);
    }
    panel.append(section);
  }
  for (const mount of root.querySelectorAll<HTMLElement>("[data-cart-line-inputs]")) {
    const lineKey = mount.dataset.lineKey ?? "";
    const item = items[lineKey];
    const keys = item ? facts.byLine.get(lineKey) ?? [] : [];
    mount.replaceChildren();
    mount.hidden = keys.length === 0;
    if (!item) continue;
    for (const key of keys) {
      const view = facts.inputs.get(key);
      if (!view) continue;
      mount.append(inputControl(root, lineKey, item, view, facts, copy));
      // The control shows the answer: its text row would say it twice.
      for (const row of root.querySelectorAll<HTMLElement>(`[data-line-key="${CSS.escape(lineKey)}"] [data-property-key="${CSS.escape(key)}"]`)) row.hidden = true;
    }
  }
  // The control that was changed, where it is on screen (a line can show twice on a phone).
  // A line the buyer just decided leaves the phone's list: focus moves to the next one that needs them, else the summary bar.
  if (pendingFocus && items[pendingFocus.lineKey]) {
    const control = lineInputControl(root, pendingFocus.lineKey, pendingFocus.inputKey);
    const onScreen = (node: HTMLElement | null | undefined) => (node && node.getClientRects().length > 0 ? node : null);
    (onScreen(control)
      ?? onScreen(root.querySelector<HTMLElement>("[data-cart-line-decisions] :is(input,select,textarea,button,a)"))
      ?? onScreen(root.querySelector<HTMLElement>("#orderSummaryToggle"))
      ?? control)?.focus();
    pendingFocus = null;
  }
  for (const bar of root.querySelectorAll<HTMLElement>("[data-cart-line-input-bulk]")) {
    bar.replaceChildren();
    const actions = bulkActions(items, facts, checked);
    bar.hidden = actions.length === 0;
    for (const { view, apply, clear } of actions) {
      for (const [action, shown, label] of [["apply", apply, view.input.bulk?.apply?.label], ["clear", clear, view.input.bulk?.clear?.label]] as const) {
        if (!shown || !label) continue;
        const button = element("button", action === "apply"
          ? "min-h-11 rounded-md bg-primary px-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90 sm:min-h-9"
          : "min-h-11 rounded-md border border-border px-3 text-sm font-medium text-foreground hover:bg-muted sm:min-h-9", label);
        button.type = "button";
        button.dataset.cartLineInputBulk = `${action}:${view.key}`;
        button.addEventListener("click", () => {
          button.disabled = true;
          void runBulkAction(facts, view.key, action).then((count) => {
            announce(root, count < 0 ? copy.failed : copy.updated(formatCount(count)));
          }).finally(() => { button.disabled = false; });
        });
        bar.append(button);
      }
    }
  }
}

export type { CartLineProperty };
export { cartLineInputCopy };
