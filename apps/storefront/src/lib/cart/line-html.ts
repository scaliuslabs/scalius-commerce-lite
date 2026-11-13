/**
 * The cart page's line, drawn as HTML from the line's view (`cartLineView`):
 * the same facts the drawer draws, in the cart page's markup and its
 * checkout-language words. Every value is escaped; the controls call the
 * cart page's globals (`removeFromCart`, `updateCartQuantity`, `editCartLine`).
 */
import { cartCallAttributes } from "./cart-calls";
import { getProductImageUrl } from "@/lib/product-media";
import type { CartLineView } from "./line-view";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/** The cart page's words on a line, already filled in with the line's name where they name it. */
export interface CartLineHtmlWords {
  remove: string;
  decrease: string;
  increase: string;
  edit: string;
  editLabel: string;
  each: string;
  digital: string;
  service: string;
  shipsFree: string;
  /** A free line's price as one phrase ("Free, was ৳150"). */
  freeLine: (was: string) => string;
  /** What the line says about its stock (`cartLineStockText`), or null. */
  stock: string | null;
}

export interface CartLineHtmlSlots {
  words: CartLineHtmlWords;
  /** The line's key (its controls call the cart by it, `cart-calls.ts`). */
  cartKey: string;
  /** The id of the line's inputs list (they describe its controls). */
  inputsId: string;
  /** The controls' ` aria-describedby="…"` attribute, or "". */
  describedBy: string;
  /** The line's issue and its repair, drawn under its quantity and price; "" without one. */
  issueBlock: string;
  /** A store app's rule about the line; "" without one. */
  ruleBlock: string;
}

const STEPPER_BUTTON =
  "flex h-full w-11 items-center justify-center text-sm text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:text-muted-foreground disabled:hover:bg-transparent sm:w-9";

function detailsHtml(view: CartLineView, slots: CartLineHtmlSlots): string {
  const { words } = slots;
  const options = view.options
    .map((option) => `<span class="block" data-cart-line-option>${escapeHtml(option.name)}: ${escapeHtml(option.label)}</span>`)
    .join("");
  const purchaseOptions = view.purchaseOptions
    .map((option) => `<span class="block font-medium text-foreground" data-cart-line-purchase-option>${escapeHtml(option.title)}</span>`)
    .join("");
  // An input's row names its key: the app inputs' controls replace their rows once drawn.
  const rows = [
    ...view.inputs.map((input) => `<li class="break-words" data-property-key="${escapeHtml(input.key)}">${escapeHtml(input.text)}</li>`),
    ...view.components.map((component) => `<li class="break-words" data-cart-line-component>${escapeHtml(component)}</li>`),
  ].join("");
  const edit = view.editHref
    ? `<a href="${escapeHtml(view.editHref)}" class="mt-0.5 inline-flex min-h-11 items-center text-sm font-medium text-foreground underline underline-offset-2 hover:text-primary sm:min-h-0" aria-label="${escapeHtml(words.editLabel)}"${slots.describedBy} ${cartCallAttributes("editCartLine", slots.cartKey)} data-cart-line-edit>${escapeHtml(words.edit)}</a>`
    : "";
  const properties = rows
    ? `<div class="mt-0.5 text-sm text-muted-foreground" data-cart-line-properties><ul${view.inputs.length > 0 ? ` id="${escapeHtml(slots.inputsId)}"` : ""}>${rows}</ul>${edit}</div>`
    : "";
  const fulfilment = view.fulfilment === "ships-free"
    ? `<span class="block font-medium text-foreground" data-cart-line-fulfilment="ships-free">${escapeHtml(words.shipsFree)}</span>`
    : view.fulfilment
      ? `<span class="block" data-cart-line-fulfilment="${view.fulfilment}">${escapeHtml(view.fulfilment === "digital" ? words.digital : words.service)}</span>`
      : "";
  return options + purchaseOptions + properties + fulfilment;
}

