import { addToCart, replaceCartLine, startBuyNow, type CartItemOption } from "@/store/cart";
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
  /** The store product is not buyable: its buyer-input setup is broken. */
  customizationUnavailable: false,
  adding: false,
};

const cache = {
  container: null as HTMLElement | null,
  actions: null as HTMLElement | null,
  quantity: null as HTMLInputElement | null,
  optionButtons: [] as HTMLButtonElement[],
  status: null as HTMLElement | null,
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
  if (!cache.container) return;
  cache.actions = document.getElementById("product-actions");
  cache.quantity = document.getElementById(
    "quantity",
  ) as HTMLInputElement | null;
  cache.optionButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>(".variant-option-btn"),
  );
  cache.status = document.getElementById("variant-availability-status");
  cache.unavailableNotice = document.getElementById(
    "variant-unavailable-query-notice",
  );
  cache.stockBadge = document.getElementById("product-stock-badge");
  cache.stockText = document.getElementById("product-stock-text");
  cache.addButton = document.querySelector('[data-action="add-to-cart"]');
  cache.buyButton = document.querySelector('[data-action="buy-now"]');
  cache.addLabel = document.querySelector('[data-action-label="add-to-cart"]');
  cache.buyLabel = document.querySelector('[data-action-label="buy-now"]');
  cache.priceElements = Array.from(document.querySelectorAll(".product-price"));
  cache.originalPriceElements = Array.from(
    document.querySelectorAll(".product-original-price"),
  );
  cache.discountBadge = document.querySelector(".discount-badge");

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

  state.customizationUnavailable = Boolean(
    document.getElementById("product-customization-unavailable"),
  );
  state.buyerInputs = initBuyerInputs(document, refresh);
  state.edit = null;
  const productId = cache.container.dataset.productId;
  if (state.buyerInputs && productId) {
    state.edit = readCartLineEdit(productId);
    if (state.edit) {
      if (cache.quantity) cache.quantity.value = String(state.edit.quantity);
      state.buyerInputs.prefill(state.edit.properties);
    }
  }

  initQuantity();
  bindOptions();
  bindActions();
  refresh();
}

/** Offers end on their own schedule: hide one that ended while the page was cached. */
function hideExpiredOffers() {
  const now = Date.now() / 1000;
  document.querySelectorAll<HTMLElement>("[data-offer-ends]").forEach((offer) => {
    const endsAt = Number(offer.dataset.offerEnds);
    if (endsAt > 0 && endsAt <= now) offer.hidden = true;
  });
}

/**
 * The quantity accepts Bangla digits, never changes silently, and says so
 * when it is capped at the most one order line can hold.
 */
function readQuantity(): number {
  const input = cache.quantity;
  const message = document.getElementById("quantity-message");
  if (!input) return 1;
  const typed = Number.parseInt(toLatinDigits(input.value).replace(/\D/g, ""), 10);
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
  const minus = document.getElementById("quantity-minus");
  const plus = document.getElementById("quantity-plus");
  if (!minus || !plus || !cache.quantity) return;
  const update = (delta: number) => {
    cache.quantity!.value = String(readQuantity() + delta);
    readQuantity();
  };
  minus.addEventListener("click", () => update(-1));
  plus.addEventListener("click", () => update(1));
  cache.quantity.addEventListener("change", readQuantity);
}

