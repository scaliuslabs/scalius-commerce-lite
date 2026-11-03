// A product_main skin's SKU controls (packages/plugin-sdk/docs/storefront.md,
// "Choosing and buying a SKU"): `chooseVariant(variant)` and
// `buyVariant(variant, "add" | "buy")` write `data-choose-variant` and
// `data-buy-variant`/`data-buy-intent` on the app's own `<a>` or `<button>`.
// The host binds them here, after the markup is checked, to the store's one
// buy form, so an app never writes `form=` or a handler:
//
// - a choice link gets the product URL with that SKU (`?variant=`); a choice
//   button stays a plain button. product-controller.ts chooses the whole SKU.
// - a buy button becomes a submit button of the buy form posting its own SKU
//   (`variant.button`, which the POST handler prefers to the form's), so it
//   buys without JavaScript too; it is off (Buy now: gone) while that SKU is
//   sold out. product-controller.ts chooses the SKU, then runs the form's add.
// - `data-sx-bound` marks what the host bound: the sanitizer strips every
//   `data-sx-*` an app writes, so markup elsewhere (a slot component, an
//   island's own markup) never gets the behaviour.
// - `<BuyForm options={false} />` (`data-options="false"`) leaves the
//   form's option buttons out only when these controls cover every buyable
//   SKU; otherwise the host drops the request and the form draws them.
//
// Bound controls placed before the buy form get a hidden default submit
// button ahead of them, so Enter in a buyer input or the quantity submits
// the buyer's own choice, never the first skin button's SKU.

import type { StorefrontProductPage } from "@scalius/shared/plugins/storefront-protocol";
import { escapeHtml } from "@scalius/shared/html-escape";
import { BUY_FORM_ID, BUY_FORM_VARIANT_FIELDS } from "@/components/product/lib/buy-form";
import type { AppMarkup } from "./index";

const CONTROL_TAG = /<(a|button)\b([^<>]*)>/g;
const ATTRIBUTE = /\s([a-z][a-z0-9-]*)(?:="([^"]*)")?/g;
const BOUND = "data-sx-bound";
/** What the host writes on a bound control: the app's own values of these go. */
const HOST_ATTRIBUTES = new Set(["href", "type", "name", "value", "form", "disabled", "aria-pressed", "aria-current", "data-state", "data-availability"]);

/** Ahead of skin buttons in the buy form's tree order: Enter submits the buyer's choice. */
const DEFAULT_SUBMIT = `<button type="submit" form="${BUY_FORM_ID}" class="sr-only" tabindex="-1" aria-hidden="true" ${BOUND}></button>`;

function decode(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}

function write(tag: string, attributes: ReadonlyArray<[string, string | null]>): string {
  return `<${tag}${attributes.map(([name, value]) => (value === null ? ` ${name}` : ` ${name}="${escapeHtml(value)}"`)).join("")}>`;
}

/** The skin's markup with its SKU controls bound to the buy form, and its `options={false}` honoured only when they cover every buyable SKU. */
export function bindPurchaseControls(markup: AppMarkup, product: StorefrontProductPage["product"]): AppMarkup {
  const variants = new Map(product.variants.map((variant) => [variant.id, variant]));
  const covered = new Set<string>();
  let formPlaced = false;
  let buttonsBeforeForm = false;

  const bindTag = (whole: string, tag: string, rest: string): string => {
    const attributes = [...rest.matchAll(ATTRIBUTE)].map(([, name, value]): [string, string | null] => [name!, value === undefined ? null : decode(value)]);
    const read = (name: string) => attributes.find(([key]) => key === name)?.[1] ?? null;
    const choice = read("data-choose-variant");
    const buy = tag === "button" ? read("data-buy-variant") : null;
    const id = buy ?? choice;
    if (id === null) return whole;
    const variant = variants.get(id);
    // A SKU this page does not sell: the control stays the app's, unbound.
    if (!variant) return whole;
    covered.add(variant.id);
    const kept = attributes.filter(([name]) => !HOST_ATTRIBUTES.has(name) && name !== BOUND);
    const availability: [string, string] = ["data-availability", variant.available ? "available" : "sold-out"];
    if (buy !== null) {
      if (!formPlaced) buttonsBeforeForm = true;
      const intent = read("data-buy-intent") === "buy" ? "buy" : "add";
      const flags: Array<[string, null]> = [];
      // As the form's own buttons: off while sold out, and Buy now gone then.
      if (!variant.available) flags.push(["disabled", null]);
      if (!variant.available && intent === "buy") flags.push(["hidden", null]);
      return write(tag, [
        // The host shows and hides a buy button (sold out, a cart line being edited).
        ...kept.filter(([name]) => name !== "data-buy-intent" && name !== "hidden"),
        ["data-buy-intent", intent],
        ["type", "submit"],
        ["form", BUY_FORM_ID],
        ["name", BUY_FORM_VARIANT_FIELDS.button],
        ["value", variant.id],
        availability,
        ...flags,
        [BOUND, null],
      ]);
    }
    return write(tag, [
      ...kept,
      tag === "a"
        ? ["href", `${product.url}?variant=${encodeURIComponent(variant.id)}`]
        : ["type", "button"],
      ["data-state", "unselected"],
      availability,
      [BOUND, null],
    ]);
  };

  const parts = markup.parts.map((part) => {
    if (part.kind === "embed") {
      if (part.embed === "buy_form") formPlaced = true;
      return part;
    }
    if (!part.html.includes("data-choose-variant") && !part.html.includes("data-buy-variant")) return part;
    return { ...part, html: part.html.replace(CONTROL_TAG, bindTag) };
  });

  const coversEveryBuyableSku = product.variants.every((variant) => !variant.available || covered.has(variant.id));
  const bound = parts.map((part) => {
    if (part.kind !== "embed" || part.embed !== "buy_form" || part.data.options !== "false" || coversEveryBuyableSku) return part;
    return { ...part, data: Object.fromEntries(Object.entries(part.data).filter(([name]) => name !== "options")) };
  });
  if (buttonsBeforeForm) bound.unshift({ kind: "html", html: DEFAULT_SUBMIT });
  return { ...markup, parts: bound };
}
