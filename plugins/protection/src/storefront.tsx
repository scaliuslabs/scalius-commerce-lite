/** @jsxImportSource @scalius/plugin-sdk/storefront */
// Protection Plans on the product page (`plan_price`, product.buy_box.after):
// the plan's price for this product and the offers that take a plan, read
// from what the page already has: the app's public settings
// (`context.app.settings`: the plans' shares, the price table, the policy
// link) and its own `eligible` flags on the product and each SKU
// (`product.fields`, `variants[].fields`, a SKU's own value over its
// product's, as checkout decides). No read, no script: a product that takes
// no plan draws nothing.

import { componentFor, currencyDecimalPlaces, defineStorefront, formatMoney, t, type StorefrontRenderContext } from "@scalius/plugin-sdk/storefront";
import { APP_ID, parsePriceTiers, planPercent, PLANS, tierPrice, type PlanId } from "./plans";

const FLAG = `${APP_ID}.eligible`;

type Settings = Parameters<typeof planPercent>[1] & { policy_url?: string | null };

/** The flag as set on a product or SKU: true, false or unset. */
function flag(fields: Readonly<Record<string, unknown>> | undefined): boolean | undefined {
  const value = fields?.[FLAG];
  return typeof value === "boolean" ? value : undefined;
}

/**
 * The lowest price a plan sells at for an item of `priceMinor` (page
 * currency): a share of it, or the price table's row, which is in the store's
 * currency and so is shown only on pages in that currency. Null: no plan sells.
 */
export function lowestPlanPrice(settings: Settings, context: StorefrontRenderContext, priceMinor: number): number | null {
  const plans = (Object.keys(PLANS) as PlanId[]).filter((plan) => planPercent(plan, settings) > 0);
  if (plans.length === 0) return null;
  if (settings.pricing === "tiers") {
    const storeCurrency = context.store.storeCurrency ?? context.store.currency;
    if (storeCurrency !== context.store.currency) return null;
    const tiers = parsePriceTiers(settings.tiers, currencyDecimalPlaces(storeCurrency));
    return tiers ? tierPrice(tiers, priceMinor) : null;
  }
  const lowest = Math.min(...plans.map((plan) => planPercent(plan, settings)));
  return Math.max(1, Math.round((priceMinor * lowest) / 100));
}

const PlanPrice = componentFor(["product.buy_box.after"], (props) => {
  const { product } = props.data;
  const context = props.context;
  const settings = (context.app?.settings ?? {}) as Settings;
  const productFlag = flag(product.fields);
  // A SKU's own flag decides; unset, its product's (checkout's rule).
  const offers = product.variants.filter((variant) => flag(variant.fields) ?? productFlag === true);
  if (offers.length === 0) return null;
  const priceMinor = Math.min(...offers.map((offer) => offer.price.amountMinor));
  const price = lowestPlanPrice(settings, context, priceMinor);
  const tiered = settings.pricing === "tiers";
  if (price === null && !tiered) return null;
  const every = offers.length === product.variants.length;
  const policy = typeof settings.policy_url === "string" && settings.policy_url.startsWith("https://") ? settings.policy_url : null;
  return (
    <aside class="protection-offer" data-offers={offers.map((offer) => offer.id).join(" ")}>
      <p>
        {price === null
          ? t(context, { en: "Protection plans are available.", bn: "প্রোটেকশন প্ল্যান পাওয়া যায়।" })
          : t(context, { en: "Protection from {price}", bn: "প্রোটেকশন {price} থেকে" }).replace("{price}", formatMoney(context, { amountMinor: price, currency: context.store.currency }))}
      </p>
      {every ? null : (
        <p>
          {t(context, { en: "Offered on: ", bn: "যেসব অফারে: " })}
          {offers.map((offer) => offer.title).join(", ")}
        </p>
      )}
      {policy ? <a href={policy} rel="noopener">{t(context, { en: "Learn more", bn: "আরও জানুন" })}</a> : null}
    </aside>
  );
});

export default defineStorefront({ components: { plan_price: PlanPrice } });
