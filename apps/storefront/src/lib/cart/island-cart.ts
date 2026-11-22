/**
 * An island's `context.cart` (storefront-protocol.ts): the cart's lines with
 * the calling app's own line inputs, answers and add-ons, and the host's
 * action that sets one of its inputs on lines. Both ask the store's cart
 * check (the authority on which input applies to which line), so an app
 * theme draws "Add protection to all eligible items" without reading or
 * touching the cart's markup. A buyer UI `set_line_input` button runs the
 * same action (`setAppLineInput`): one implementation, one change shape.
 * Loaded on the first call.
 */
import type { StorefrontCartLine, StorefrontDecideResult, StorefrontLineInputResult } from "@scalius/shared/plugins/storefront-protocol";
import { toMinor } from "@scalius/shared/money";
import { lineEntryWords } from "@scalius/shared/line-entry-words";
import { cartStore, hydrateCartFromStorage, type VariantCartItem } from "@/store/cart";
import { formatMinorMoney, getCurrencyCode, getDecimalPlaces } from "@/lib/currency";
import { pageLanguage } from "@/lib/store-time-zone";
import { currentPresence } from "@/lib/presence-url";
import { readBuyerAttributes } from "@/lib/buyer-ui/state";
import { browserBuyerUiLocaleHeaders } from "@/lib/buyer-ui/browser-locale";
import type { CartValidationIssue, CartValidationResult } from "@/lib/api/orders";
import { cartItemVariantLabel } from "./item-options";
import { purchaseOptionsField } from "./purchase-option";
import { cartLineInputFacts, confirmedChoice, lineAnswerFor, sameAnswer, lineAnswer, undecidedLineInputs, withLineAnswer, type CartLineInputFacts } from "./line-inputs";
import { adoptCheckedLinePrices, cartLineCheckPrice, cartLinePropertyInputs, restoreCart } from "@/store/cart";
import { isLineInputChange } from "@scalius/shared/plugins/line-input-change";

/**
 * The store's check of the cart as it is now: which line takes which input,
 * in the buyer's language, and what it refused. A line waiting for the
 * store's price (an edit's) takes it from this check, so the cart's lines and
 * totals are the store's whoever checked last.
 */
async function checkCart(items: Readonly<Record<string, VariantCartItem>>): Promise<{ facts: CartLineInputFacts; issues: CartValidationIssue[] } | null> {
  const entries = Object.entries(items);
  if (entries.length === 0) return { facts: cartLineInputFacts(null), issues: [] };
  const attributes = readBuyerAttributes();
  const response = await fetch("/api/checkout/validate-cart", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...browserBuyerUiLocaleHeaders() },
    body: JSON.stringify({
      items: entries.map(([cartKey, item]) => ({
        cartKey,
        productId: item.id,
        variantId: item.variantId,
        quantity: item.quantity,
        ...cartLineCheckPrice(item),
        productName: item.name,
        variantLabel: cartItemVariantLabel(item.options),
        ...(item.properties?.length ? { properties: cartLinePropertyInputs(item) } : {}),
        ...purchaseOptionsField(item),
      })),
      ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
      ...(currentPresence() ? { presence: currentPresence() } : {}),
    }),
  }).catch(() => null);
  const json = (await response?.json().catch(() => null)) as { data?: CartValidationResult; details?: { itemIssues?: CartValidationIssue[] } } | null;
  if (!json?.data) return null;
  adoptCheckedLinePrices(json.data.items ?? []);
  const issues = json.data.issues ?? [];
  return { facts: cartLineInputFacts(json.data, issues), issues };
}

/** The answers the store refuses as given (its reason a check names on the answer's key). */
const REFUSALS = new Set(["properties_invalid", "properties_required", "confirmation_required"]);

function money(amountMinor: number) {
  const currency = getCurrencyCode();
  const value = { amountMinor, currency };
  return { ...value, formatted: formatMinorMoney(value) };
}

/** The cart's lines with this app's parts only. */
export async function islandCartLines(pluginId: string): Promise<StorefrontCartLine[]> {
  hydrateCartFromStorage();
  const { items } = cartStore.get();
  const facts = (await checkCart(items))?.facts ?? cartLineInputFacts(null);
  // The lines as the check left them: a line it priced carries the store's price and add-ons.
  const priced = cartStore.get().items;
  const prefix = `${pluginId}.`;
  const places = getDecimalPlaces(getCurrencyCode());
  const undecided = undecidedLineInputs(priced, facts, pluginId);
  return Object.entries(priced).map(([lineKey, item]) => ({
    lineKey,
    productId: item.id,
    variantId: item.variantId,
    title: item.name,
    quantity: item.quantity,
    unitPrice: money(toMinor(Math.max(0, item.price), places)),
    inputs: (facts.byLine.get(lineKey) ?? []).filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length)),
    answers: Object.fromEntries((item.properties ?? []).filter((property) => property.key.startsWith(prefix)).map((property) => [property.key.slice(prefix.length), property.value])),
    undecided: undecided.filter((entry) => entry.lineKey === lineKey).map((entry) => entry.key.slice(prefix.length)),
    addOns: (item.adjustments ?? []).filter((adjustment) => adjustment.appId === pluginId)
      .map((adjustment) => ({ title: adjustment.displayValue, amount: money(adjustment.priceMinor) })),
  }));
}

