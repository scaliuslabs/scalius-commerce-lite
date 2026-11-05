// A product_main skin's SKU controls (packages/plugin-sdk/docs/storefront.md,
// "Choosing and buying a SKU"): `chooseVariant(variant)` and
// `buyVariant(variant, "add" | "buy")` write `data-choose-variant` and
// `data-buy-variant`/`data-buy-intent` on the app's own `<a>` or `<button>`.
// The host binds them here, after the markup is checked, to the store's one
// buy form, so an app never writes `form=` or a handler:
//
// - a choice link gets the product URL with that SKU (`?variant=`); a choice
//   button stays a plain button. The SKU the page opens on is drawn chosen.
//   product-controller.ts chooses the whole SKU.
// - a buy button becomes a submit button of the buy form posting its own SKU
//   (`variant.button`, which the POST handler prefers to the form's), so it
//   buys without JavaScript too; it is off (Buy now: gone) while that SKU is
//   sold out or nothing can be bought here, and never also a choice.
//   product-controller.ts chooses the SKU, then runs the form's add.
// - `data-sx-bound` marks what the host bound: the sanitizer strips every
//   `data-sx-*` an app writes, so markup elsewhere (a slot component, an
//   island's own markup) never gets the behaviour.
// - `<BuyForm options={false} />` (`data-options="false"`) leaves the
//   form's option buttons out only when these controls cover every buyable
//   SKU; otherwise the host drops the request and the form draws them.
// - `<BuyForm actions={false} />` (`data-actions="false"`) leaves the form's
//   own Add to cart and Buy now out only when buy buttons (`buyVariant`)
//   cover every buyable SKU; otherwise the form draws them.
//
// Bound controls placed before the buy form, and every skin without the
// form's own buttons, get a hidden default submit button ahead of them, so
// Enter in a buyer input or the quantity submits the buyer's own choice,
// never the first skin button's SKU.

import type { StorefrontProductPage } from "@scalius/shared/plugins/storefront-protocol";
import { escapeHtml } from "@scalius/shared/html-escape";
import { decodeAttribute, deferredAt } from "@scalius/shared/plugins/storefront-embeds";
import { BUY_FORM_ID, BUY_FORM_VARIANT_FIELDS } from "@/components/product/lib/buy-form";
import { SKIN_CHOICE_PREPAINT_SCRIPT } from "@/lib/inline-boot-scripts";
import { warnOnce } from "./host";
import type { AppMarkup } from "./index";

