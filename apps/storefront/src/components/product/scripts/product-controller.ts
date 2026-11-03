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
import { formatCheckoutLanguageText } from "@scalius/shared/checkout-language-format";
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
import {
  trackProductAddToCart,
  extractProductDataFromDOM,
  convertVariantToAnalyticsData,
} from "../lib/product-analytics";
import type { ProductOptionDefinition } from "@/lib/api";
import { resolveVariantCartMedia } from "../lib/cart-media";
import {
  getProductActionsPresentation,
  type ProductActionPresentation,
} from "../lib/product-actions";
import { moneyPlaces, unitPriceWithSurcharge } from "../lib/line-price";
import { BUYER_INPUT_FIELD_PREFIX } from "../lib/buy-form";
import type { BuyerInputsController } from "./buyer-inputs-controller";
import { pagePath } from "@/lib/presence-url";
import type { CartLinePurchaseOption } from "@/lib/cart/purchase-option";
import { DEFERRED_REVEAL_EVENT } from "@/scripts/browser-events";
import type { StorefrontProductError } from "@scalius/shared/plugins/storefront-protocol";

// The buy form's one authority: its option buttons, a product_main skin's
// bound SKU controls (`chooseVariant`, `buyVariant`) and app islands
// (`context.product`) all go through this controller's selection and add.
// Every part of the form is looked up inside its container, which carries
// a host-only marker (`data-sx-product-summary`; the sanitizer strips every
// `data-sx-*` from app markup), so a skin's own `.product-price`,
// `[data-action]` or look-alike container is never taken over. The product's
// facts come from the page's `#product-container`, which wraps the skin.

/** A skin's buy button the host bound (lib/extensions/purchase-controls.ts); only the host writes `data-sx-*`. */
const SKIN_BUY_CONTROL = "[data-sx-bound][data-buy-variant]";

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
  /** The buy form's container: every part below is looked up inside it. */
  summary: null as HTMLElement | null,
  /** The buy form (with or without buyer inputs). */
  form: null as HTMLFormElement | null,
  actions: null as HTMLElement | null,
  quantity: null as HTMLInputElement | null,
  optionButtons: [] as HTMLButtonElement[],
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
  return cache.summary?.querySelector<T>(`[data-sx-buy="${role}"]`) ?? null;
}

function parts<T extends Element = HTMLElement>(role: string): T[] {
  return Array.from(cache.summary?.querySelectorAll<T>(`[data-sx-buy="${role}"]`) ?? []);
}

/** The purchase's problem as the form shows it (showError). */
let errorMessage: HTMLElement | null = null;

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
  cache.form = summary.querySelector<HTMLFormElement>("form[data-sx-buy-form]");
  cache.actions = part("actions");
  cache.quantity = part<HTMLInputElement>("quantity");
  cache.optionButtons = parts<HTMLButtonElement>("option");
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

  state.purchaseBlocked = Boolean(part("blocked"));
  state.adding = false;
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
  if (buyerForm && state.edit) prefillEdit(buyerForm, state.edit);
  // The inputs' own script loads only for a product that has them.
  buyerInputsReady = buyerForm ? loadBuyerInputs(buyerForm) : null;

  initQuantity();
  bindOptions();
  bindActions();
  loadExtras();
  for (const input of purchaseOptionInputs()) input.addEventListener("change", changed);
  refresh(true);
  // The pre-paint hold of a `?variant=` link (VARIANT_PREPAINT_SCRIPT) ends in
  // the frame that paints the linked SKU.
  requestAnimationFrame(() => {
    delete document.documentElement.dataset.variantPending;
  });
}

/**
 * Settles once the product's buyer inputs work; null for a product without
 * them. It rejects when their script fails to load: an add then refuses
 * (`failed`) and the buyer's answers stay in the form; left unhandled, the
 * rejection reaches the page's stale-asset recovery, which reloads.
 */
let buyerInputsReady: Promise<void> | null = null;

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

