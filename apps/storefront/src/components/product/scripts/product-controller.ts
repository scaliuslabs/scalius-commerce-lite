import { checkoutText } from "@/lib/checkout-text";
import { addToCart, cartLineKeyFor, replaceCartLine, startBuyNow, type CartAddFailureReason, type CartItemOption } from "@/store/cart";
import { clearCartLineEdit, readCartLineEdit, type CartLineEdit } from "@/lib/cart/line-edit";
import { getCurrencyCode } from "@/lib/currency";
import {
  calculateVariantPrice,
  formatPrice,
  formatDiscountBadge,
  getBuyerVariantPricePresentation,
  type ProductPricing,
  type VariantPricing,
  type DiscountType,
} from "../lib/pricing-engine";

import { toLatinDigits } from "@scalius/shared/phone-input";
import {
  createInitialSelection,
  filterVariantsBySelection,
  getVariantOptionAvailabilityMap,
  loadOptionsFromDOM,
  loadVariantsFromDOM,
  pricedVariantForOption,
  reconcileSelectionForValue,
  resolveExactVariantSelection,
  resolveVariantImageForSelection,
  shouldShowStartingVariantPrice,
  validateSelection,
  type Variant,
  type VariantSelection,
  type VariantOptionAvailability,
} from "../lib/variant-state-machine";
import {
  validateAddToCart,
  clampQuantity,
  QUANTITY_CONSTRAINTS,
} from "../lib/product-validation";
import { getBuyerStockSummary } from "@/lib/product-sellable-variants";
import type { ProductOptionDefinition } from "@/lib/api";
import { resolveVariantCartMedia } from "../lib/cart-media";
import {
  getProductActionsPresentation,
  type ProductActionPresentation,
} from "../lib/product-actions";
import { moneyPlaces, unitPriceWithSurcharge } from "../lib/line-price";
import { BUYER_INPUT_FIELD_PREFIX, SKIN_BUY_CONTROL, SKIN_CHOOSE_CONTROL } from "../lib/buy-form";
import { buyFormQuery, buyFormQueryAll, buyFormScopes } from "../lib/buy-scope";
import type { BuyerInputsController } from "./buyer-inputs-controller";
import { pagePath } from "@/lib/presence-url";
import { normalizeCartLinePurchaseOptions, type CartLinePurchaseOption } from "@/lib/cart/purchase-option";
import { isAppScopedKey } from "@scalius/shared/plugins/ids";
import { DEFERRED_REVEAL_EVENT, STALE_ASSET_EVENT } from "@/scripts/browser-events";
import type { StorefrontProductError } from "@scalius/shared/plugins/storefront-protocol";

// The buy form's one authority: its option buttons, a product_main skin's
// bound SKU controls (`chooseVariant`, `buyVariant`) and app islands
// (`context.product`) all go through this controller's selection and add.
// Every part of the form is looked up inside its container, which carries
// a host-only marker (`data-sx-product-summary`; the sanitizer strips every
// `data-sx-*` from app markup), or inside a part a product_main skin placed
// apart from it (`data-sx-buy-part`, lib/buy-scope.ts), so a skin's own
// `.product-price`, `[data-action]` or look-alike container is never taken over. The product's
// facts come from the page's `#product-container`, which wraps the skin.

const state = {
  variants: [] as Variant[],
  options: [] as ProductOptionDefinition[],
  selection: {} as VariantSelection,
  productPricing: null as ProductPricing | null,
  unavailableRequestedVariant: null as Variant | null,
  hasRequestedVariant: false,
  hasVariantSelectionInteraction: false,
  buyerInputs: null as BuyerInputsController | null,
  /** A cart line being edited ("Edit" in the cart): the add button updates it. */
  edit: null as CartLineEdit | null,
  /**
   * The product can't be bought, and a note on the page says why: its
   * buyer-input setup is broken, or it is paid only online and checkout
   * takes no online payment.
   */
  purchaseBlocked: false,
  adding: false,
  /** Why the last add or Buy now was refused, while the form says so. */
  error: null as StorefrontProductError | null,
};

const cache = {
  container: null as HTMLElement | null,
  /** The buy form's container: every part below is looked up inside it, or in a part placed apart. */
  summary: null as HTMLElement | null,
  /** The container, then the parts a skin placed apart from it (`<BuyFormPart />`). */
  scopes: [] as Element[],
  /** The buy form (with or without buyer inputs). */
  form: null as HTMLFormElement | null,
  actions: null as HTMLElement | null,
  quantity: null as HTMLInputElement | null,
  optionButtons: [] as HTMLButtonElement[],
  /** The `select` option layout: one dropdown per option axis. */
  optionSelects: [] as HTMLSelectElement[],
  /** The screen reader's line for a choice ("Selected: Red"). */
  announcer: null as HTMLElement | null,
  /** Where the purchase's problems show (`data-buy-part="status"`). */
  statusPart: null as HTMLElement | null,
  /** The buttons' row (`data-buy-part="actions"`). */
  actionsPart: null as HTMLElement | null,
  unavailableNotice: null as HTMLElement | null,
  stockBadge: null as HTMLElement | null,
  stockText: null as HTMLElement | null,
  addButton: null as HTMLButtonElement | null,
  buyButton: null as HTMLButtonElement | null,
  addLabel: null as HTMLElement | null,
  buyLabel: null as HTMLElement | null,
  priceElements: [] as HTMLElement[],
  originalPriceElements: [] as HTMLElement[],
  discountBadge: null as HTMLElement | null,
};

/**
 * One of the buy form's own parts, by its host-only role (`data-sx-buy`):
 * the sanitizer strips `data-sx-*` from app markup, so an app component in
 * the buy box's slots (`product.buy_box.before`, `.after`), which sit inside
 * the form's container, never stands in for one, whatever it copies.
 */
function part<T extends Element = HTMLElement>(role: string): T | null {
  return buyFormQuery<T>(cache.scopes, `[data-sx-buy="${role}"]`);
}

function parts<T extends Element = HTMLElement>(role: string): T[] {
  return buyFormQueryAll<T>(cache.scopes, `[data-sx-buy="${role}"]`);
}

/** The purchase's problem as the form shows it (showError). */
let errorMessage: HTMLElement | null = null;

/**
 * Whether the product's buyer inputs work, once their script is in (or
 * failed to load); null for a product without them. An add waits for it;
 * when it failed, the add posts the form the no-JavaScript way after the
 * form's own checks (an edited line's update is refused), and the page
 * reloads only if that loses nothing the buyer typed (`staleAsset`).
 */
let buyerInputsReady: Promise<boolean> | null = null;