function priceHtml(view: CartLineView, words: CartLineHtmlWords): string {
  // A free line reads as the receipt draws it: struck, then zero, heard as one phrase.
  const amount = view.compareAt
    ? `<span class="sr-only">${escapeHtml(words.freeLine(view.compareAt))}</span><span aria-hidden="true"><s class="me-1.5 text-muted-foreground" data-cart-line-compare-at>${escapeHtml(view.compareAt)}</s><span data-cart-line-amount>${escapeHtml(view.linePrice)}</span></span>`
    : `<span data-cart-line-amount>${escapeHtml(view.linePrice)}</span>`;
  const unit = view.unitPrice
    ? `<div class="text-sm tabular-nums text-muted-foreground" data-cart-line-unit-price>${escapeHtml(view.unitPrice)} ${escapeHtml(words.each)}</div>`
    : "";
  return `<div class="text-end"><div class="text-sm font-medium tabular-nums text-foreground sm:text-base" data-cart-line-price${view.free ? " data-cart-line-free" : ""}>${amount}</div>${unit}</div>`;
}

export function cartLineHtml(view: CartLineView, slots: CartLineHtmlSlots): string {
  const { words, cartKey, describedBy } = slots;
  const key = escapeHtml(view.key);
  // The quantity and the price stay on every line, an issue or not: the issue says what is wrong under them.
  const quantityRow = `<div class="mt-2 flex min-h-11 items-center justify-between gap-2">
              <div class="flex h-11 items-center overflow-hidden rounded-md ring-1 ring-inset ring-border sm:h-9">
                <button type="button" aria-label="${escapeHtml(words.decrease)}"${describedBy} class="${STEPPER_BUTTON}" ${cartCallAttributes("updateCartQuantity", cartKey, view.decreaseTo)}>−</button>
                <span class="flex h-full min-w-8 items-center justify-center px-1 text-center text-sm tabular-nums text-foreground" aria-live="polite" data-cart-line-quantity>${escapeHtml(view.quantityText)}</span>
                <button type="button" aria-label="${escapeHtml(words.increase)}"${describedBy} ${view.increaseBlocked ? "disabled" : ""} class="${STEPPER_BUTTON}" ${cartCallAttributes("updateCartQuantity", cartKey, view.increaseTo)}>+</button>
              </div>
              ${priceHtml(view, words)}
            </div>${view.stock?.state === "at-limit" && words.stock ? `
            <p class="mt-1 text-xs text-muted-foreground" data-cart-line-limit>${escapeHtml(words.stock)}</p>` : ""}${slots.issueBlock}`;
  return `
      <li class="py-3 first:pt-0" data-line-key="${key}"><div class="flex gap-3">
          <div class="h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-muted sm:h-20 sm:w-20"><img src="${escapeHtml(getProductImageUrl(view.image, 96))}" alt="" width="80" height="80" loading="lazy" decoding="async" class="h-full w-full object-contain object-center" /></div>
          <div class="min-w-0 flex-1">
            <div class="flex justify-between gap-2">
              <div class="min-w-0"><h3 class="line-clamp-2 text-sm font-medium text-foreground sm:text-base"><a href="${escapeHtml(view.productHref)}" class="hover:text-muted-foreground" data-cart-line-name>${escapeHtml(view.name)}</a></h3><div class="mt-0.5 text-sm text-muted-foreground">${detailsHtml(view, slots)}</div><div class="mt-1.5 grid max-w-sm gap-2" data-cart-line-inputs data-line-key="${key}" hidden></div></div>
              <button type="button" aria-label="${escapeHtml(words.remove)}"${describedBy} class="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring sm:h-9 sm:w-9" ${cartCallAttributes("removeFromCart", cartKey)}><svg aria-hidden="true" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M6 18L18 6M6 6l12 12" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
            </div>
            ${quantityRow}
            ${slots.ruleBlock}
          </div>
        </div></li>`;
}
