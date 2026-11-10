// Lines going back in the cart from a stored source: an order ("Buy again")
// or an abandoned checkout's recovery link (`/cart/recover/…`). Every such
// path comes through here. The lines go to the store's cart check without a
// price, so the check answers today's price and never refuses a line because
// its price moved; each line joins the cart at that price. Prices are
// compared like with like: the item's own price before its inputs' surcharges
// and the apps' add-ons, so an add-on that did not come back is never called
// a price change. An input that cannot come back (an upload binds to one
// order; an app input the store no longer takes) is named, never dropped
// silently. The check alone decides what is still sellable.
import type { OpenCartEventDetail } from "@/components/CartFlyout";
import { addLinesToCart, type CartLineQuantity } from "@/store/cart";
import type { OrderLineFulfilmentFacts } from "@/lib/api/types";
import type { CartValidationRequestItem } from "@/lib/api/orders";
import { readLinePurchaseOptions } from "@scalius/shared/line-properties";
import { linePropertyInputOf } from "@scalius/shared/line-identity";
import { buyerApiErrorText } from "@/lib/buyer-api-errors";
import { accountCopy } from "@/lib/account-copy";
import { validateCartLinesInBrowser, isCartLineRefusal } from "./new-line";

/** Issues that mean the store no longer sells the line as stored; a short stock line still goes in, capped. */
const GONE = new Set(["product_unavailable", "variant_required", "variant_unavailable", "variant_mismatch"]);
/** Issues about the line's inputs: the line is checked once more without them. */
const INPUTS_REFUSED = new Set(["properties_invalid", "properties_required", "confirmation_required"]);

/** A stored line: an order's, or an abandoned checkout's (lib/cart-recovery.ts). */
export interface StoredCartLine {
  productId: string | null;
  variantId: string | null;
  quantity: number;
  productName?: string | null;
  productSlug?: string | null;
  variantLabel?: string | null;
  /** The unit price the buyer last saw (surcharges included), in the source's currency; absent when the source keeps none. */
  price?: number | null;
  /** The line's buyer inputs and apps' options, as the order kept them (each with its surcharge). */
  properties?: OrderLineFulfilmentFacts["properties"];
}

export interface RestoredCartLines {
  /** Lines now in the cart. */
  added: number;
  /** Lines the store no longer sells as stored. */
  missing: number;
  /** Lines whose own price (before surcharges and add-ons) moved: their name and today's own price, in `currencyCode`. */
  repriced: Array<{ name: string; price: number }>;
  /** Lines that went in without some of their inputs: the line's name and the inputs' labels. */
  uncarried: Array<{ name: string; inputs: string[] }>;
  currencyCode: string | null;
}

type OrderInput = NonNullable<StoredCartLine["properties"]>[number];
/** An input the buyer chose (keys starting "_" are the platform's: an app bundle, an add-on). */
const isBuyerInput = (property: OrderInput) => !property.key.startsWith("_");
/** An upload is bound to the order it was sent with: it never comes back on another. */
const carriable = (property: OrderInput) => isBuyerInput(property) && property.type !== "file";
const lineName = (name: string, variantLabel: string | null | undefined) => variantLabel ? `${name} (${variantLabel})` : name;

/**
 * Puts the lines back: `add` grows a line the cart already holds (buy again),
 * `set` gives it the stored quantity (a recovered cart, so opening the link
 * twice changes nothing). `currencyCode` is the stored prices' currency: a
 * price in another currency is never compared. Returns what went in; the
 * store's refusal of the check in the page's words (two apps' options that
 * both price a line); or null when the store couldn't be reached. Opens the
 * cart drawer once when anything went in.
 */
