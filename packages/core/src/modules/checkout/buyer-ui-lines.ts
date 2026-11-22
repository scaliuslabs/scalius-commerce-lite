// The facts the cart's UI slots draw each cart line from (`BuyerUiLine`):
// the buyer's line (an expanded bundle is one line), its add-ons, and every
// app line input's state on it: whether it applies, the answer, whether
// checkout needs one, and what each offered choice would add to a unit.
// Built within the bounds one app's facts keep (`buyerUiLinesSchema`).
//
// The offer prices are each owning app's own `cart.line_prices` answer: the
// run reads the real cart as it is and a separate list of offers (each the
// real line it would change and the choice, at most `LINE_OFFERS_MAX`), and
// answers an add-on per offer (`output.offers`); nothing hypothetical joins
// the cart, so a price that depends on the cart's count or total is the one
// checkout charges once the buyer chooses it. Resolved as checkout resolves
// an add-on (the store-currency conversion and rounding, a share of the
// item's price; a bundle's per bundle unit). One run, of the apps that draw
// the per-line slot and offer a priced choice alone, outside the order's
// path (`runOffers`: never blocking, its own backoff, its own budget); a
// failed or refused run prices no offer and never changes a price.
import { addOnShareMinor } from "@scalius/shared/money";
import { aggregateLineAddOns, lineAddOnsOf } from "@scalius/shared/add-on-totals";
import { MAX_ORDER_LINES } from "@scalius/shared/order-limits";
import { CUSTOMIZATION_LIMITS } from "@scalius/shared/line-properties";
import type { AppLineInputs } from "@scalius/shared/line-properties";
import { LINE_OFFERS_MAX, type BuyerUiLine, type FunctionCart, type FunctionLineOffer } from "@scalius/shared/plugins";
import { buildStorefrontTaxAllocationLineId } from "../tax";
import { resolveAppLineAdjustments, storeAmountConversionOf, type AppLineAddOn } from "./app-line-prices";
import type { CheckoutAppFunctions } from "./app-functions";
import type { StorefrontCartValidatedItem, StorefrontCartValidationResult } from "./cart-validation";

/** The choices an input offers on a line: a select's choices that need no confirmation, a checkbox's tick. */
function offeredValues(input: AppLineInputs["inputs"][number]): string[] {
  if (input.type === "checkbox") return ["true"];
  if (input.type === "select") return (input.options ?? []).filter((option) => !option.confirm).map((option) => option.value).slice(0, CUSTOMIZATION_LIMITS.selectOptions);
  return [];
}

/**
 * Each buyer line's facts, in the buyer's cart order, for lines that carry
 * the cart key the page sent. `result` is the cart checkout prices (an
 * expanded bundle's components), `buyer` the buyer's lines; `appCart` is the
 * cart the apps saw (null: no offer can be priced). `offerApps` are the apps
 * whose inputs get offer prices (the ones that draw the per-line slot).
 */
export async function buyerUiCartLines(options: {
  apps: Pick<CheckoutAppFunctions, "points" | "runOffers">;
  result: StorefrontCartValidationResult;
  buyer: Pick<StorefrontCartValidationResult, "items">;
  appCart: FunctionCart | null;
  lineInputs: readonly AppLineInputs[];
  offerApps: ReadonlySet<string>;
}): Promise<BuyerUiLine[]> {
  const { result, buyer, lineInputs } = options;
  const componentsOf = (buyerIndex: number) => result.items.filter((item) => item.sourceIndex === buyerIndex);
  const offers = await priceOffers(options, componentsOf);
  return buyer.items.slice(0, MAX_ORDER_LINES).flatMap((item): BuyerUiLine[] => {
    if (!item.cartKey) return [];
    const answers = new Map(item.properties.map((property) => [property.key, property.value]));
    const applies = new Set(item.lineInputs ?? []);
    return [{
      lineKey: item.cartKey,
      productId: item.productId,
      variantId: item.variantId,
      title: (item.variantLabel ? `${item.productName} (${item.variantLabel})` : item.productName).slice(0, 300),
      quantity: item.quantity,
      unitPriceMinor: item.unitPriceMinor,
      bundle: componentsOf(item.index).some((component) => component.bundle?.kind === "expand"),
      addOns: aggregateLineAddOns(lineAddOnsOf(item.adjustments)).map((addOn) => ({ appId: addOn.appId ?? "", title: addOn.title, amountMinor: addOn.amountMinor })),
      inputs: lineInputs.flatMap((app) => app.inputs.map((input) => {
        const key = `${app.appId}.${input.key}`;
        const eligible = applies.has(key);
        return {
          key,
          eligible,
          value: answers.get(key) ?? null,
          decision: eligible && input.decision !== undefined,
          offers: eligible ? offeredValues(input).flatMap((value) => {
            const addOnMinor = offers.get(`${item.index}\u0000${key}\u0000${value}`);
            return addOnMinor === undefined ? [] : [{ value, addOnMinor }];
          }) : [],
        };
      })),
    }];
  });
}