const CONTROL_TAG = /<(a|button)\b([^<>]*)>/g;
// Every attribute name the sanitizer writes (SVG keeps camelCase), so no value is read as names.
const ATTRIBUTE = /\s([^\s"'<>/=]+)(?:="([^"]*)")?/g;
const BOUND = "data-sx-bound";
/** What the host writes on a bound control: the app's own values of these go. */
const HOST_ATTRIBUTES = new Set(["href", "type", "name", "value", "form", "disabled", "aria-pressed", "aria-current", "aria-busy", "data-state", "data-availability"]);

/** Ahead of skin buttons in the buy form's tree order: Enter submits the buyer's choice (off, as the form's own, where nothing can be bought). */
const defaultSubmit = (blocked: boolean) => `<button type="submit" form="${BUY_FORM_ID}" class="sr-only" tabindex="-1" aria-hidden="true"${blocked ? " disabled" : ""} ${BOUND}></button>`;

/** Whether offset `at` of checked markup is inside an `<a>` carrying `data-choose-variant` (links do not nest). */
function insideChoiceLink(html: string, at: number): boolean {
  const before = html.slice(0, at);
  const open = Math.max(before.lastIndexOf("<a "), before.lastIndexOf("<a>"));
  return open > before.lastIndexOf("</a>") && /^<a\s[^>]*\bdata-choose-variant=/.test(before.slice(open));
}

function write(tag: string, attributes: ReadonlyArray<[string, string | null]>): string {
  return `<${tag}${attributes.map(([name, value]) => (value === null ? ` ${name}` : ` ${name}="${escapeHtml(value)}"`)).join("")}>`;
}

/** What the page knows of buying here that the projection does not say. */
export interface PurchasePage {
  /** Nothing can be bought here (broken buyer inputs, or paid only online where checkout takes no online payment): every buy button is off, as the form's own. */
  blocked: boolean;
  /** The SKU the page opens on (`initialVariantPresentation`): its choice control is drawn chosen. */
  opening: string | null;
}

/**
 * The skin's markup with its SKU controls bound to the buy form, and its
 * `options={false}` and `actions={false}` honoured only when its controls
 * (for `actions`, its buy buttons) cover every buyable SKU.
 */
export function bindPurchaseControls(markup: AppMarkup, product: StorefrontProductPage["product"], page: PurchasePage): AppMarkup {
  const variants = new Map(product.variants.map((variant) => [variant.id, variant]));
  const covered = new Set<string>();
  /** The SKUs a bound buy button (outside deferred markup) buys. */
  const bought = new Set<string>();
  let formPlaced = false;
  let buttonsBeforeForm = false;
  let choicesBound = false;

  // `deferred`: inside deferred markup, which may never enter the page: bound, but it covers no SKU.
  const bindTag = (whole: string, tag: string, rest: string, deferred: boolean): string => {
    const attributes = [...rest.matchAll(ATTRIBUTE)].map(([, name, value]): [string, string | null] => [name!, value === undefined ? null : decodeAttribute(value)]);
    const read = (name: string) => attributes.find(([key]) => key === name)?.[1] ?? null;
    const choice = read("data-choose-variant");
    const buy = tag === "button" ? read("data-buy-variant") : null;
    const id = buy ?? choice;
    if (id === null) return whole;
    const variant = variants.get(id);
    // A SKU this page does not sell: the control stays the app's, unbound.
    if (!variant) return whole;
    if (!deferred) covered.add(variant.id);
    const kept = attributes.filter(([name]) => !HOST_ATTRIBUTES.has(name));
    const availability: [string, string] = ["data-availability", variant.available ? "available" : "sold-out"];
    if (buy !== null) {
      if (!formPlaced) buttonsBeforeForm = true;
      if (!deferred) bought.add(variant.id);
      const intent = read("data-buy-intent") === "buy" ? "buy" : "add";
      const flags: Array<[string, null]> = [];
      // As the form's own buttons: off while sold out or while nothing can
      // be bought here, and Buy now gone then.
      const off = !variant.available || page.blocked;
      if (off) flags.push(["disabled", null]);
      if (off && intent === "buy") flags.push(["hidden", null]);
      return write(tag, [
        // The host shows and hides a buy button (sold out, a cart line being
        // edited); a buy button is never also a choice: it buys.
        ...kept.filter(([name]) => name !== "data-buy-intent" && name !== "hidden" && name !== "data-choose-variant"),
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
    choicesBound = true;
    // The SKU the page opens on is drawn chosen, before any script.
    const selected = variant.id === page.opening;
    const kind: Array<[string, string]> = tag === "a"
      ? [["href", `${product.url}?variant=${encodeURIComponent(variant.id)}`], ...(selected ? [["aria-current", "true"] as [string, string]] : [])]
      : [["type", "button"], ["aria-pressed", String(selected)]];
    return write(tag, [
      // A choice never also buys: an <a> would buy with JavaScript and only choose without.
      ...kept.filter(([name]) => name !== "data-buy-variant" && name !== "data-buy-intent"),
      ...kind,
      ["data-state", selected ? "selected" : "unselected"],
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
    const inDeferred = deferredAt(part.html);
    return { ...part, html: part.html.replace(CONTROL_TAG, (whole: string, tag: string, rest: string, at: number) => {
      // Still bound (the nearest bound control wins a press), but a button in a link is invalid HTML that
      // assistive technology and switch users cannot reach reliably: the docs teach sibling controls.
      if (tag === "button" && rest.includes("data-buy-variant") && insideChoiceLink(part.html, at)) {
        warnOnce(`${markup.pluginId}:buy-in-choice-link`, `${markup.pluginId} product_main skin puts a buyVariant button inside a chooseVariant link: a button inside a link is invalid HTML that keyboard, screen reader and switch users cannot use reliably. Make them siblings inside the card (a <div>).`);
      }
      return bindTag(whole, tag, rest, inDeferred(at));
    }) };
  });

  // Every SKU that can be bought has a control (and the skin has some).
  const coversEvery = (controls: ReadonlySet<string>) => controls.size > 0 && product.variants.every((variant) => !variant.available || controls.has(variant.id));
  const coversEveryBuyableSku = coversEvery(covered);
  const buysEveryBuyableSku = coversEvery(bought);
  let ownButtonsOff = false;
  const bound = parts.map((part) => {
    if (part.kind !== "embed" || part.embed !== "buy_form") return part;
    const dropped = new Set<string>();
    if (part.data.options === "false" && !coversEveryBuyableSku) {
      dropped.add("options");
      if (product.options.length > 0) {
        warnOnce(`${markup.pluginId}:buy-form-options`, `${markup.pluginId} product_main skin asks for <BuyForm options={false} /> without a chooseVariant or buyVariant control (outside deferred markup) for every buyable SKU: the store draws the options.`);
      }
    }
    if (part.data.actions === "false") {
      if (buysEveryBuyableSku) ownButtonsOff = true;
      else {
        dropped.add("actions");
        warnOnce(`${markup.pluginId}:buy-form-actions`, `${markup.pluginId} product_main skin asks for <BuyForm actions={false} /> without a buyVariant button (outside deferred markup) for every buyable SKU: the store draws its Add to cart and Buy now.`);
      }
    }
    return dropped.size === 0 ? part : { ...part, data: Object.fromEntries(Object.entries(part.data).filter(([name]) => !dropped.has(name))) };
  });
  if (buttonsBeforeForm || ownButtonsOff) bound.unshift({ kind: "html", html: defaultSubmit(page.blocked) });
  // A `?variant=` link's SKU is drawn chosen before the first paint.
  if (choicesBound) bound.push({ kind: "html", html: `<script>${SKIN_CHOICE_PREPAINT_SCRIPT}</script>` });
  return { ...markup, parts: bound };
}
