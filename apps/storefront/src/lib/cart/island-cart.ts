/**
 * An island's `context.cart` (storefront-protocol.ts): the cart's lines with
 * the calling app's own line inputs, answers and add-ons, and the host's
 * action that sets one of its inputs on lines. Both ask the store's cart
 * check (the authority on which input applies to which line), so an app
 * theme draws "Add protection to all eligible items" without reading or
 * touching the cart's markup. Loaded on an island's first call.
 */
import type { StorefrontCartLine, StorefrontLineInputResult } from "@scalius/shared/plugins/storefront-protocol";
import { toMinor } from "@scalius/shared/money";
import { lineEntryWords } from "@scalius/shared/line-entry-words";
import { cartStore, hydrateCartFromStorage, replaceCartLines, type VariantCartItem } from "@/store/cart";
import { formatMinorMoney, getCurrencyCode, getDecimalPlaces } from "@/lib/currency";
import { pageLanguage } from "@/lib/store-time-zone";
import { currentPresence } from "@/lib/presence-url";
import { readBuyerAttributes } from "@/lib/buyer-ui/state";
import { browserBuyerUiLocaleHeaders } from "@/lib/buyer-ui/browser-locale";
import type { CartValidationIssue, CartValidationResult } from "@/lib/api/orders";
import { cartItemVariantLabel } from "./item-options";
import { purchaseOptionsField } from "./purchase-option";
import { cartLineInputFacts, confirmedChoice, lineAnswerFor, sameAnswer, lineAnswer, withLineAnswer, type CartLineInputFacts } from "./line-inputs";
import { cartLinePropertyInputs } from "@/store/cart";

/** The store's check of the cart as it is now: which line takes which input, in the buyer's language. */
async function checkCart(items: Readonly<Record<string, VariantCartItem>>): Promise<CartLineInputFacts | null> {
  const entries = Object.entries(items);
  if (entries.length === 0) return cartLineInputFacts(null);
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
        price: item.price,
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
  return cartLineInputFacts(json.data, json.data.issues ?? []);
}

function money(amountMinor: number) {
  const currency = getCurrencyCode();
  const value = { amountMinor, currency };
  return { ...value, formatted: formatMinorMoney(value) };
}

/** The cart's lines with this app's parts only. */
export async function islandCartLines(pluginId: string): Promise<StorefrontCartLine[]> {
  hydrateCartFromStorage();
  const { items } = cartStore.get();
  const facts = await checkCart(items) ?? cartLineInputFacts(null);
  const prefix = `${pluginId}.`;
  const places = getDecimalPlaces(getCurrencyCode());
  return Object.entries(items).map(([lineKey, item]) => ({
    lineKey,
    productId: item.id,
    variantId: item.variantId,
    title: item.name,
    quantity: item.quantity,
    unitPrice: money(toMinor(Math.max(0, item.price), places)),
    inputs: (facts.byLine.get(lineKey) ?? []).filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length)),
    answers: Object.fromEntries((item.properties ?? []).filter((property) => property.key.startsWith(prefix)).map((property) => [property.key.slice(prefix.length), property.value])),
    addOns: (item.adjustments ?? []).filter((adjustment) => adjustment.appId === pluginId)
      .map((adjustment) => ({ title: adjustment.displayValue, amount: money(adjustment.priceMinor) })),
  }));
}

/** Sets one of this app's inputs on lines, as the cart's own controls and bulk actions do. */
export async function islandSetLineInput(
  pluginId: string,
  change: { key: string; value: string | null; lineKeys?: string[] },
): Promise<StorefrontLineInputResult> {
  if (typeof change?.key !== "string" || (change.value !== null && typeof change.value !== "string")) return { ok: false, reason: "unknown_input" };
  hydrateCartFromStorage();
  const { items } = cartStore.get();
  const facts = await checkCart(items);
  if (!facts) return { ok: false, reason: "failed" };
  const key = `${pluginId}.${change.key}`;
  const view = facts.inputs.get(key);
  if (!view) return { ok: false, reason: "unknown_input" };
  const language = pageLanguage();
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
  return (await replaceCartLines(edits)) ? { ok: true, changed: targets.length } : { ok: false, reason: "failed" };
}
