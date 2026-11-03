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
import { moneyPlaces, unitPriceWithSurcharge } from "../lib/buyer-inputs";
import { initBuyerInputs, type BuyerInputsController } from "./buyer-inputs-controller";
import { pagePath } from "@/lib/presence-url";
import type { CartLinePurchaseOption } from "@/lib/cart/purchase-option";
import { publishProductState } from "@/scripts/product-context";
import type { StorefrontProductError, StorefrontProductState } from "@scalius/shared/plugins/storefront-protocol";

// The buy form's one authority: its option buttons, a product_main skin's
// bound SKU controls (`chooseVariant`, `buyVariant`) and app islands
// (`context.product`) all go through this controller's selection and add.
// Every lookup of the form's parts stays inside `[data-product-summary]`, so
// a skin's own `.product-price` or `[data-action]` is never taken over.

/** A skin's SKU controls the host bound (lib/extensions/purchase-controls.ts); only the host writes `data-sx-*`. */
const CHOOSE_CONTROL = "[data-sx-bound][data-choose-variant]";
const BUY_CONTROL = "[data-sx-bound][data-buy-variant]";

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

function parseDiscountType(value?: string): DiscountType {
  return value === "percentage" || value === "flat" ? value : null;
}

function number(value?: string) {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

export function init() {
  cache.container = document.getElementById("product-container");
  const summary = document.querySelector<HTMLElement>("[data-product-summary]");
  if (!cache.container || !summary) return;
  cache.summary = summary;
  cache.form = summary.querySelector<HTMLFormElement>("form[data-product-buy-form]");
  cache.actions = summary.querySelector<HTMLElement>("#product-actions");
  cache.quantity = summary.querySelector<HTMLInputElement>("#quantity");
  cache.optionButtons = Array.from(
    summary.querySelectorAll<HTMLButtonElement>(".variant-option-btn"),
  );
  cache.announcer = summary.querySelector("#variant-availability-status");
  cache.statusPart = summary.querySelector('[data-buy-part="status"]');
  cache.actionsPart = summary.querySelector('[data-buy-part="actions"]');
  cache.unavailableNotice = summary.querySelector(
    "#variant-unavailable-query-notice",
  );
  cache.stockBadge = summary.querySelector("#product-stock-badge");
  cache.stockText = summary.querySelector("#product-stock-text");
  cache.addButton = summary.querySelector('[data-action="add-to-cart"]');
  cache.buyButton = summary.querySelector('[data-action="buy-now"]');
  cache.addLabel = summary.querySelector('[data-action-label="add-to-cart"]');
  cache.buyLabel = summary.querySelector('[data-action-label="buy-now"]');
  cache.priceElements = Array.from(summary.querySelectorAll(".product-price"));
  cache.originalPriceElements = Array.from(
    summary.querySelectorAll(".product-original-price"),
  );
  cache.discountBadge = summary.querySelector(".discount-badge");

  state.variants = loadVariantsFromDOM();
  state.options = loadOptionsFromDOM();
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

  state.purchaseBlocked = Boolean(summary.querySelector("[data-purchase-blocked]"));
  state.adding = false;
  state.error = null;
  missingOption = null;
  state.buyerInputs = initBuyerInputs(summary, () => {
    // Editing an answer takes its message away; the problem ends with the last one.
    const shown = state.buyerInputs?.form.querySelector("[data-buyer-input-error]:not(.hidden)");
    if (state.error === "input_invalid" && !shown) state.error = null;
    refresh();
  });
  state.edit = null;
  const productId = cache.container.dataset.productId;
  if (state.buyerInputs && productId) {
    state.edit = readCartLineEdit(productId);
    if (state.edit) {
      if (cache.quantity) cache.quantity.value = String(state.edit.quantity);
      state.buyerInputs.prefill(state.edit.properties);
      selectPurchaseOption(state.edit.purchaseOption ?? "");
    }
  }

  initQuantity();
  bindOptions();
  bindActions();
  bindSkinControls();
  for (const input of purchaseOptionInputs()) input.addEventListener("change", publish);
  refresh(true);
  // The pre-paint hold of a `?variant=` link (VARIANT_PREPAINT_SCRIPT) ends in
  // the frame that paints the linked SKU.
  requestAnimationFrame(() => {
    delete document.documentElement.dataset.variantPending;
  });
}

/** The buy form's purchase-option radios (an app's ways to buy, beside a one-time purchase). */
function purchaseOptionInputs(): HTMLInputElement[] {
  return Array.from(cache.summary?.querySelectorAll<HTMLInputElement>('[data-product-purchase-options] input[name="purchaseOption"]') ?? []);
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
  cache.summary?.querySelectorAll<HTMLElement>("[data-offer-ends]").forEach((offer) => {
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
  const message = cache.summary?.querySelector<HTMLElement>("#quantity-message");
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
    publish();
  };
  cache.summary?.querySelector("#quantity-minus")?.addEventListener("click", () => update(-1));
  cache.summary?.querySelector("#quantity-plus")?.addEventListener("click", () => update(1));
  input.addEventListener("change", () => {
    readQuantity();
    publish();
  });
  // Typing: the field is read as the buyer types, corrected when they leave it.
  input.addEventListener("input", publish);
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
    if (target.closest('[data-action="add-to-cart"]')) {
      event.preventDefault();
      void add(false);
    }
    if (target.closest('[data-action="buy-now"]')) {
      event.preventDefault();
      void add(true);
    }
  });
  // Enter in a text field (a buyer input or quantity) submits through the
  // form's first button (a skin's buyVariant buttons come after the host's
  // default one); anything else still lands here, as the buyer's own choice.
  cache.form?.addEventListener("submit", (event) => {
    event.preventDefault();
    const submitter = (event as SubmitEvent).submitter;
    void add(Boolean(submitter?.closest('[data-action="buy-now"]')));
  });
}