/**
 * One of the store's lazy scripts failed to load (a page cached before a
 * deploy): the page's stale-asset recovery reloads it, unless the buyer has
 * typed an answer that a reload would lose. An edited line's own answers
 * (`prefillEdit`) are no loss: the reloaded page fills them again.
 */
function staleAsset() {
  const typed = buyerInputFields().some((field) => answer(field) !== (prefilled.get(field) ?? ""));
  if (!typed) window.dispatchEvent(new Event(STALE_ASSET_EVENT));
}

type BuyerInputField = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

/** The buy form's buyer-input fields (`property.<key>`; only its inputs, text areas and selects carry such names). */
function buyerInputFields(): BuyerInputField[] {
  return (Array.from(cache.form?.elements ?? []) as BuyerInputField[]).filter((field) => field.name?.startsWith(BUYER_INPUT_FIELD_PREFIX));
}

/** A field's answer as the cart line keeps it: a ticked box is "true", an empty one "". */
function answer(field: BuyerInputField): string {
  return field instanceof HTMLInputElement && field.type === "checkbox" ? (field.checked ? "true" : "") : field.value;
}

/** The answers `prefillEdit` wrote, by field. */
const prefilled = new Map<BuyerInputField, string>();

function parseDiscountType(value?: string): DiscountType {
  return value === "percentage" || value === "flat" ? value : null;
}