/** What each offered choice adds to one buyer unit, by `<buyer index>\0<input key>\0<value>`. */
async function priceOffers(
  options: Parameters<typeof buyerUiCartLines>[0],
  componentsOf: (buyerIndex: number) => StorefrontCartValidatedItem[],
): Promise<Map<string, number>> {
  const priced = new Map<string, number>();
  const { apps, appCart, result, buyer, lineInputs, offerApps } = options;
  if (!appCart || offerApps.size === 0 || !apps.points.has("cart.line_prices") || !apps.runOffers) return priced;
  const realIds = new Set(appCart.lines.map((line) => line.lineId));
  const offers: Array<FunctionLineOffer & { appId: string; buyerIndex: number; basisMinor: number }> = [];
  for (const line of buyer.items) {
    const applies = new Set(line.lineInputs ?? []);
    const components = componentsOf(line.index);
    if (components.length === 0 || components.some((component) => component.isGiftCard)) continue;
    // The line an offer would change: a plain line itself; an expanded bundle's anchor (its add-on is per bundle unit).
    const anchor = components.reduce((least, component) =>
      (component.quantity / Math.max(1, component.bundle?.units ?? component.quantity)) < (least.quantity / Math.max(1, least.bundle?.units ?? least.quantity)) ? component : least);
    const lineId = buildStorefrontTaxAllocationLineId(anchor.index, anchor.variantId);
    if (!realIds.has(lineId)) continue;
    // A share is of the item one buyer unit is: the bundle unit's components, or the line's item price.
    const basisMinor = components.reduce((sum, item) =>
      sum + (item.baseUnitPriceMinor + item.propertiesPriceMinor) * (item.quantity / Math.max(1, item.bundle?.units ?? item.quantity)), 0);
    for (const app of lineInputs) {
      if (!offerApps.has(app.appId)) continue;
      for (const input of app.inputs) {
        const key = `${app.appId}.${input.key}`;
        if (!applies.has(key)) continue;
        for (const value of offeredValues(input)) {
          if (offers.length >= LINE_OFFERS_MAX) break;
          offers.push({ offerId: `offer:${offers.length}`, lineId, key, value, appId: app.appId, buyerIndex: line.index, basisMinor });
        }
      }
    }
  }
  if (offers.length === 0) return priced;
  const owners = new Set(offers.map((offer) => offer.appId));
  const realFacts = result.items.map((item) => ({
    lineId: buildStorefrontTaxAllocationLineId(item.index, item.variantId),
    source: item.priceSource === "app" ? "base" as const : item.priceSource,
    ...(item.storeUnitPriceMinor !== undefined ? { storeUnitPrice: { amountMinor: item.storeUnitPriceMinor, currency: appCart.storeCurrency.code } } : {}),
    bundle: item.bundle ? { id: item.bundle.id, title: item.bundle.title.slice(0, 300), ...(item.bundle.units ? { units: item.bundle.units } : {}) } : null,
  }));
  let resolved: Map<number, AppLineAddOn[]>;
  try {
    // The real cart as it is, and the offers beside it: no hypothetical line joins the cart.
    const answers = await apps.runOffers(owners, {
      cart: appCart, lines: realFacts,
      offers: offers.map(({ offerId, lineId, key, value }) => ({ offerId, lineId, key, value })),
    } as never);
    const byId = new Map(offers.map((offer, position) => [offer.offerId, { offer, position }]));
    // Each app prices only its own offers; resolved as checkout resolves a line's add-on (conversion, rounding).
    const own = answers.filter((answer) => owners.has(answer.pluginId)).map((answer) => ({
      pluginId: answer.pluginId,
      output: {
        prices: [],
        adjustments: (answer.output.offers ?? []).flatMap((entry) => {
          const found = byId.get(entry.offerId);
          if (!found || found.offer.appId !== answer.pluginId) return [];
          const { offerId, ...addOn } = entry;
          return [{ ...addOn, lineId: offerId }];
        }),
      },
    }));
    resolved = resolveAppLineAdjustments(
      offers.map((_, position) => ({ index: position, isGiftCard: false, bundle: null, quantity: 1 })),
      offers.map((offer) => offer.offerId), own as never, storeAmountConversionOf(result));
  } catch {
    // A failed run, or an answer checkout would refuse: no offer is priced; the cart is untouched.
    return priced;
  }
  const increment = result.money.incrementMinor;
  offers.forEach((offer, position) => {
    const addOns = (resolved.get(position) ?? []).filter((addOn) => addOn.appId === offer.appId);
    if (addOns.length === 0) return;
    const total = addOns.reduce((sum, addOn) => sum + ("percent" in addOn ? addOnShareMinor(offer.basisMinor, addOn.percent, increment) : addOn.amountMinor), 0);
    if (Number.isSafeInteger(total)) priced.set(`${offer.buyerIndex}\u0000${offer.key}\u0000${offer.value}`, total);
  });
  return priced;
}