let skinControls: AbortController | null = null;

/**
 * A product_main skin's SKU controls (`chooseVariant`, `buyVariant`): a
 * choice goes through the same selection as the option buttons, a buy
 * button chooses its SKU, then runs the form's own add or Buy now (its
 * checks, buyer inputs, purchase option and one-at-a-time guard), with any
 * problem shown in the form.
 */
function bindSkinControls() {
  skinControls?.abort();
  skinControls = new AbortController();
  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const choice = event.target.closest<HTMLElement>(CHOOSE_CONTROL);
    if (choice) {
      // A new tab or window follows the link itself.
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      chooseVariant(choice.dataset.chooseVariant ?? "");
      return;
    }
    const button = event.target.closest<HTMLButtonElement>(BUY_CONTROL);
    if (!button) return;
    event.preventDefault();
    if (button.disabled || state.adding || state.purchaseBlocked) return;
    if (!chooseVariant(button.dataset.buyVariant ?? "")) return;
    void add(button.dataset.buyIntent === "buy", button);
  }, { signal: skinControls.signal });
}

/** Keeps the skin's SKU controls in step with the form: the choice, stock, and an edit of a cart line. */
function updateSkinControls() {
  const exact = exactVariant();
  for (const control of document.querySelectorAll<HTMLElement>(CHOOSE_CONTROL)) {
    const selected = Boolean(exact) && control.dataset.chooseVariant === exact!.id;
    control.dataset.state = selected ? "selected" : "unselected";
    if (control instanceof HTMLButtonElement) control.setAttribute("aria-pressed", String(selected));
    else if (selected) control.setAttribute("aria-current", "true");
    else control.removeAttribute("aria-current");
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>(BUY_CONTROL)) {
    const variant = state.variants.find((candidate) => candidate.id === button.dataset.buyVariant);
    const soldOut = !variant || !getBuyerStockSummary([variant]).canPurchaseAny;
    // As the form's own buttons: off when it can't be bought, Buy now gone
    // then, and none while a cart line is edited (the form updates that line).
    button.disabled = soldOut || state.purchaseBlocked;
    button.hidden = Boolean(state.edit) || (button.dataset.buyIntent === "buy" && button.disabled);
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

/** What app islands read as `context.product` (scripts/product-context.ts). */
function productState(): StorefrontProductState {
  const exact = exactVariant();
  return {
    variantId: exact?.id ?? null,
    quantity: currentQuantity(),
    inputs: Object.fromEntries((state.buyerInputs?.values() ?? []).map(({ key, value }) => [key, value])),
    purchaseOption: selectedPurchaseOption()?.id ?? null,
    available: Boolean(exact) && !state.purchaseBlocked && getBuyerStockSummary([exact!]).canPurchaseAny,
    busy: state.adding,
    error: state.error,
  };
}

function publish() {
  publishProductState(productState());
}

/** The purchase's problem as islands read it (the form shows its words). */
function setError(error: StorefrontProductError | null) {
  state.error = error;
  publish();
}

export function revealSelectedOptions(root: ParentNode = cache.summary ?? document) {
  root.querySelectorAll<HTMLElement>(".variant-option-values[data-option-overflow]").forEach((list) => {
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
    const label = state.buyerInputs?.copy.updateCartItemText ?? "";
    if (cache.addLabel) cache.addLabel.textContent = label;
    cache.addButton?.setAttribute(
      "aria-label",
      `${label} — ${cache.container?.dataset.productName ?? "Product"}`,
    );
    if (cache.buyButton) cache.buyButton.hidden = true;
  }
  updateActionsState();
  updateSkinControls();
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
  const box = cache.summary?.querySelector<HTMLElement>("[data-warranty-rows]");
  if (!box) return;
  let byVariant: Record<string, string | null>;
  try {
    byVariant = JSON.parse(box.dataset.warrantyByVariant ?? "{}") as Record<string, string | null>;
  } catch {
    return;
  }
  const exact = state.unavailableRequestedVariant ?? exactVariant();
  const candidates = exact ? [exact] : filterVariantsBySelection(state.variants, state.selection);
  const ids = new Set(candidates.map((variant) => byVariant[variant.id] ?? null));
  const shown = ids.size === 1 ? [...ids][0] ?? null : null;
  for (const row of box.querySelectorAll<HTMLElement>("[data-warranty-row]")) {
    row.hidden = shown === null || row.dataset.warrantyId !== shown;
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
 * chooses the SKU). An empty message takes it away.
 */
function showMissingOption(definitionId: string, message: string, focus = false) {
  const group = cache.summary?.querySelector<HTMLElement>(
    `fieldset[data-option-definition-id="${CSS.escape(definitionId)}"]`,
  );
  const note = group?.querySelector<HTMLElement>(".option-missing-message");
  if (!message) {
    if (note) {
      note.textContent = "";
      note.classList.add("hidden");
    }
    if (missingOption === definitionId) {
      missingOption = null;
      if (state.error === "option_required") clearError();
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
  cache.summary?.querySelector("[data-product-action-error]")?.remove();
  state.error = null;
  if (cache.statusPart) cache.statusPart.dataset.state = "idle";
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
 * status, until the next try. `focus` moves focus to it (the buyer pressed
 * a skin's button elsewhere on the page).
 */
function showError(message: string, error: StorefrontProductError, focus = false) {
  cache.summary?.querySelector("[data-product-action-error]")?.remove();
  const element = document.createElement("p");
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

function clearError() {
  cache.summary?.querySelector("[data-product-action-error]")?.remove();
  if (cache.statusPart) cache.statusPart.dataset.state = "idle";
  setError(null);
}