function number(value?: string) {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

export function init() {
  cache.container = document.querySelector<HTMLElement>("[data-sx-product-container]");
  const summary = document.querySelector<HTMLElement>("[data-sx-product-summary]");
  if (!cache.container || !summary) return;
  cache.summary = summary;
  cache.scopes = buyFormScopes(document, summary);
  // The form itself may be a part a skin placed apart (`<BuyFormPart name="inputs" />`).
  cache.form = buyFormQuery<HTMLFormElement>(cache.scopes, "form[data-sx-buy-form]");
  cache.actions = part("actions");
  cache.quantity = part<HTMLInputElement>("quantity");
  cache.optionButtons = parts<HTMLButtonElement>("option");
  cache.optionSelects = parts<HTMLSelectElement>("option-select");
  cache.announcer = part("announcer");
  cache.statusPart = part("status");
  cache.actionsPart = part("ctas");
  cache.unavailableNotice = part("unavailable-notice");
  cache.stockBadge = part("stock-badge");
  cache.stockText = part("stock-text");
  cache.addButton = part<HTMLButtonElement>("add");
  cache.buyButton = part<HTMLButtonElement>("buy");
  cache.addLabel = part("add-label");
  cache.buyLabel = part("buy-label");
  cache.priceElements = parts("price");
  cache.originalPriceElements = parts("regular-price");
  cache.discountBadge = part("discount");
  errorMessage = null;

  state.variants = loadVariantsFromDOM(summary);
  state.options = loadOptionsFromDOM(summary);
  state.productPricing = {
    basePrice: number(cache.container.dataset.productOriginalPrice),
    discountType: parseDiscountType(
      cache.container.dataset.productDiscountType,
    ),
    discountPercentage:
      number(cache.container.dataset.productDiscountPercentage) || null,
    discountAmount:
      number(cache.container.dataset.productDiscountAmount) || null,
    currencyDecimalPlaces: Math.min(
      6,
      Math.max(
        0,
        Number.parseInt(
          cache.container.dataset.currencyDecimalPlaces || "2",
          10,
        ) || 2,
      ),
    ),
  };

  const requestedId = new URLSearchParams(window.location.search).get(
    "variant",
  );
  state.hasRequestedVariant = Boolean(requestedId);
  state.hasVariantSelectionInteraction = false;
  const requested = requestedId
    ? resolveExactVariantSelection(state.variants, { variantId: requestedId })
    : null;
  state.unavailableRequestedVariant =
    requested && !getBuyerStockSummary([requested.variant]).canPurchaseAny
      ? requested.variant
      : null;
  // A link to a sold-out combination still shows that combination, marked sold out.
  state.selection = requested?.selection ??
    createInitialSelection(state.options, state.variants);
  hideExpiredOffers();
  warranty = readWarranty();

  state.purchaseBlocked = Boolean(part("blocked"));
  endAdd();
  state.error = null;
  missingOption = null;
  state.buyerInputs = null;
  // A cart line being edited ("Edit" in the cart; products with buyer
  // inputs only) is known at once: the buttons say "Update cart" from the
  // first frame, and its answers fill the fields the buyer has not touched.
  // The buyer inputs are the buy form itself (ProductBuyerInputs.astro), never a look-alike.
  const buyerForm = cache.form?.hasAttribute("data-buyer-inputs") ? cache.form : null;
  const productId = cache.container.dataset.productId;
  state.edit = buyerForm && productId ? readCartLineEdit(productId) : null;
  prefilled.clear();
  if (state.edit) prefillEdit(state.edit);
  // The inputs' own script loads only for a product that has them.
  buyerInputsReady = buyerForm
    ? loadBuyerInputs(buyerForm).then(() => true, () => {
      staleAsset();
      return false;
    })
    : null;

  initQuantity();
  bindOptions();
  bindActions();
  loadExtras();
  window.addEventListener("pageshow", restoreFromHistory, { signal: extrasBinding!.signal });
  for (const input of purchaseOptionInputs()) input.addEventListener("change", changed);
  refresh(true);
  // The pre-paint hold of a `?variant=` link (VARIANT_PREPAINT_SCRIPT) ends in
  // the frame that paints the linked SKU.
  requestAnimationFrame(() => {
    delete document.documentElement.dataset.variantPending;
  });
}

/** The live side of the buyer-inputs form (buyer-inputs-controller.ts). An add waits for it. */
async function loadBuyerInputs(form: HTMLFormElement) {
  const { initBuyerInputs } = await import("./buyer-inputs-controller");
  if (cache.form !== form) return;
  state.buyerInputs = initBuyerInputs(form, () => {
    // Editing an answer takes its message away; the problem ends with the last one.
    const shown = state.buyerInputs?.form.querySelector("[data-buyer-input-error]:not(.hidden)");
    if (state.error === "input_invalid" && !shown) state.error = null;
    dropRefusal();
    refresh();
  });
  refresh();
}

/** The edited line's quantity, answers and purchase options, in what the buyer has not changed yet. */
function prefillEdit(edit: CartLineEdit) {
  if (cache.quantity?.value === "1") cache.quantity.value = String(edit.quantity);
  const answers = new Map(edit.properties.map(({ key, value }) => [`${BUYER_INPUT_FIELD_PREFIX}${key}`, value]));
  for (const field of buyerInputFields()) {
    const value = answers.get(field.name);
    // A field the buyer already answered keeps their answer.
    if (value === undefined || answer(field)) continue;
    if (field instanceof HTMLInputElement && field.type === "checkbox") field.checked = value === "true";
    else field.value = value;
    prefilled.set(field, answer(field));
  }
  if (selectedPurchaseOptions()?.length === 0) selectPurchaseOptions(edit.purchaseOptions ?? []);
}

/**
 * The buy form's purchase-option radios: the apps' ways to buy, one radio
 * group per app (its own "none"), or one group with a one-time purchase.
 */
function purchaseOptionInputs(): HTMLInputElement[] {
  return parts<HTMLInputElement>("purchase-option");
}

/** Checks `ids` in their groups; every other group goes back to its "none". */
function selectPurchaseOptions(ids: readonly string[]) {
  const groups = new Map<string, HTMLInputElement[]>();
  for (const input of purchaseOptionInputs()) groups.set(input.name, [...(groups.get(input.name) ?? []), input]);
  for (const inputs of groups.values()) {
    const match = inputs.find((input) => input.value && ids.includes(input.value)) ?? inputs.find((input) => input.value === "");
    if (match) match.checked = true;
  }
}

/**
 * The chosen apps' options, one per app, sorted by id; empty for a one-time
 * purchase (or a page without options); null when more apps' options are
 * chosen than one line holds, which the buyer is told (never bought one-time).
 */
function selectedPurchaseOptions(): CartLinePurchaseOption[] | null {
  const chosen = purchaseOptionInputs()
    .filter((entry) => entry.checked && entry.value)
    .map((input) => ({ id: input.value, title: input.dataset.purchaseOptionTitle || input.value }));
  return chosen.length === 0 ? [] : normalizeCartLinePurchaseOptions(chosen);
}

/** What the buyer checked, for islands: the line's options, or every checked one when there are more than a line takes. */
function checkedPurchaseOptions(): CartLinePurchaseOption[] {
  return selectedPurchaseOptions() ?? purchaseOptionInputs()
    .filter((entry) => entry.checked && entry.value)
    .map((input) => ({ id: input.value, title: input.dataset.purchaseOptionTitle || input.value }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

/** Offers end on their own schedule: hide one that ended while the page was cached. */
function hideExpiredOffers() {
  const now = Date.now() / 1000;
  parts("offer").forEach((offer) => {
    const endsAt = Number(offer.dataset.offerEnds);
    if (endsAt > 0 && endsAt <= now) offer.hidden = true;
  });
}

/**
 * The quantity accepts Bangla digits, never changes silently, and says so
 * when it is capped at the most one order line can hold.
 */
function typedQuantity(value: string): number {
  const latin = toLatinDigits(value).trim();
  // A minus sign is a quantity below one ("-2" becomes 1), never "2".
  return /^[-−]/u.test(latin) ? 0 : Number.parseInt(latin.replace(/\D/g, ""), 10);
}

/** The quantity the field means now, without touching it. */
function currentQuantity(): number {
  const typed = typedQuantity(cache.quantity?.value ?? "1");
  return clampQuantity(Number.isFinite(typed) ? typed : 1);
}

/** The quantity the field means, written back to it, with the limit's message when the buyer typed past it. */
function readQuantity(): number {
  const input = cache.quantity;
  const message = part("quantity-message");
  if (!input) return 1;
  const typed = typedQuantity(input.value);
  const quantity = currentQuantity();
  input.value = String(quantity);
  const capped = Number.isFinite(typed) && typed > QUANTITY_CONSTRAINTS.MAX;
  if (message) {
    message.textContent = capped
      ? checkoutText(cache.actions?.dataset.quantityLimitText ?? "", { count: QUANTITY_CONSTRAINTS.MAX })
      : "";
    message.classList.toggle("hidden", !capped);
  }
  return quantity;
}

function initQuantity() {
  const input = cache.quantity;
  if (!input) return;
  const update = (delta: number) => {
    input.value = String(readQuantity() + delta);
    readQuantity();
    changed();
  };
  part("quantity-minus")?.addEventListener("click", () => update(-1));
  part("quantity-plus")?.addEventListener("click", () => update(1));
  input.addEventListener("change", () => {
    readQuantity();
    changed();
  });
  // Typing: the field is read as the buyer types, corrected when they leave it.
  input.addEventListener("input", changed);
}

/**
 * The buyer changed what they would buy (the SKU, quantity, an answer or the
 * purchase option): a refused add's message (`unavailable`, `quantity_limit`,
 * `failed`) no longer applies and goes. A missing option or answer stays
 * until the buyer gives it. Callers publish (a choice: in its frame).
 */
function dropRefusal() {
  if (state.error === "unavailable" || state.error === "quantity_limit" || state.error === "failed") withdrawError();
}

/** A change islands hear at once (the quantity, the purchase option). */
function changed() {
  dropRefusal();
  publish();
}

/**
 * Chooses a selection, as an option button or a skin's SKU control does:
 * the choice shows (and is announced) in the next frame, the URL names the
 * chosen SKU, and the message under each option just chosen goes.
 */
function applySelection(selection: VariantSelection, announcement: string, chosen: readonly string[]) {
  state.hasVariantSelectionInteraction = true;
  state.unavailableRequestedVariant = null;
  for (const definitionId of chosen) showMissingOption(definitionId, "");
  dropRefusal();
  state.selection = selection;
  if (cache.announcer && announcement)
    cache.announcer.textContent = checkoutText(
      cache.actions?.dataset.optionSelectedText || "{value}",
      { value: announcement },
    );
  refresh(true);
  replaceVariantUrl();
}

/** Chooses one whole SKU (every option of it at once); false for an id the page does not sell. */
function chooseVariant(variantId: string): boolean {
  const chosen = resolveExactVariantSelection(state.variants, { variantId });
  if (!chosen) return false;
  applySelection(
    chosen.selection,
    chosen.variant.selectedOptions.map((option) => option.value).join(" / "),
    state.options.map((option) => option.id),
  );
  return true;
}

function bindOptions() {
  const order = state.options.map((option) => option.id);
  // The `select` layout chooses the same way: a value, through the form's one selection.
  for (const select of cache.optionSelects) {
    const definitionId = select.dataset.optionDefinitionId;
    if (!definitionId) continue;
    select.addEventListener("change", () => {
      const valueId = select.value;
      if (!valueId || state.selection[definitionId] === valueId) return;
      applySelection(
        reconcileSelectionForValue(state.variants, definitionId, valueId, state.selection, order),
        select.selectedOptions[0]?.dataset.optionValue || "",
        [definitionId],
      );
    });
  }
  cache.optionButtons.forEach((button, _index, buttons) => {
    const definitionId = button.dataset.optionDefinitionId;
    const valueId = button.dataset.optionValueId;
    if (!definitionId || !valueId) return;
    // Options behave like radio buttons: choosing the chosen value keeps it.
    const choose = () => {
      applySelection(
        state.selection[definitionId] === valueId
          ? state.selection
          : reconcileSelectionForValue(state.variants, definitionId, valueId, state.selection, order),
        button.dataset.optionValue || "",
        [definitionId],
      );
    };
    button.addEventListener("click", choose);
    button.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        choose();
        return;
      }
      const direction =
        event.key === "ArrowRight" || event.key === "ArrowDown"
          ? 1
          : event.key === "ArrowLeft" || event.key === "ArrowUp"
            ? -1
            : 0;
      if (!direction) return;
      const siblings = buttons.filter(
        (candidate) => candidate.dataset.optionDefinitionId === definitionId,
      );
      const current = siblings.indexOf(button);
      for (let offset = 1; offset < siblings.length; offset += 1) {
        const next =
          siblings[
            (current + direction * offset + siblings.length) % siblings.length
          ];
        if (next && !next.disabled) {
          event.preventDefault();
          next.focus();
          break;
        }
      }
    });
  });
}

function bindActions() {
  // The buttons' row may be a part the skin placed apart from the form: it listens too.
  const rows = [cache.actions, cache.actionsPart && !cache.actions?.contains(cache.actionsPart) ? cache.actionsPart : null];
  for (const row of rows) row?.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    // With buyer inputs the buttons submit the form, which the script replaces.
    if (target.closest('[data-sx-buy="add"]')) {
      event.preventDefault();
      void add(false);
    }
    if (target.closest('[data-sx-buy="buy"]')) {
      event.preventDefault();
      void add(true);
    }
  });
  // Enter in a text field (a buyer input or quantity) submits through the
  // form's first button (a skin's buyVariant buttons come after the host's
  // default one); anything else still lands here, as the buyer's own choice.
  cache.form?.addEventListener("submit", (event) => {
    const submitter = (event as SubmitEvent).submitter;
    event.preventDefault();
    void add(Boolean(submitter?.matches('[data-sx-buy="buy"]')));
  });
}

