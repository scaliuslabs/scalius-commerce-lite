import { addToCart, type CartItemOption } from "@/store/cart";
import {
  calculateVariantPrice,
  formatPrice,
  formatDiscountBadge,
  getBuyerVariantPricePresentation,
  type ProductPricing,
  type VariantPricing,
  type DiscountType,
} from "../lib/pricing-engine";
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
  validateQuantity,
  validateAddToCart,
  clampQuantity,
} from "../lib/product-validation";
import { getBuyerStockSummary } from "@/lib/product-sellable-variants";
import {
  trackProductAddToCart,
  extractProductDataFromDOM,
  convertVariantToAnalyticsData,
} from "../lib/product-analytics";
import { TOAST_CONFIG } from "../config";
import type { ProductOptionDefinition } from "@/lib/api";
import { resolveVariantCartMedia } from "../lib/cart-media";
import {
  getProductActionsPresentation,
  type ProductActionPresentation,
} from "../lib/product-actions";

const state = {
  variants: [] as Variant[],
  options: [] as ProductOptionDefinition[],
  selection: {} as VariantSelection,
  productPricing: null as ProductPricing | null,
  unavailableRequestedVariant: null as Variant | null,
  hasRequestedVariant: false,
  hasVariantSelectionInteraction: false,
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
  state.selection = state.unavailableRequestedVariant
    ? {}
    : (requested?.selection ??
      createInitialSelection(state.options, state.variants));

  initQuantity();
  bindOptions();
  bindActions();
  refresh();
}

function initQuantity() {
  const minus = document.getElementById("quantity-minus");
  const plus = document.getElementById("quantity-plus");
  if (!minus || !plus || !cache.quantity) return;
  const update = (delta: number) => {
    cache.quantity!.value = clampQuantity(
      (Number.parseInt(cache.quantity!.value, 10) || 1) + delta,
    ).toString();
  };
  minus.addEventListener("click", () => update(-1));
  plus.addEventListener("click", () => update(1));
  cache.quantity.addEventListener("change", () => {
    cache.quantity!.value = validateQuantity(
      cache.quantity!.value,
    ).value.toString();
  });
}