export async function restoreCartLines(
  stored: readonly StoredCartLine[],
  options: { quantity: CartLineQuantity; currencyCode?: string | null },
): Promise<RestoredCartLines | { refused: string } | null> {
  const lines = stored.filter((line): line is StoredCartLine & { productId: string; variantId: string } =>
    Boolean(line.productId && line.variantId) && Number.isInteger(line.quantity) && line.quantity > 0);
  if (lines.length === 0) return { added: 0, missing: stored.length, repriced: [], uncarried: [], currencyCode: null };
  // Lines sent without their inputs (the second check, after the store refused them).
  const bare = new Set<number>();
  const check = (quantities: readonly number[]) => validateCartLinesInBrowser(lines.map((line, index): CartValidationRequestItem => {
    const purchaseOptions = readLinePurchaseOptions(line.properties ?? null);
    const inputs = bare.has(index) ? [] : (line.properties ?? []).filter(carriable);
    return {
      cartKey: String(index),
      productId: line.productId,
      variantId: line.variantId,
      quantity: quantities[index]!,
      productName: line.productName ?? null,
      variantLabel: line.variantLabel ?? null,
      // The same buyer inputs and apps' options again; the store re-checks and re-prices them.
      ...(inputs.length > 0 ? { properties: inputs.map(linePropertyInputOf) } : {}),
      ...(purchaseOptions.length > 0 ? { purchaseOptions } : {}),
    };
  }));
  const quantities = lines.map((line) => line.quantity);
  let result = await check(quantities);
  // Checked once more: a line with more than is left at what is left, a line
  // whose inputs the store refused without them (it says which, below).
  const retry = result && !isCartLineRefusal(result) ? result.issues.filter((issue) => issue.index in quantities) : [];
  let again = false;
  for (const issue of retry) {
    if (issue.code === "quantity_unavailable" && (issue.availableQuantity ?? 0) > 0) {
      quantities[issue.index] = Math.min(quantities[issue.index]!, issue.availableQuantity!);
      again = true;
    } else if (INPUTS_REFUSED.has(issue.code)) {
      bare.add(issue.index);
      again = true;
    }
  }
  if (again) result = await check(quantities);
  if (!result) return null;
  if (isCartLineRefusal(result)) return { refused: buyerApiErrorText(result.refused.payload, { status: result.refused.status }) };

  const gone = new Set(result.issues.filter((issue) => GONE.has(issue.code)).map((issue) => issue.index));
  const currencyCode = result.currencyCode ?? null;
  const comparable = Boolean(options.currencyCode && currencyCode && options.currencyCode === currencyCode);
  const cartLines: Parameters<typeof addLinesToCart>[0][number][] = [];
  const repriced: RestoredCartLines["repriced"] = [];
  const uncarried: RestoredCartLines["uncarried"] = [];
  for (const line of result.items) {
    const quantity = Math.min(line.quantity, line.availableQuantity ?? line.quantity);
    if (gone.has(line.index) || quantity < 1) continue;
    const source = lines[line.index]!;
    const name = lineName(line.productName, line.variantLabel);
    // Like with like: the item's own price then and now, before every surcharge and add-on.
    const before = typeof source.price === "number"
      ? source.price - (source.properties ?? []).reduce((total, property) => total + (property.price || 0), 0)
      : null;
    const now = line.baseUnitPrice ?? line.unitPrice - (line.propertiesPrice ?? 0) - (line.adjustments ?? []).reduce((total, adjustment) => total + (adjustment.price || 0), 0);
    if (comparable && before !== null && Math.abs(before - now) > 1e-6) repriced.push({ name, price: now });
    // The inputs the buyer chose that the line no longer carries: never dropped without a word.
    const kept = new Set((line.properties ?? []).map(({ key }) => key));
    const lost = (source.properties ?? []).filter((property) => isBuyerInput(property) && !kept.has(property.key));
    if (lost.length > 0) uncarried.push({ name, inputs: [...new Set(lost.map((property) => property.label))] });
    cartLines.push({
      id: line.productId,
      variantId: line.variantId,
      name: line.productName,
      price: line.unitPrice,
      quantity,
      slug: lines[line.index]?.productSlug ?? undefined,
      image: line.productImage ?? undefined,
      imageMediaId: line.productImageMediaId ?? undefined,
      options: line.variantLabel ? [{ name: accountCopy().format.variant, label: line.variantLabel }] : undefined,
      freeDelivery: line.freeDelivery,
      ...(line.purchaseOptions?.length ? { purchaseOptions: line.purchaseOptions } : {}),
      ...(line.fulfillmentKind ? { fulfillmentKind: line.fulfillmentKind } : {}),
      ...(line.properties?.length
        ? {
            properties: line.properties.map(({ key, value, label, displayValue, priceMinor }) => ({
              key, value, label, displayValue, priceMinor,
            })),
          }
        : {}),
    });
  }
  // One cart change for every line: a line-per-event add left later lines to
  // race the first one's drawer load and reported lines as added that weren't.
  const addedKeys = cartLines.length > 0 ? await addLinesToCart(cartLines, { quantity: options.quantity }) : [];
  if (addedKeys.length > 0) {
    document.dispatchEvent(new CustomEvent<OpenCartEventDetail>("open-cart", { detail: { addedLineKey: addedKeys[0], addedCount: addedKeys.length } }));
  }
  return { added: addedKeys.length, missing: stored.length - addedKeys.length, repriced, uncarried, currencyCode };
}