/**
 * Sets one of this app's inputs on lines, as the cart's own controls and
 * bulk actions do: an island's `setLineInput` and a buyer UI `set_line_input`
 * button. The store's cart check names the lines the input applies to; a
 * choice that needs confirmation is asked for in the host's dialog and keeps
 * the agreement's revision; the edited lines take the store's price from the
 * cart's next check; and checkout checks every answer again whatever this
 * allowed. A page that holds its last check's facts (`known`: the cart page,
 * the drawer) passes them, so a click costs that one next check; an island
 * asks the store first.
 */
export async function setAppLineInput(pluginId: string, change: unknown, known?: CartLineInputFacts): Promise<StorefrontLineInputResult> {
  if (!isLineInputChange(change)) return { ok: false, reason: "unknown_input" };
  hydrateCartFromStorage();
  const { items } = cartStore.get();
  const facts = known ?? (await checkCart(items))?.facts;
  if (!facts) return { ok: false, reason: "failed" };
  const key = `${pluginId}.${change.key}`;
  const view = facts.inputs.get(key);
  if (!view) return { ok: false, reason: "unknown_input" };
  const language = pageLanguage();
  // An empty answer clears it, as `null` does.
  const answer = change.value ? lineAnswerFor(view, change.value, lineEntryWords(language).lineCheckedText) : null;
  if (change.value && !answer) return { ok: false, reason: "unknown_input" };
  const named = change.lineKeys !== undefined ? [...new Set(change.lineKeys)] : null;
  if (named && named.some((lineKey) => !items[lineKey] || !(facts.byLine.get(lineKey) ?? []).includes(key))) {
    return { ok: false, reason: "not_applicable" };
  }
  const targets = (named ?? Object.keys(items)).filter((lineKey) => {
    const applies = (facts.byLine.get(lineKey) ?? []).includes(key);
    const current = lineAnswer(items[lineKey]!, key);
    return answer ? applies && !sameAnswer(current, answer) : current !== null;
  });
  if (targets.length === 0) return { ok: true, changed: 0 };
  const choice = answer ? confirmedChoice(view, answer.value) : null;
  if (choice && !await (await import("./confirm-dialog")).confirmCartChoice(choice.confirm)) return { ok: false, reason: "cancelled" };
  const edits = targets.map((lineKey) => {
    const { quantity, propertiesHash: _hash, ...rest } = items[lineKey]!;
    return { oldLineKey: lineKey, item: { ...rest, properties: withLineAnswer(items[lineKey]!, key, answer, facts), quantity } };
  });
  const { applyLineEdits } = await import("./line-input-controls");
  const before = cartStore.get();
  if (!(await applyLineEdits(edits))) return { ok: false, reason: "failed" };
  // A page that checks its own cart (it passed its facts) prices and marks the edited lines itself. An
  // island has no such check: it checks once now, so the lines take the store's price and add-ons at
  // once, and an answer the store refuses is undone and its reason returned.
  if (!known) {
    const after = await checkCart(cartStore.get().items);
    const refusal = after?.issues.find((issue) => issue.propertyKey === key && REFUSALS.has(issue.code));
    if (refusal) {
      restoreCart(before);
      return { ok: false, reason: "refused", code: refusal.code };
    }
  }
  return { ok: true, changed: targets.length };
}

/** Place order's decision for this app's inputs: asks once in the host's dialog and sets the agreed choice on every undecided line. */
export async function islandDecide(pluginId: string): Promise<StorefrontDecideResult> {
  hydrateCartFromStorage();
  const checked = await checkCart(cartStore.get().items);
  if (!checked) return { ok: false, reason: "failed" };
  const { decideUndecidedLines } = await import("./line-input-controls");
  const result = await decideUndecidedLines(checked.facts, { appId: pluginId });
  // The decided lines take the store's price from one more check, as an edit's do.
  if (result.ok && result.changed > 0) await checkCart(cartStore.get().items);
  return result.ok ? result : { ok: false, reason: result.reason };
}