/** Whether the page has a skin's bound SKU controls (placed now or in deferred markup). */
let skinControls = false;
/** Publishes the form's state to app islands, once its script has loaded (island-state.ts). */
let publishState: (() => void) | null = null;
let extrasBinding: AbortController | null = null;

/**
 * What only some product pages use runs only there: a product_main skin's
 * SKU controls (`chooseVariant`, `buyVariant`; placed now or in deferred
 * markup) are taken and kept in step, and the state for app islands
 * (`context.product`; islands live in app components) loads its script.
 */
function loadExtras() {
  extrasBinding?.abort();
  publishState = null;
  const { signal } = (extrasBinding = new AbortController());
  const bound = "[data-sx-bound]";
  skinControls = Boolean(document.querySelector(bound))
    || Array.from(document.querySelectorAll<HTMLTemplateElement>("scalius-deferred>template")).some((template) => template.content.querySelector(bound));
  if (skinControls) {
    // Their presses and state are the form's from the first frame.
    document.addEventListener("click", pressSkinControl, { capture: true, signal });
    // Controls in deferred markup take the form's state when they enter the page.
    document.addEventListener(DEFERRED_REVEAL_EVENT, syncSkinControls, { signal });
  }
  if (cache.summary && document.querySelector("[data-sx-app]")) {
    const summary = cache.summary;
    void import("./island-state").then(({ islandState }) => {
      if (signal.aborted) return;
      publishState = islandState({ state, summary, selected: exactVariant, quantity: currentQuantity, options: checkedPurchaseOptions, stock: getBuyerStockSummary });
      // The first state goes out in a frame too, never ahead of what the page shows.
      requestAnimationFrame(publish);
    }, staleAsset);
  }
}

/**
 * Brings every bound SKU control on the page in step with the form: the
 * chosen SKU marked, a buy button off as the form's own buttons are (Buy
 * now gone then), none while a cart line is edited (the form updates it).
 */
function syncSkinControls() {
  if (!skinControls) return;
  const chosen = exactVariant()?.id;
  for (const control of document.querySelectorAll<HTMLElement>(SKIN_CHOOSE_CONTROL)) {
    const on = chosen !== undefined && control.dataset.chooseVariant === chosen;
    control.dataset.state = on ? "selected" : "unselected";
    if (control instanceof HTMLButtonElement) control.setAttribute("aria-pressed", String(on));
    else if (on) control.setAttribute("aria-current", "true");
    else control.removeAttribute("aria-current");
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>(SKIN_BUY_CONTROL)) {
    const variant = state.variants.find((candidate) => candidate.id === button.dataset.buyVariant);
    button.disabled = !variant || !getBuyerStockSummary([variant]).canPurchaseAny || state.purchaseBlocked;
    button.hidden = Boolean(state.edit) || (button.dataset.buyIntent === "buy" && button.disabled);
  }
}

/**
 * A press on a product_main skin's SKU control (`chooseVariant`,
 * `buyVariant`). The nearest bound control is the one pressed: a buy button
 * inside a choice card buys. A choice goes through the form's selection; a
 * buy button chooses its SKU, is taken at once (a second press is refused),
 * then, after the frame that shows the SKU (and tells islands), runs the
 * form's own add or Buy now. While a cart line is edited the form's
 * "Update cart" is the only way to buy.
 */