/** The edited line's quantity, answers and purchase option, in what the buyer has not changed yet. */
function prefillEdit(form: HTMLFormElement, edit: CartLineEdit) {
  if (cache.quantity?.value === "1") cache.quantity.value = String(edit.quantity);
  for (const { key, value } of edit.properties) {
    const field = form.elements.namedItem(`${BUYER_INPUT_FIELD_PREFIX}${key}`);
    if (field instanceof HTMLInputElement && field.type === "checkbox") field.checked ||= value === "true";
    else if ((field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement) && !field.value) field.value = value;
  }
  if (!selectedPurchaseOption()) selectPurchaseOption(edit.purchaseOption ?? "");
}

/** The buy form's purchase-option radios (an app's ways to buy, beside a one-time purchase). */
function purchaseOptionInputs(): HTMLInputElement[] {
  return parts<HTMLInputElement>("purchase-option");
}

function selectPurchaseOption(id: string) {
  const inputs = purchaseOptionInputs();
  const match = inputs.find((input) => input.value === id) ?? inputs.find((input) => input.value === "");
  if (match) match.checked = true;
}

/** The chosen app option; null for a one-time purchase (or a page without options). */
function selectedPurchaseOption(): CartLinePurchaseOption | null {
  const input = purchaseOptionInputs().find((entry) => entry.checked && entry.value);
  return input ? { id: input.value, title: input.dataset.purchaseOptionTitle || input.value } : null;
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

function readQuantity(): number {
  const input = cache.quantity;
  const message = part("quantity-message");
  if (!input) return 1;
  const typed = typedQuantity(input.value);
  const quantity = clampQuantity(Number.isFinite(typed) ? typed : 1);
  input.value = String(quantity);
  const capped = Number.isFinite(typed) && typed > QUANTITY_CONSTRAINTS.MAX;
  if (message) {
    message.textContent = capped
      ? formatCheckoutLanguageText(cache.actions?.dataset.quantityLimitText ?? "", { count: QUANTITY_CONSTRAINTS.MAX })
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
    cache.announcer.textContent = formatCheckoutLanguageText(
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
  cache.actions?.addEventListener("click", (event) => {
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
    // A skin's buy button reaches the form only when its script failed to
    // load: it posts its own SKU, as without JavaScript.
    if (submitter?.matches(SKIN_BUY_CONTROL)) return;
    event.preventDefault();
    void add(Boolean(submitter?.matches('[data-sx-buy="buy"]')));
  });
}

/** The skin's SKU controls, once their script has loaded (skin-controls.ts). */
let skinControls: { sync(): void } | null = null;
/** Publishes the form's state to app islands, once its script has loaded (island-state.ts). */
let publishState: (() => void) | null = null;
let extrasBinding: AbortController | null = null;

/**
 * What only some product pages use loads only there: a product_main skin's
 * SKU controls (`chooseVariant`, `buyVariant`; placed now or in deferred
 * markup) and the state for app islands (`context.product`; islands live in
 * app components). A page without either pays nothing for them.
 */
function loadExtras() {
  extrasBinding?.abort();
  skinControls = null;
  publishState = null;
  const { signal } = (extrasBinding = new AbortController());
  const bound = "[data-sx-bound]";
  if (document.querySelector(bound) || Array.from(document.querySelectorAll<HTMLTemplateElement>("scalius-deferred>template")).some((template) => template.content.querySelector(bound))) {
    // A press on a control before its script is in waits for it (the last
    // one): a choice or buy then runs as if pressed after.
    let pending: HTMLElement | null = null;
    const hold = (event: MouseEvent) => {
      const control = event.target instanceof Element
        ? event.target.closest<HTMLElement>(`${bound}[data-choose-variant],${bound}[data-buy-variant]`)
        : null;
      // A new tab or window follows a link itself.
      if (!control || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      pending = control;
    };
    document.addEventListener("click", hold, { capture: true, signal });
    void import("./skin-controls").then(({ bindSkinControls }) => {
      document.removeEventListener("click", hold, { capture: true });
      if (signal.aborted) return;
      skinControls = bindSkinControls({ state, choose: chooseVariant, add, selected: exactVariant, stock: getBuyerStockSummary }, signal);
      // Controls in deferred markup take the form's state when they enter the page.
      document.addEventListener(DEFERRED_REVEAL_EVENT, skinControls.sync, { signal });
      skinControls.sync();
      pending?.click();
    }, (error: unknown) => {
      // Their script is gone (a deploy): a held press goes the native way (a
      // link opens, a buy button posts its own SKU), the one navigation;
      // with none held, the page's stale-asset recovery hears the failure.
      document.removeEventListener("click", hold, { capture: true });
      if (pending) pending.click();
      else throw error;
    });
  }
  if (cache.summary && document.querySelector("[data-sx-app]")) {
    const summary = cache.summary;
    void import("./island-state").then(({ islandState }) => {
      if (signal.aborted) return;
      publishState = islandState({ state, summary, selected: exactVariant, quantity: currentQuantity, option: selectedPurchaseOption, stock: getBuyerStockSummary });
      // The first state goes out in a frame too, never ahead of what the page shows.
      requestAnimationFrame(publish);
    });
  }
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

export function revealSelectedOptions(root: ParentNode = cache.summary ?? document) {
  root.querySelectorAll<HTMLElement>('[data-sx-buy="option-values"][data-option-overflow]').forEach((list) => {
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
          selected,
        ) + (optionPrice ? ` ${optionPrice}.` : ""),
      );
    }
  }
}

function optionButtonLabel(
  name: string,
  value: string,
  status: VariantOptionAvailability,
  selected: boolean,
) {
  void selected;
  // The page's words (ProductSummary.astro), so a Bangla page reads Bangla.
  const words = cache.actions?.dataset;
  const template = status === "sold_out"
    ? words?.optionSoldOutText || "{option}: {value}. Sold out."
    : status === "incompatible"
      ? words?.optionUnavailableText || "{option}: {value}. Not available with the current selection."
      : words?.optionValueText || "{option}: {value}";
  return formatCheckoutLanguageText(template, { option: name, value });
}

function exactVariant() {
  return (
    resolveExactVariantSelection(state.variants, state.selection)?.variant ??
    null
  );
}

function updateStockAndActions() {
  const exact = state.unavailableRequestedVariant ?? exactVariant();
  const candidates = exact
    ? [exact]
    : Object.keys(state.selection).length
      ? filterVariantsBySelection(state.variants, state.selection)
      : state.variants;
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
  skinControls?.sync();
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
  const exact = state.unavailableRequestedVariant ?? exactVariant();
  const candidates = exact
    ? [exact]
    : Object.keys(state.selection).length
      ? filterVariantsBySelection(state.variants, state.selection)
      : state.variants;
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
      ? formatCheckoutLanguageText(element.dataset.fromTemplate || "{price}", { price })
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

/**
 * The buy box's warranty row (WarrantyRow.astro): the chosen SKU's warranty,
 * or, with no SKU chosen, the one every SKU of the choice so far shares.
 * SKUs of one product may each have their own, or none.
 */
function updateWarrantyRows() {
  const box = cache.summary?.querySelector<HTMLElement>("[data-sx-warranty-rows]");
  if (!box) return;
  let byVariant: Record<string, string | null>;
  try {
    byVariant = JSON.parse(box.dataset.sxWarrantyByVariant ?? "{}") as Record<string, string | null>;
  } catch {
    return;
  }
  const exact = state.unavailableRequestedVariant ?? exactVariant();
  const candidates = exact ? [exact] : filterVariantsBySelection(state.variants, state.selection);
  const ids = new Set(candidates.map((variant) => byVariant[variant.id] ?? null));
  const shown = ids.size === 1 ? [...ids][0] ?? null : null;
  for (const row of box.querySelectorAll<HTMLElement>("[data-sx-warranty-row]")) {
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
  const group = cache.summary?.querySelector<HTMLElement>(
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
  group!.querySelector<HTMLButtonElement>(".variant-option-btn")?.focus({ preventScroll: true });
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
  const button = source ?? (redirect ? cache.buyButton : cache.addButton);
  button?.setAttribute("aria-busy", "true");
  button?.classList.add("opacity-70", "cursor-progress");
  try {
    await addSelected(redirect, source !== null);
  } finally {
    state.adding = false;
    button?.removeAttribute("aria-busy");
    button?.classList.remove("opacity-70", "cursor-progress");
    updateActionsState();
    publish();
  }
}

async function addSelected(redirect: boolean, focusProblem: boolean) {
  if (!cache.container || !state.productPricing) return;
  const fail = (message: string, error: StorefrontProductError) => showError(message, error, focusProblem);
  // A product's buyer inputs work first. When their script failed to load
  // (some browsers then refuse it for the life of the page), the form goes
  // the no-JavaScript way: it posts every answer, the chosen SKU and the
  // quantity, and the store checks and prices them. A cart line being
  // edited cannot be replaced that way, so its update is refused instead
  // (the answers stay in the form).
  if (buyerInputsReady && !(await buyerInputsReady.then(() => true, () => false))) {
    if (state.edit || !cache.form) return fail(cache.actions?.dataset.cartAddFailedText ?? "", "failed");
    const field = cache.form.querySelector<HTMLInputElement>('input[type="hidden"][name="variant"]');
    const chosen = exactVariant();
    if (field && chosen) field.value = chosen.id;
    // Not requestSubmit: that comes back to this script's own submit handler.
    return HTMLFormElement.prototype.submit.call(cache.form);
  }
  const validation = validateSelection(
    state.selection,
    state.options,
    state.variants,
  );
  if (validation.missingOption) {
    return showMissingOption(
      validation.missingOption.id,
      formatCheckoutLanguageText(cache.actions?.dataset.chooseOptionText || "{option}", {
        option: validation.missingOption.name,
      }),
      focusProblem,
    );
  }
  // The page's words, never the check's: the sold-out word, or the one for a choice no SKU has.
  if (!validation.valid || !validation.variant)
    return fail((validation.reason === "sold_out" ? cache.actions?.dataset.unavailableText : cache.actions?.dataset.combinationUnavailableText) ?? "", "unavailable");
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
  // An app's option (a subscription) is priced by the app: the line takes the store's price for it.
  const purchaseOption = selectedPurchaseOption();
  let price = cartData.data.price;
  let chosenOption = purchaseOption;
  if (purchaseOption) {
    // Only app-priced lines need this check; ordinary products do not load it.
    const lineValidation = await import("@/lib/cart/new-line").catch(() => null);
    if (!lineValidation) return fail(failureMessage, "failed");
    const { acceptedNewCartLine, validateCartLinesInBrowser, validateNewCartLine } = lineValidation;
    const checked = acceptedNewCartLine(await validateNewCartLine(validateCartLinesInBrowser, {
      cartKey: "new",
      productId: cartData.data.id,
      variantId: validation.variant.id,
      quantity,
      price,
      productName: cartData.data.name,
      variantLabel: selectedCartOptions(validation.variant).map((option) => option.label).join(" / ") || null,
      ...(properties.length > 0 ? { properties: properties.map(({ key, value }) => ({ key, value })) } : {}),
      purchaseOption: purchaseOption.id,
    }));
    if (!checked.item) return fail(checked.message || failureMessage, "failed");
    price = checked.item.unitPrice;
    chosenOption = checked.item.purchaseOption ?? purchaseOption;
  }
  const line = {
    ...cartData.data,
    price,
    variantId: validation.variant.id,
    options: selectedCartOptions(validation.variant),
    ...(properties.length > 0 ? { properties } : {}),
    ...(chosenOption ? { purchaseOption: chosenOption } : {}),
    ...(validation.variant.fulfillmentKind ? { fulfillmentKind: validation.variant.fulfillmentKind } : {}),
  };
  const edit = state.edit;
  let failure: StorefrontProductError = "failed";
  // Buy now keeps the full cart and requires persistence before navigation.
  const options = {
    onFailure(reason: CartAddFailureReason) {
      if (reason === "quantity_limit") {
        failure = "quantity_limit";
        failureMessage = formatCheckoutLanguageText(cache.actions?.dataset.quantityLimitText ?? "", {
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
  // Analytics get the product, SKU, quantity and price, never the buyer inputs.
  const product = extractProductDataFromDOM(cache.container);
  if (product)
    trackProductAddToCart({
      product,
      variant: convertVariantToAnalyticsData(validation.variant),
      quantity,
    });
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
  if (cache.statusPart) {
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