function bindOptions() {
  const order = state.options.map((option) => option.id);
  cache.optionButtons.forEach((button, _index, buttons) => {
    const definitionId = button.dataset.optionDefinitionId;
    const valueId = button.dataset.optionValueId;
    if (!definitionId || !valueId) return;
    // Options behave like radio buttons: choosing the chosen value keeps it.
    const choose = () => {
      state.hasVariantSelectionInteraction = true;
      state.unavailableRequestedVariant = null;
      showMissingOption(definitionId, "");
      if (state.selection[definitionId] !== valueId) {
        state.selection = reconcileSelectionForValue(
          state.variants,
          definitionId,
          valueId,
          state.selection,
          order,
        );
      }
      if (cache.status)
        cache.status.textContent = `${button.dataset.optionValue || "Option"} selected.`;
      refresh();
      replaceVariantUrl();
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
  // first button; anything else still lands here.
  const buyForm =
    state.buyerInputs?.form ??
    document.querySelector<HTMLFormElement>("form[data-product-buy-form]");
  buyForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    const submitter = (event as SubmitEvent).submitter;
    void add(Boolean(submitter?.closest('[data-action="buy-now"]')));
  });
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

function refresh() {
  requestAnimationFrame(() => {
    state.buyerInputs?.setVariant(exactVariant()?.id ?? null);
    updateOptionButtons();
    updateStockAndActions();
    updatePrice();
    updateVariantImage();
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
    for (const button of cache.optionButtons.filter(
      (candidate) => candidate.dataset.optionDefinitionId === option.id,
    )) {
      const valueId = button.dataset.optionValueId!;
      const status = availability.get(valueId) ?? "sold_out";
      const selected = state.selection[option.id] === valueId;
      button.classList.remove(...OPTION_CLASSES);
      button.classList.add("bg-background", "text-foreground", "border-input");
      if (selected && status !== "sold_out") {
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
        button.classList.add("text-muted-foreground", "line-through", "cursor-not-allowed");
        if (selected) button.classList.add("ring-2", "ring-destructive");
      }
      // Sold-out values stay focusable and choosable, so a buyer sees why.
      if (status === "sold_out") button.setAttribute("aria-disabled", "true");
      else button.removeAttribute("aria-disabled");
      button.dataset.optionAvailability = status;
      button.setAttribute("aria-pressed", String(selected));
      button.setAttribute(
        "aria-label",
        optionButtonLabel(
          option.name,
          button.dataset.optionValue || "",
          status,
          selected,
        ),
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
  if (status === "sold_out") return `${name}: ${value}. Out of stock.`;
  if (status === "incompatible")
    return `${name}: ${value}. Not available with the current selection.`;
  return `${name}: ${value}`;
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
  cache.unavailableNotice?.classList.toggle(
    "hidden",
    !state.unavailableRequestedVariant,
  );
  if (cache.stockBadge) {
    cache.stockBadge.classList.toggle("text-primary", summary.tone === "available");
    cache.stockBadge.classList.toggle("text-destructive", summary.tone !== "available");
  }
  if (cache.stockText) cache.stockText.textContent = summary.text;
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
  if (state.customizationUnavailable) {
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

function selectedCartOptions(variant: Variant): CartItemOption[] {
  return variant.selectedOptions.map((option) => ({
    name: option.name,
    label: option.value,
  }));
}

/** "Choose a Size" under the option the buyer has not picked yet. */
function showMissingOption(definitionId: string, message: string) {
  const group = document.querySelector<HTMLElement>(
    `fieldset[data-option-definition-id="${CSS.escape(definitionId)}"]`,
  );
  const note = group?.querySelector<HTMLElement>(".option-missing-message");
  if (!note) return;
  note.textContent = message;
  note.classList.toggle("hidden", !message);
  if (message) {
    group!.scrollIntoView({ behavior: "smooth", block: "center" });
    group!.querySelector<HTMLButtonElement>(".variant-option-btn")?.focus({ preventScroll: true });
  }
}

async function add(redirect: boolean) {
  if (state.adding || state.customizationUnavailable) return;
  state.adding = true;
  try {
    await addSelected(redirect);
  } finally {
    state.adding = false;
  }
}

async function addSelected(redirect: boolean) {
  if (!cache.container || !state.productPricing) return;
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
    );
  }
  if (!validation.valid || !validation.variant)
    return showError(validation.error || "That option combination is unavailable.");
  const inputs = state.buyerInputs?.validate() ?? null;
  if (inputs && !inputs.ok) return;
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
  if (!cartData.valid || !cartData.data)
    return showError(cartData.errors[0] || "Unable to add this product");
  const line = {
    ...cartData.data,
    variantId: validation.variant.id,
    options: selectedCartOptions(validation.variant),
    ...(properties.length > 0 ? { properties } : {}),
    ...(validation.variant.fulfillmentKind ? { fulfillmentKind: validation.variant.fulfillmentKind } : {}),
  };
  const edit = state.edit;
  // Buy now buys only this item; the buyer's cart is set aside, untouched.
  const added = edit
    ? await replaceCartLine(edit.lineKey, line)
    : redirect
      ? await startBuyNow(line)
      : await addToCart(line);
  if (!added)
    return showError("This product option could not be added. Please refresh and try again.");
  if (edit) {
    clearCartLineEdit();
    window.location.href = "/cart";
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
  if (redirect) window.location.href = "/cart";
  else document.dispatchEvent(new CustomEvent("open-cart"));
}

/** A problem with the purchase stays next to the buttons until the next try. */
function showError(message: string) {
  const existing = cache.actions?.querySelector<HTMLElement>("[data-product-action-error]");
  existing?.remove();
  const element = document.createElement("p");
  element.dataset.productActionError = "";
  element.className = "rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive";
  element.textContent = message;
  element.setAttribute("role", "alert");
  cache.actions?.insertBefore(element, cache.actions.firstChild);
}