function pressSkinControl(event: MouseEvent) {
  if (!(event.target instanceof Element)) return;
  const button = event.target.closest<HTMLButtonElement>(SKIN_BUY_CONTROL);
  const choice = event.target.closest<HTMLElement>(SKIN_CHOOSE_CONTROL);
  if (button && (!choice || choice.contains(button))) {
    event.preventDefault();
    if (button.disabled || state.adding || state.purchaseBlocked || state.edit) return;
    if (!chooseVariant(button.dataset.buyVariant ?? "")) return;
    state.adding = true;
    requestAnimationFrame(() => {
      state.adding = false;
      void add(button.dataset.buyIntent === "buy", button);
    });
    return;
  }
  // A new tab or window follows a link itself.
  if (!choice || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  chooseVariant(choice.dataset.chooseVariant ?? "");
}

function replaceVariantUrl() {
  const url = new URL(window.location.href);
  const exact = resolveExactVariantSelection(
    state.variants,
    state.selection,
  )?.variant;
  if (exact) url.searchParams.set("variant", exact.id);
  else url.searchParams.delete("variant");
  url.searchParams.delete("size");
  url.searchParams.delete("color");
  history.replaceState(null, "", url.toString());
}

/**
 * Shows the current choice in the next frame: the form (its SKU field,
 * options, stock, buttons and price), the skin's controls and the gallery's
 * photo, then publishes the state to app islands, which so hear a change
 * only once the store shows it.
 */
function refresh(revealSelection = false) {
  requestAnimationFrame(() => {
    // The form's SKU field: what a post before the next frame, or without
    // the script, buys (with or without buyer inputs).
    const field = cache.form?.querySelector<HTMLInputElement>('input[type="hidden"][name="variant"]');
    if (field) field.value = exactVariant()?.id ?? "";
    updateOptionButtons();
    if (revealSelection) revealSelectedOptions();
    updateStockAndActions();
    updatePrice();
    updateVariantImage();
    updateWarrantyRows();
    publish();
  });
}

/** Tells app islands (`context.product`), on a page that has them (island-state.ts). */
function publish() {
  publishState?.();
}

/** The purchase's problem as islands read it (the form shows its words). */
function setError(error: StorefrontProductError | null) {
  state.error = error;
  publish();
}

export function revealSelectedOptions(roots: readonly ParentNode[] = cache.scopes.length ? cache.scopes : [document]) {
  roots.flatMap((root) => Array.from(root.querySelectorAll<HTMLElement>('[data-sx-buy="option-values"][data-option-overflow]'))).forEach((list) => {
    const selected = list.querySelector<HTMLElement>('.variant-option-btn[aria-pressed="true"]');
    if (!selected) return;
    const listRect = list.getBoundingClientRect();
    const selectedRect = selected.getBoundingClientRect();
    if (selectedRect.top < listRect.top) list.scrollTop += selectedRect.top - listRect.top;
    else if (selectedRect.bottom > listRect.bottom) list.scrollTop += selectedRect.bottom - listRect.bottom;
  });
}

const OPTION_CLASSES = [
  "bg-primary",
  "text-primary-foreground",
  "border-primary",
  "bg-muted",
  "border-dashed",
  "border-muted-foreground",
  "text-muted-foreground",
  "line-through",
  "cursor-not-allowed",
  "ring-2",
  "ring-destructive",
];

function updateOptionButtons() {
  for (const option of state.options) {
    const availability = getVariantOptionAvailabilityMap(
      state.variants,
      option.id,
      option.values.map((value) => value.id),
      state.selection,
    );
    // A dropdown shows the chosen value, and says which values are sold out or unavailable.
    for (const select of cache.optionSelects.filter((each) => each.dataset.optionDefinitionId === option.id)) {
      const chosen = state.selection[option.id] ?? "";
      for (const entry of Array.from(select.options)) {
        if (!entry.value) {
          entry.hidden = Boolean(chosen);
          continue;
        }
        const status = availability.get(entry.value) ?? "sold_out";
        const value = entry.dataset.optionValue || "";
        entry.dataset.optionAvailability = status;
        entry.textContent = status === "available" ? value : optionButtonLabel(option.name, value, status);
      }
      select.value = chosen;
    }
    const buttons = cache.optionButtons.filter((button) => button.dataset.optionDefinitionId === option.id);
    const optionPrices = new Map<string, number>();
    if (buttons.some((button) => button.querySelector("[data-option-price]"))) {
      for (const value of option.values) {
        const variant = pricedVariantForOption(state.variants, state.selection, option.id, value.id, state.options.length);
        if (variant?.discountedPrice != null) optionPrices.set(value.id, variant.discountedPrice);
      }
      // A price on each value only when the values are priced differently.
      if (new Set(optionPrices.values()).size <= 1) optionPrices.clear();
    }
    for (const button of buttons) {
      const valueId = button.dataset.optionValueId!;
      const status = availability.get(valueId) ?? "sold_out";
      const selected = state.selection[option.id] === valueId;
      const priceNode = button.querySelector<HTMLElement>("[data-option-price]");
      let optionPrice: string | null = null;
      if (priceNode) {
        optionPrice = optionPrices.has(valueId) ? formatPrice(optionPrices.get(valueId)!) : null;
        priceNode.textContent = optionPrice ?? "";
        priceNode.hidden = !optionPrice;
      }
      button.classList.remove(...OPTION_CLASSES);
      button.classList.add("bg-background", "text-foreground", "border-input");
      if (selected) {
        button.classList.remove(
          "bg-background",
          "text-foreground",
          "border-input",
        );
        button.classList.add("bg-primary", "text-primary-foreground", "border-primary");
      } else if (status === "incompatible") {
        button.classList.remove("bg-background", "border-input");
        button.classList.add(
          "bg-muted",
          "border-dashed",
          "border-muted-foreground",
        );
      } else if (status === "sold_out") {
        button.classList.remove("text-foreground");
        button.classList.add("text-muted-foreground");
      }
      // Dawn: sold-out values stay choosable, crossed out, so a buyer sees
      // the photo and the "Sold out" state.
      button.classList.toggle("line-through", status === "sold_out");
      button.dataset.optionAvailability = status;
      button.setAttribute("aria-pressed", String(selected));
      button.setAttribute(
        "aria-label",
        optionButtonLabel(
          option.name,
          button.dataset.optionValue || "",
          status,
        ) + (optionPrice ? ` ${optionPrice}.` : ""),
      );
    }
  }
}

function optionButtonLabel(
  name: string,
  value: string,
  status: VariantOptionAvailability,
) {
  // The page's words (ProductSummary.astro), so a Bangla page reads Bangla.
  const words = cache.actions?.dataset;
  const template = status === "sold_out"
    ? words?.optionSoldOutText || "{option}: {value}. Sold out."
    : status === "incompatible"
      ? words?.optionUnavailableText || "{option}: {value}. Not available with the current selection."
      : words?.optionValueText || "{option}: {value}";
  return checkoutText(template, { option: name, value });
}

function exactVariant() {
  return (
    resolveExactVariantSelection(state.variants, state.selection)?.variant ??
    null
  );
}

/**
 * The SKU the buy box shows (a link's sold-out SKU, else the chosen one) and
 * the SKUs its stock, price and warranty speak for: that one, else every SKU
 * the choice so far still allows.
 */
function shownVariants(): { exact: Variant | null; candidates: Variant[] } {
  const exact = state.unavailableRequestedVariant ?? exactVariant();
  if (exact) return { exact, candidates: [exact] };
  return {
    exact,
    candidates: Object.keys(state.selection).length ? filterVariantsBySelection(state.variants, state.selection) : state.variants,
  };
}

function updateStockAndActions() {
  const { exact, candidates } = shownVariants();
  const summary = getBuyerStockSummary(candidates);
  const copy = cache.actions?.dataset;
  const actions = getProductActionsPresentation({
    productName: cache.container?.dataset.productName ?? "Product",
    anyVariantAvailable: getBuyerStockSummary(state.variants).canPurchaseAny,
    chosenVariantSoldOut: Boolean(exact && !getBuyerStockSummary([exact]).canPurchaseAny),
    copy: {
      addToCartText: copy?.addToCartText ?? "",
      buyNowText: copy?.buyNowText ?? "",
      unavailableText: copy?.unavailableText ?? "",
    },
  });
  if (cache.unavailableNotice) {
    // A link to a sold-out SKU names it: "Size M / Colour Red: Sold out".
    const linked = state.unavailableRequestedVariant;
    cache.unavailableNotice.textContent = linked
      ? `${linked.selectedOptions.map((option) => `${option.name} ${option.value}`).join(" / ")}: ${copy?.unavailableText ?? ""}`
      : "";
    cache.unavailableNotice.classList.toggle("hidden", !linked);
  }
  if (cache.stockBadge) {
    cache.stockBadge.classList.toggle("text-primary", summary.tone === "available");
    cache.stockBadge.classList.toggle("text-destructive", summary.tone !== "available");
  }
  if (cache.stockText) {
    // The stock line speaks the store's language: sold out is the button's own word.
    cache.stockText.textContent =
      summary.text === "In Stock" ? copy?.stockInText || summary.text
        : summary.text === "Low Stock" ? copy?.stockLowText || summary.text
          : copy?.unavailableText || summary.text;
  }
  setButton(
    cache.addButton,
    cache.addLabel,
    actions.addToCart,
  );
  setButton(
    cache.buyButton,
    cache.buyLabel,
    actions.buyNow,
  );
  // Like Shopify, a sold-out product shows one "Sold out" button, not two.
  if (cache.buyButton) cache.buyButton.hidden = actions.buyNow.disabled;
  // A skin's `actions={false}`: the form's own buttons show only as the edited line's "Update cart".
  if (cache.actionsPart?.hasAttribute("data-sx-buy-off")) cache.actionsPart.hidden = !state.edit;
  if (state.purchaseBlocked) {
    if (cache.addButton) cache.addButton.disabled = true;
    if (cache.buyButton) {
      cache.buyButton.disabled = true;
      cache.buyButton.hidden = true;
    }
  } else if (state.edit && !actions.addToCart.disabled) {
    // Editing a cart line: one "Update cart" button replaces that line.
    const label = cache.actions?.dataset.updateCartText ?? "";
    if (cache.addLabel) cache.addLabel.textContent = label;
    cache.addButton?.setAttribute(
      "aria-label",
      `${label} — ${cache.container?.dataset.productName ?? "Product"}`,
    );
    if (cache.buyButton) cache.buyButton.hidden = true;
  }
  updateActionsState();
  syncSkinControls();
}

/** The buttons' row: `busy` while an add runs, `unavailable` while nothing chosen can be bought, else `ready`. */
function updateActionsState() {
  if (!cache.actionsPart) return;
  cache.actionsPart.dataset.state = state.adding ? "busy" : cache.addButton?.disabled ? "unavailable" : "ready";
}

function setButton(
  button: HTMLButtonElement | null,
  label: HTMLElement | null,
  presentation: ProductActionPresentation,
) {
  if (!button) return;
  button.disabled = presentation.disabled;
  button.setAttribute("aria-label", presentation.ariaLabel);
  if (label) label.textContent = presentation.label;
}

function updatePrice() {
  if (!state.productPricing) return;
  const { exact, candidates } = shownVariants();
  const presentation = getBuyerVariantPricePresentation(state.productPricing, candidates);
  // "From" only while the remaining choices are priced differently.
  const starting =
    shouldShowStartingVariantPrice(state.options.length > 0, exact) && presentation.isStartingAt;
  const basePricing = exact
    ? calculateVariantPrice(state.productPricing, {
        price: exact.price,
        discountType: exact.discountType,
        discountPercentage: exact.discountPercentage,
        discountAmount: exact.discountAmount,
      } satisfies VariantPricing)
    : presentation.pricing;
  // Filled buyer inputs add their surcharges to the base (sale price) and the
  // struck-through price alike; the product's discount applies to the base only.
  const surcharge = state.buyerInputs?.surchargeMinor() ?? 0;
  const places = moneyPlaces(state.productPricing.currencyDecimalPlaces, getCurrencyCode());
  const pricing = surcharge > 0
    ? {
        ...basePricing,
        finalPrice: unitPriceWithSurcharge(basePricing.finalPrice, surcharge, places),
        originalPrice: unitPriceWithSurcharge(basePricing.originalPrice, surcharge, places),
      }
    : basePricing;
  cache.priceElements.forEach((element) => {
    const price = formatPrice(pricing.finalPrice);
    element.textContent = starting
      ? checkoutText(element.dataset.fromTemplate || "{price}", { price })
      : price;
  });
  cache.originalPriceElements.forEach((element) => {
    element.textContent = formatPrice(pricing.originalPrice);
    element.classList.toggle("hidden", !pricing.hasDiscount);
  });
  const badge = pricing.hasDiscount
    ? formatDiscountBadge(pricing.originalPrice, pricing.finalPrice)
    : null;
  if (cache.discountBadge) {
    cache.discountBadge.textContent = badge ?? "";
    cache.discountBadge.classList.toggle("hidden", !badge);
  }
}

function updateVariantImage() {
  if (!state.hasRequestedVariant && !state.hasVariantSelectionInteraction)
    return;
  const productMediaId = resolveVariantImageForSelection(
    state.variants,
    state.selection,
  );
  window.dispatchEvent(
    new CustomEvent("product-media-select", {
      detail: {
        productMediaId,
        source: "variant",
      },
    }),
  );
}

let warranty: { box: HTMLElement; byVariant: Record<string, string | null> } | null = null;

/**
 * Reads the warranty rows' SKU map once per page (`warranty`). Without one
 * (every SKU shares one warranty: WarrantyRow.astro) or with a broken one,
 * the rows stay as drawn.
 */
function readWarranty() {
  const box = buyFormQuery(cache.scopes, "[data-sx-warranty-rows]");
  const map = box?.dataset.sxWarrantyByVariant;
  if (!box || !map) return null;
  try {
    return { box, byVariant: JSON.parse(map) as Record<string, string | null> };
  } catch {
    return null;
  }
}

/**
 * The buy box's warranty row (WarrantyRow.astro): the chosen SKU's warranty,
 * or, with no SKU chosen, the one every SKU of the choice so far shares.
 * SKUs of one product may each have their own, or none.
 */
function updateWarrantyRows() {
  if (!warranty) return;
  const { byVariant } = warranty;
  const ids = new Set(shownVariants().candidates.map((variant) => byVariant[variant.id] ?? null));
  const shown = ids.size === 1 ? [...ids][0] ?? null : null;
  for (const row of warranty.box.querySelectorAll<HTMLElement>("[data-sx-warranty-row]")) {
    row.hidden = shown === null || row.dataset.sxWarrantyId !== shown;
  }
}

function selectedCartOptions(variant: Variant): CartItemOption[] {
  return variant.selectedOptions.map((option) => ({
    name: option.name,
    label: option.value,
  }));
}

/** The option whose "Choose a …" message shows. */
let missingOption: string | null = null;

/**
 * "Choose a Size" under the option the buyer has not picked yet; in the
 * form's status instead when the form leaves its options out (a skin
 * chooses the SKU). An empty message takes it away (a choice: its frame
 * publishes that).
 */
function showMissingOption(definitionId: string, message: string, focus = false) {
  const group = buyFormQuery(cache.scopes,
    `[data-sx-buy="option-group"][data-option-definition-id="${CSS.escape(definitionId)}"]`,
  );
  const note = group?.querySelector<HTMLElement>(".option-missing-message");
  if (!message) {
    if (note) {
      note.textContent = "";
      note.classList.add("hidden");
    }
    if (missingOption === definitionId) {
      missingOption = null;
      if (state.error === "option_required") withdrawError();
    }
    return;
  }
  missingOption = definitionId;
  if (!note) return showError(message, "option_required", focus);
  note.textContent = message;
  note.classList.remove("hidden");
  group!.scrollIntoView({ behavior: "smooth", block: "center" });
  group!.querySelector<HTMLElement>(".variant-option-btn, select[data-sx-buy=\"option-select\"]")?.focus({ preventScroll: true });
  setError("option_required");
}

/**
 * Adds the chosen SKU (Buy now: then checks out), once at a time. `source`
 * is a skin's buyVariant button: it shows the busy state, and a problem
 * moves focus to the form's message, since the buyer pressed elsewhere.
 */
async function add(redirect: boolean, source: HTMLElement | null = null) {
  if (state.adding || state.purchaseBlocked) return;
  state.adding = true;
  // A new try: the last one's message goes.
  withdrawError();
  updateActionsState();
  publish();
  // Busy while the line is added, so a slow phone shows the press took.
  busyButton = source ?? (redirect ? cache.buyButton : cache.addButton);
  busyButton?.setAttribute("aria-busy", "true");
  busyButton?.classList.add("opacity-70", "cursor-progress");
  let posted = false;
  try {
    // The SKU as it was pressed: a choice made while the add waits (for the
    // buyer inputs' script) never changes what it buys.
    posted = (await addSelected(redirect, source !== null, state.selection)) === true;
  } finally {
    // A native post is on its way: the form stays busy and takes no other press.
    if (!posted) endAdd();
    updateActionsState();
    publish();
  }
}

/** The button an add marks busy, until the add ends. */
let busyButton: HTMLElement | null = null;

function endAdd() {
  state.adding = false;
  busyButton?.removeAttribute("aria-busy");
  busyButton?.classList.remove("opacity-70", "cursor-progress");
  busyButton = null;
}

/**
 * A page restored from the back/forward cache is the page as it was left,
 * but the cart may have moved on: a native post's busy state ends (the buyer
 * came back to buy again), and the cart line being edited is read again, as
 * an update the buyer finished (in the cart, Back) leaves none to update.
 * A restore only ever drops this page's edit: an edit begun on another page
 * (Edit in the cart opens a fresh page) is that page's, and this one never
 * filled its answers.
 */
function restoreFromHistory(event: PageTransitionEvent) {
  if (!event.persisted) return;
  endAdd();
  if (state.edit && readCartLineEdit(state.edit.productId)?.lineKey !== state.edit.lineKey) state.edit = null;
  refresh();
}

/** Adds the SKU `selection` names; true when the form was posted the no-JavaScript way instead. */
async function addSelected(redirect: boolean, focusProblem: boolean, selection: VariantSelection): Promise<boolean | void> {
  if (!cache.container || !state.productPricing) return;
  const fail = (message: string, error: StorefrontProductError) => showError(message, error, focusProblem);
  const validation = validateSelection(
    selection,
    state.options,
    state.variants,
  );
  if (validation.missingOption) {
    return showMissingOption(
      validation.missingOption.id,
      checkoutText(cache.actions?.dataset.chooseOptionText || "{option}", {
        option: validation.missingOption.name,
      }),
      focusProblem,
    );
  }
  // The page's words, never the check's: the sold-out word, or the one for a choice no SKU has.
  if (!validation.valid || !validation.variant)
    return fail((validation.reason === "sold_out" ? cache.actions?.dataset.unavailableText : cache.actions?.dataset.combinationUnavailableText) ?? "", "unavailable");
  // A product's buyer inputs work first. When their script failed to load
  // (some browsers then refuse it for the life of the page), the form goes
  // the no-JavaScript way once the browser's own checks pass (a required
  // answer: its message, nothing posted): it posts every answer, this SKU
  // and the quantity, and the store checks and prices them. A cart line
  // being edited cannot be replaced that way, so its update is refused
  // instead (the answers stay in the form).
  if (buyerInputsReady && !(await buyerInputsReady)) {
    if (state.edit || !cache.form) return fail(cache.actions?.dataset.cartAddFailedText ?? "", "failed");
    // Bangla digits become the quantity's own first, so the browser's
    // (English) pattern message never shows for them.
    readQuantity();
    if (!cache.form.reportValidity()) return setError("input_invalid");
    const field = cache.form.querySelector<HTMLInputElement>('input[type="hidden"][name="variant"]');
    if (field) field.value = validation.variant.id;
    // Not requestSubmit: that comes back to this script's own submit handler.
    HTMLFormElement.prototype.submit.call(cache.form);
    return true;
  }
  // Each problem shows (and takes focus) under its field.
  const inputs = state.buyerInputs?.validate() ?? null;
  if (inputs && !inputs.ok) return setError("input_invalid");
  const properties = inputs?.ok ? inputs.properties : [];
  const quantity = readQuantity();
  const pricing = calculateVariantPrice(state.productPricing, {
    price: validation.variant.price,
    discountType: validation.variant.discountType,
    discountPercentage: validation.variant.discountPercentage,
    discountAmount: validation.variant.discountAmount,
  });
  const cartMedia = resolveVariantCartMedia(validation.variant, {
    imageUrl: cache.container.dataset.productImage,
    imageMediaId: cache.container.dataset.productImageMediaId,
  });
  const cartData = validateAddToCart({
    productId: cache.container.dataset.productId,
    slug: cache.container.dataset.productSlug,
    name: cache.container.dataset.productName,
    // One unit as the buyer sees it: base plus the surcharges of the inputs.
    price: unitPriceWithSurcharge(
      pricing.finalPrice,
      inputs?.ok ? inputs.propertiesPriceMinor : 0,
      moneyPlaces(state.productPricing.currencyDecimalPlaces, getCurrencyCode()),
    ),
    quantity,
    stock: validation.variant.stock,
    reservedStock: validation.variant.reservedStock,
    trackInventory: validation.variant.trackInventory,
    availabilityBand: validation.variant.availabilityBand,
    variantId: validation.variant.id,
    ...cartMedia,
    freeDelivery: cache.container.dataset.productFreeDelivery === "true",
  });
  let failureMessage = cache.actions?.dataset.cartAddFailedText ?? "";
  // The line's own checks are a developer's words; the buyer reads the page's.
  if (!cartData.valid || !cartData.data) {
    return validation.variant.availabilityBand === "out_of_stock"
      ? fail(cache.actions?.dataset.unavailableText ?? failureMessage, "unavailable")
      : fail(failureMessage, "failed");
  }
  // The apps' options (a subscription, a protection plan) and line inputs are
  // priced by the apps: the line takes the store's price for them.
  const purchaseOptions = selectedPurchaseOptions();
  // More apps' ways to buy than one line holds: say so at the options, never add it one-time.
  if (!purchaseOptions) return fail(cache.actions?.dataset.purchaseOptionsLimitText || failureMessage, "input_invalid");
  let price = cartData.data.price;
  let chosenOptions = purchaseOptions;
  if (purchaseOptions.length > 0 || properties.some(({ key }) => isAppScopedKey(key))) {
    // Only app-priced lines need this check; ordinary products do not load it.
    const lineValidation = await import("@/lib/cart/new-line").catch(() => null);
    if (!lineValidation) return fail(failureMessage, "failed");
    const { acceptedNewCartLine, validateCartLinesInBrowser, validateNewCartLine } = lineValidation;
    const checked = acceptedNewCartLine(await validateNewCartLine(validateCartLinesInBrowser, {
      cartKey: "new",
      productId: cartData.data.id,
      variantId: validation.variant.id,
      quantity,
      productName: cartData.data.name,
      variantLabel: selectedCartOptions(validation.variant).map((option) => option.label).join(" / ") || null,
      ...(properties.length > 0 ? { properties: properties.map(({ key, value }) => ({ key, value })) } : {}),
      ...(purchaseOptions.length > 0 ? { purchaseOptions: purchaseOptions.map(({ id }) => id) } : {}),
    }));
    if (!checked.item) return fail(checked.message || failureMessage, "failed");
    price = checked.item.unitPrice;
    // The store's titles for the options it accepted (the same ids).
    const answered = normalizeCartLinePurchaseOptions(checked.item.purchaseOptions) ?? [];
    if (answered.length > 0) chosenOptions = answered;
  }
  const line = {
    ...cartData.data,
    price,
    variantId: validation.variant.id,
    options: selectedCartOptions(validation.variant),
    ...(properties.length > 0 ? { properties } : {}),
    ...(chosenOptions.length > 0 ? { purchaseOptions: chosenOptions } : {}),
    ...(validation.variant.fulfillmentKind ? { fulfillmentKind: validation.variant.fulfillmentKind } : {}),
  };
  const edit = state.edit;
  let failure: StorefrontProductError = "failed";
  // Buy now keeps the full cart and requires persistence before navigation.
  const options = {
    onFailure(reason: CartAddFailureReason) {
      if (reason === "quantity_limit") {
        failure = "quantity_limit";
        failureMessage = checkoutText(cache.actions?.dataset.quantityLimitText ?? "", {
          count: QUANTITY_CONSTRAINTS.MAX,
        });
      }
    },
  };
  const added = edit
    ? await replaceCartLine(edit.lineKey, line)
    : redirect
      ? await startBuyNow(line, options)
      : await addToCart(line, options);
  if (!added) return fail(failureMessage, failure);
  if (edit) {
    clearCartLineEdit();
    window.location.href = pagePath("/cart");
    return;
  }
  if (redirect) window.location.href = pagePath("/cart");
  else {
    // The drawer confirms this line ("Added to your cart") and lists it first.
    const addedLineKey = await cartLineKeyFor(line).catch(() => undefined);
    document.dispatchEvent(new CustomEvent("open-cart", { detail: { addedLineKey } }));
  }
}

/**
 * A problem with the purchase stays next to the buttons, in the form's
 * status, until the next try or until the buyer changes what they would
 * buy (`dropRefusal`). `focus` moves focus to it (the buyer pressed a skin's
 * button elsewhere on the page).
 */
function showError(message: string, error: StorefrontProductError, focus = false) {
  errorMessage?.remove();
  const element = (errorMessage = document.createElement("p"));
  element.dataset.productActionError = "";
  element.className = "rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive";
  element.textContent = message;
  element.setAttribute("role", "alert");
  element.tabIndex = -1;
  // The message shows where the buyer is looking: in the form's status, or,
  // when a skin placed the form's buttons apart (and not the status), right
  // above those buttons. `role="alert"` announces it either way.
  const apart = (part: HTMLElement | null) => Boolean(part && cache.summary && !cache.summary.contains(part));
  if (apart(cache.actionsPart) && !apart(cache.statusPart)) {
    cache.actionsPart!.before(element);
  } else if (cache.statusPart) {
    cache.statusPart.append(element);
    cache.statusPart.dataset.state = "error";
  } else cache.actions?.insertBefore(element, cache.actions.firstChild);
  setError(error);
  if (focus) element.focus();
}

/** The form says no problem any more; the caller publishes. */
function withdrawError() {
  errorMessage?.remove();
  errorMessage = null;
  if (cache.statusPart) cache.statusPart.dataset.state = "idle";
  state.error = null;
}