function bindOptions() {
  const order = state.options.map((option) => option.id);
  cache.optionButtons.forEach((button, _index, buttons) => {
    const definitionId = button.dataset.optionDefinitionId;
    const valueId = button.dataset.optionValueId;
    if (!definitionId || !valueId) return;
    const choose = () => {
      state.hasVariantSelectionInteraction = true;
      state.unavailableRequestedVariant = null;
      if (state.selection[definitionId] === valueId)
        delete state.selection[definitionId];
      else
        state.selection = reconcileSelectionForValue(
          state.variants,
          definitionId,
          valueId,
          state.selection,
          order,
        );
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
    if (target.closest('[data-action="add-to-cart"]')) add(false);
    if (target.closest('[data-action="buy-now"]')) add(true);
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
    updateOptionButtons();
    updateStockAndActions();
    updatePrice();
    updateVariantImage();
  });
}

const OPTION_CLASSES = [
  "bg-black",
  "text-white",
  "border-black",
  "bg-muted",
  "border-dashed",
  "border-muted-foreground",
  "opacity-50",
  "line-through",
  "cursor-not-allowed",
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
        button.classList.add("bg-black", "text-white", "border-black");
      } else if (status === "incompatible") {
        button.classList.remove("bg-background", "border-input");
        button.classList.add(
          "bg-muted",
          "border-dashed",
          "border-muted-foreground",
        );
      } else if (status === "sold_out") {
        button.classList.add(
          "opacity-50",
          "line-through",
          "cursor-not-allowed",
        );
      }
      button.disabled = status === "sold_out";
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
  if (status === "sold_out") return `${name}: ${value}. Out of stock.`;
  if (status === "incompatible")
    return `${name}: ${value}. Not available with the current selection.`;
  if (selected) return `${name}: ${value}. Selected; activate again to clear.`;
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
  const exactAvailable = Boolean(
    !state.unavailableRequestedVariant &&
    exact &&
    getBuyerStockSummary([exact]).canPurchaseAny,
  );
  const actions = getProductActionsPresentation({
    productName: cache.container?.dataset.productName ?? "Product",
    exactVariantAvailable: exactAvailable,
    anyVariantAvailable: summary.canPurchaseAny,
  });
  cache.unavailableNotice?.classList.toggle(
    "hidden",
    !state.unavailableRequestedVariant,
  );
  if (cache.stockBadge) {
    cache.stockBadge.classList.remove(
      "text-primary",
      "bg-primary/10",
      "text-destructive",
      "bg-destructive/10",
    );
    cache.stockBadge.classList.add(
      summary.tone === "available" ? "text-primary" : "text-destructive",
      summary.tone === "available" ? "bg-primary/10" : "bg-destructive/10",
    );
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
  const starting = shouldShowStartingVariantPrice(
    state.options.length > 0,
    exact,
  );
  if (starting) {
    const candidates = Object.keys(state.selection).length
      ? filterVariantsBySelection(state.variants, state.selection)
      : state.variants;
    const price = getBuyerVariantPricePresentation(
      state.productPricing,
      candidates,
    ).pricing.finalPrice;
    cache.priceElements.forEach(
      (element) =>
        (element.textContent = `From ${formatPrice(price, undefined, state.productPricing!.currencyDecimalPlaces)}`),
    );
    cache.originalPriceElements.forEach((element) =>
      element.classList.add("hidden"),
    );
    cache.discountBadge?.classList.add("hidden");
    return;
  }
  const variantPricing: VariantPricing | null = exact
    ? {
        price: exact.price,
        discountType: exact.discountType,
        discountPercentage: exact.discountPercentage,
        discountAmount: exact.discountAmount,
      }
    : null;
  const pricing = calculateVariantPrice(state.productPricing, variantPricing);
  cache.priceElements.forEach(
    (element) =>
      (element.textContent = formatPrice(
        pricing.finalPrice,
        undefined,
        state.productPricing!.currencyDecimalPlaces,
      )),
  );
  cache.originalPriceElements.forEach((element) => {
    element.textContent = formatPrice(
      pricing.originalPrice,
      undefined,
      state.productPricing!.currencyDecimalPlaces,
    );
    element.classList.toggle("hidden", !pricing.hasDiscount);
  });
  const badge = formatDiscountBadge(
    pricing.discountType,
    pricing.discountPercentage,
    pricing.discountAmount,
  );
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

function add(redirect: boolean) {
  if (!cache.container || !state.productPricing) return;
  if (state.unavailableRequestedVariant)
    return showToast(
      "The requested option is out of stock. Choose another option.",
      "error",
    );
  const validation = validateSelection(
    state.selection,
    state.options,
    state.variants,
  );
  if (!validation.valid || !validation.variant)
    return showToast(validation.error || "Please select options", "error");
  const quantity = Number.parseInt(cache.quantity?.value || "1", 10);
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
    price: pricing.finalPrice,
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
    return showToast(
      cartData.errors[0] || "Unable to add this product",
      "error",
    );
  const added = addToCart({
    ...cartData.data,
    variantId: validation.variant.id,
    options: selectedCartOptions(validation.variant),
  });
  if (!added)
    return showToast(
      "This product option could not be added. Please refresh and try again.",
      "error",
    );
  const product = extractProductDataFromDOM(cache.container);
  if (product)
    trackProductAddToCart({
      product,
      variant: convertVariantToAnalyticsData(validation.variant),
      quantity,
    });
  showToast("Added to cart", "success");
  if (redirect) window.location.href = "/cart";
  else {
    if (window.innerWidth < 768) window.scrollTo(0, 0);
    document.dispatchEvent(new CustomEvent("open-cart"));
  }
}

function showToast(message: string, type: "success" | "error") {
  const config = TOAST_CONFIG.variants[type];
  if (!cache.actions) return alert(message);
  const element = document.createElement("div");
  element.className = `${TOAST_CONFIG.container} ${config.bg} ${config.border} ${config.text} text-sm font-medium`;
  element.textContent = message;
  cache.actions.insertBefore(element, cache.actions.firstChild);
  setTimeout(() => element.remove(), 3000);
}
