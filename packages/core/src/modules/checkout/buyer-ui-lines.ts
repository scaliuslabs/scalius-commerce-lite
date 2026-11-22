// The facts the cart's UI slots draw each cart line from (`BuyerUiLine`):
// the buyer's line (an expanded bundle is one line), its add-ons, and every
// app line input's state on it: whether it applies, the answer, whether
// checkout needs one, and what each offered choice would add to a unit.
// Built within the bounds one app's facts keep (`buyerUiLinesSchema`).
//
// The offer prices are each owning app's own `cart.line_prices` answer for
// the line as if the buyer had chosen it, with the rest of the cart as it is
// (the real lines ride along, so a price that depends on other lines sees
// them), resolved exactly as checkout resolves add-ons (the store-currency
// conversion, a share of the item's price, a bundle's fee once per bundle
// unit). One run, of the apps that draw the per-line slot and offer a
// priced choice alone, outside the order's path (`runOffers`: never
// blocking, never counted toward a circuit); a failed or refused run prices
// no offer and never changes the cart's own prices.
import { addOnShareMinor } from "@scalius/shared/money";
import { aggregateLineAddOns, lineAddOnsOf } from "@scalius/shared/add-on-totals";
import { MAX_ORDER_LINES } from "@scalius/shared/order-limits";
import { CUSTOMIZATION_LIMITS } from "@scalius/shared/line-properties";
import type { AppLineInputs } from "@scalius/shared/line-properties";
import type { BuyerUiLine, FunctionCart, FunctionCartLine } from "@scalius/shared/plugins";
import { buildStorefrontTaxAllocationLineId } from "../tax";
import { resolveAppLineAdjustments, storeAmountConversionOf, type AppLineAddOn } from "./app-line-prices";
import type { CheckoutAppFunctions } from "./app-functions";
import type { StorefrontCartValidatedItem, StorefrontCartValidationResult } from "./cart-validation";

/** Lines one offer run prices at most (a function cart holds 250). */
const OFFER_LINES_MAX = 250;

/** The choices an input offers on a line: a select's choices that need no confirmation, a checkbox's tick. */
function offeredValues(input: AppLineInputs["inputs"][number]): string[] {
  if (input.type === "checkbox") return ["true"];
  if (input.type === "select") return (input.options ?? []).filter((option) => !option.confirm).map((option) => option.value).slice(0, CUSTOMIZATION_LIMITS.selectOptions);
  return [];
}

interface OfferGroup {
  appId: string;
  key: string;
  value: string;
  buyerIndex: number;
  /** The quote cart's lines for this offer: the buyer line's checkout lines with the choice set. */
  items: Array<{ item: StorefrontCartValidatedItem; position: number }>;
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
  const cartLines = new Map(appCart.lines.map((line) => [line.lineId, line]));
  const groups: OfferGroup[] = [];
  let lineCount = 0;
  for (const line of buyer.items) {
    const applies = new Set(line.lineInputs ?? []);
    const components = componentsOf(line.index);
    if (components.length === 0 || components.some((component) => component.isGiftCard)) continue;
    for (const app of lineInputs) {
      if (!offerApps.has(app.appId)) continue;
      for (const input of app.inputs) {
        const key = `${app.appId}.${input.key}`;
        if (!applies.has(key)) continue;
        for (const value of offeredValues(input)) {
          if (appCart.lines.length + lineCount + components.length > OFFER_LINES_MAX) break;
          groups.push({ appId: app.appId, key, value, buyerIndex: line.index, items: components.map((item) => ({ item, position: lineCount++ })) });
        }
      }
    }
  }
  if (groups.length === 0) return priced;
  // The quote cart: each offer's lines as checkout's first pass sees them (before add-ons), the choice set.
  const quoteLines: FunctionCartLine[] = [];
  const facts: Array<{ lineId: string; source: StorefrontCartValidatedItem["priceSource"]; storeUnitPrice?: { amountMinor: number; currency: string }; bundle: { id: string; title: string; units?: number } | null }> = [];
  const quoteItems: Array<Pick<StorefrontCartValidatedItem, "index" | "isGiftCard" | "bundle" | "quantity">> = [];
  const quoteIds: string[] = [];
  for (const [groupIndex, group] of groups.entries()) {
    for (const { item, position } of group.items) {
      const original = cartLines.get(buildStorefrontTaxAllocationLineId(item.index, item.variantId));
      if (!original) return priced;
      const lineId = `offer:${position}`;
      const bundle = item.bundle ? { ...item.bundle, id: `offer:${groupIndex}:${item.bundle.id}` } : null;
      const itemUnitMinor = item.baseUnitPriceMinor + item.propertiesPriceMinor;
      quoteLines.push({
        ...original,
        lineId,
        unitPriceMinor: itemUnitMinor,
        lineTotalMinor: itemUnitMinor * item.quantity,
        properties: { ...original.properties, [group.key]: group.value },
        addOns: [],
        ...(original.bundle ? { bundle: { ...original.bundle, id: bundle!.id } } : {}),
      });
      facts.push({
        lineId,
        source: item.priceSource === "app" ? "base" : item.priceSource,
        ...(item.storeUnitPriceMinor !== undefined ? { storeUnitPrice: { amountMinor: item.storeUnitPriceMinor, currency: appCart.storeCurrency.code } } : {}),
        bundle: bundle ? { id: bundle.id, title: bundle.title.slice(0, 300), ...(bundle.units ? { units: bundle.units } : {}) } : null,
      });
      quoteItems.push({ index: position, isGiftCard: false, bundle, quantity: item.quantity });
      quoteIds.push(lineId);
    }
  }
  let adjustments: Map<number, AppLineAddOn[]>;
  try {
    // The real cart rides along (a price may depend on the other lines); only the offer lines' answers are read.
    const owners = new Set(groups.map((group) => group.appId));
    const realFacts = result.items.map((item) => ({
      lineId: buildStorefrontTaxAllocationLineId(item.index, item.variantId),
      source: item.priceSource === "app" ? "base" as const : item.priceSource,
      ...(item.storeUnitPriceMinor !== undefined ? { storeUnitPrice: { amountMinor: item.storeUnitPriceMinor, currency: appCart.storeCurrency.code } } : {}),
      bundle: item.bundle ? { id: item.bundle.id, title: item.bundle.title.slice(0, 300), ...(item.bundle.units ? { units: item.bundle.units } : {}) } : null,
    }));
    const answers = await apps.runOffers(owners, { cart: { ...appCart, lines: [...appCart.lines, ...quoteLines] }, lines: [...realFacts, ...facts] } as never);
    const offerIds = new Set(quoteIds);
    const own = answers.filter((answer) => owners.has(answer.pluginId)).map((answer) => ({
      ...answer,
      output: { ...answer.output, adjustments: (answer.output.adjustments ?? []).filter((entry) => offerIds.has(entry.lineId)) },
    }));
    adjustments = resolveAppLineAdjustments(quoteItems, quoteIds, own, storeAmountConversionOf(result));
  } catch {
    // A blocking app that could not answer, or an answer checkout would refuse: no offer is priced.
    return priced;
  }
  const increment = result.money.incrementMinor;
  for (const group of groups) {
    let total = 0;
    let answered = false;
    const bundleUnitMinor = group.items.reduce((sum, { item }) =>
      sum + (item.baseUnitPriceMinor + item.propertiesPriceMinor) * (item.quantity / Math.max(1, item.bundle?.units ?? item.quantity)), 0);
    for (const { item, position } of group.items) {
      for (const addOn of adjustments.get(position) ?? []) {
        if (addOn.appId !== group.appId) continue;
        answered = true;
        // A bundle's add-on is per bundle unit (one buyer unit); a plain line's per unit.
        const basis = addOn.bundle ? bundleUnitMinor : item.baseUnitPriceMinor + item.propertiesPriceMinor;
        total += "percent" in addOn ? addOnShareMinor(basis, addOn.percent, increment) : addOn.amountMinor;
      }
    }
    if (answered && Number.isSafeInteger(total)) priced.set(`${group.buyerIndex}\u0000${group.key}\u0000${group.value}`, total);
  }
  return priced;
}
