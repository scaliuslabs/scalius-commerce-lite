// src/components/product/scripts/product-controller.ts

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
  createVariantIndex,
  createInitialState,
  createSelectionState,
  applyAction,
  filterVariantsBySelection,
  validateSelection,
  loadVariantsFromDOM,
  resolveExactAvailableVariantSelection,
  resolveExactVariantSelection,
  shouldShowStartingVariantPrice,
  type VariantOptionAvailability,
  type VariantSelectionState,
  type Variant,
  type VariantIndex,
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
import { resolveVariantImageId } from "@/lib/variant-image-mapping";
const state = {
  variants: [] as Variant[],
  variantIndex: null as VariantIndex | null,
  selection: null as VariantSelectionState | null,
  productPricing: null as ProductPricing | null,
  isVariantImagesEnabled: false,
  variantImageAxis: "option2" as "option1" | "option2",
  currentDisplayedImage: "",
  unavailableRequestedVariant: null as Variant | null,
};

const cache = {
  container: null as HTMLElement | null,
  mobileMainImage: null as HTMLImageElement | null,
  quantityInput: null as HTMLInputElement | null,
  actionsContainer: null as HTMLElement | null,
  sizeButtons: [] as HTMLButtonElement[],
  colorButtons: [] as HTMLButtonElement[],
  variantAvailabilityStatus: null as HTMLElement | null,
  unavailableQueryNotice: null as HTMLElement | null,
  stockBadge: null as HTMLElement | null,
  stockText: null as HTMLElement | null,
  addToCartButton: null as HTMLButtonElement | null,
  buyNowButton: null as HTMLButtonElement | null,
  addToCartLabel: null as HTMLElement | null,
  buyNowLabel: null as HTMLElement | null,
  thumbnails: [] as HTMLElement[],
  priceElements: [] as HTMLElement[],
  originalPriceElements: [] as HTMLElement[],
  discountBadge: null as HTMLElement | null,
};

type ProductImageChangeDetail = {
  url?: string;
};

function parseDiscountType(value?: string): DiscountType {
  return value === "percentage" || value === "flat" ? value : null;
}

function parseDecimal(value: string | undefined): number {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function init() {
  cache.container = document.getElementById("product-container");
  if (!cache.container) return;

  cache.mobileMainImage = document.getElementById(
    "mobile-main-image",
  ) as HTMLImageElement;
  cache.quantityInput = document.getElementById("quantity") as HTMLInputElement;
  cache.actionsContainer = document.getElementById("product-actions");

  cache.sizeButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>(".size-btn"),
  );
  cache.colorButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>(".color-btn"),
  );
  cache.variantAvailabilityStatus = document.getElementById(
    "variant-availability-status",
  );
  cache.unavailableQueryNotice = document.getElementById(
    "variant-unavailable-query-notice",
  );
  cache.stockBadge = document.getElementById("product-stock-badge");
  cache.stockText = document.getElementById("product-stock-text");
  cache.addToCartButton = document.querySelector<HTMLButtonElement>(
    '[data-action="add-to-cart"]',
  );
  cache.buyNowButton = document.querySelector<HTMLButtonElement>(
    '[data-action="buy-now"]',
  );
  cache.addToCartLabel = document.querySelector(
    '[data-action-label="add-to-cart"]',
  );
  cache.buyNowLabel = document.querySelector('[data-action-label="buy-now"]');
  cache.thumbnails = Array.from(document.querySelectorAll(".thumbnail-btn"));
  cache.priceElements = Array.from(document.querySelectorAll(".product-price"));
  cache.originalPriceElements = Array.from(
    document.querySelectorAll(".product-original-price"),
  );
  cache.discountBadge = document.querySelector(".discount-badge");

  initImageStateSync();
  initQuantityControls();
  initVariantSystem();
  initActionButtons();
}

// Keep controller state in sync with gallery/zoom changes
function initImageStateSync() {
  window.addEventListener("product-image-change", ((
    e: CustomEvent<ProductImageChangeDetail>,
  ) => {
    const url = e.detail?.url;
    if (typeof url === "string" && url) {
      state.currentDisplayedImage = url;
    }
  }) as EventListener);
}
function switchImage(url: string) {
  if (state.currentDisplayedImage === url) return;
  state.currentDisplayedImage = url;

  window.dispatchEvent(
    new CustomEvent("product-image-change", {
      detail: { url: url },
    }),
  );

  if (cache.mobileMainImage) {
    requestAnimationFrame(() => {
      if (cache.mobileMainImage) {
        cache.mobileMainImage.removeAttribute("srcset");
        cache.mobileMainImage.removeAttribute("sizes");
        cache.mobileMainImage.src = url;
      }
    });
  }

  window.dispatchEvent(
    new CustomEvent("controller-image-update", {
      detail: { url: url },
    }),
  );
}
function initQuantityControls() {
  const minus = document.getElementById("quantity-minus");
  const plus = document.getElementById("quantity-plus");
  const input = cache.quantityInput;

  if (!minus || !plus || !input) return;

  const update = (delta: number) => {
    const current = parseInt(input.value) || 1;
    input.value = clampQuantity(current + delta).toString();
  };

  minus.onclick = () => update(-1);
  plus.onclick = () => update(1);
  input.onchange = () => {
    input.value = validateQuantity(input.value).value.toString();
  };
}
function initVariantSystem() {
  state.variants = loadVariantsFromDOM();
  state.variantIndex = createVariantIndex(state.variants);
  state.isVariantImagesEnabled = !!document.querySelector(
    'meta[name="variant-images-enabled"]',
  );
  state.variantImageAxis =
    document
      .querySelector('meta[name="variant-images-axis"]')
      ?.getAttribute("content") === "option1"
      ? "option1"
      : "option2";
  state.currentDisplayedImage = cache.container?.dataset.productImage || "";

  state.productPricing = {
    basePrice: parseDecimal(cache.container?.dataset.productOriginalPrice),
    discountType: parseDiscountType(
      cache.container?.dataset.productDiscountType,
    ),
    discountPercentage:
      parseDecimal(cache.container?.dataset.productDiscountPercentage) || null,
    discountAmount:
      parseDecimal(cache.container?.dataset.productDiscountAmount) || null,
    currencyDecimalPlaces: (() => {
      const value = Number.parseInt(
        cache.container?.dataset.currencyDecimalPlaces || "2",
        10,
      );
      return Number.isInteger(value) && value >= 0 && value <= 6 ? value : 2;
    })(),
  };

  if (!state.variantIndex) return;
  const initialSelection = createInitialState(state.variantIndex);

  const params = new URLSearchParams(window.location.search);
  const urlSize = params.get("size");
  const urlColor = params.get("color");
  const requestedQuerySelection = resolveExactVariantSelection(state.variants, {
    selectedSize: urlSize,
    selectedColor: urlColor,
  });
  const querySelection = resolveExactAvailableVariantSelection(state.variants, {
    selectedSize: urlSize,
    selectedColor: urlColor,
  });
  state.unavailableRequestedVariant =
    requestedQuerySelection && !querySelection
      ? requestedQuerySelection.variant
      : null;

  state.selection = state.unavailableRequestedVariant
    ? createSelectionState(state.variantIndex, {})
    : querySelection
      ? createSelectionState(state.variantIndex, querySelection)
      : initialSelection;

  if ((urlSize || urlColor) && !querySelection) {
    replaceVariantUrl(false);
  }

  bindVariantOptionButtons("size", cache.sizeButtons);
  bindVariantOptionButtons("color", cache.colorButtons);

  refreshUI();
}

function handleVariantSelection(
  type: "size" | "color",
  value: string,
  updateHistory = true,
  mode: "select" | "toggle" = "toggle",
) {
  if (!state.selection || !state.variantIndex) return;

  state.unavailableRequestedVariant = null;
  const previousSelection = state.selection;
  const availability =
    type === "size"
      ? previousSelection.sizeOptionAvailability.get(value)
      : previousSelection.colorOptionAvailability.get(value);
  const actionType =
    type === "size"
      ? mode === "toggle"
        ? "TOGGLE_SIZE"
        : "SELECT_SIZE"
      : mode === "toggle"
        ? "TOGGLE_COLOR"
        : "SELECT_COLOR";
  state.selection = applyAction(
    state.selection,
    { type: actionType, value },
    state.variantIndex,
  );

  announceVariantSelectionChange(
    type,
    value,
    previousSelection,
    state.selection,
    availability,
  );

  refreshUI();

  if (updateHistory) replaceVariantUrl(true);
}

function replaceVariantUrl(includeSelection: boolean): void {
  if (typeof history === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.delete("size");
  url.searchParams.delete("color");
  if (includeSelection && state.selection?.selectedSize) {
    url.searchParams.set("size", state.selection.selectedSize);
  }
  if (includeSelection && state.selection?.selectedColor) {
    url.searchParams.set("color", state.selection.selectedColor);
  }
  history.replaceState(null, "", url.toString());
}

function bindVariantOptionButtons(
  axis: "size" | "color",
  buttons: HTMLButtonElement[],
): void {
  buttons.forEach((button, index) => {
    const value = axis === "size" ? button.dataset.size : button.dataset.color;
    if (!value) return;

    button.addEventListener("click", () => {
      handleVariantSelection(axis, value);
    });
    button.addEventListener("keydown", (event) => {
      if (event.repeat) return;

      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        handleVariantSelection(axis, value);
        return;
      }

      const direction =
        event.key === "ArrowRight" || event.key === "ArrowDown"
          ? 1
          : event.key === "ArrowLeft" || event.key === "ArrowUp"
            ? -1
            : 0;
      if (!direction || buttons.length < 2) return;

      event.preventDefault();
      for (let offset = 1; offset < buttons.length; offset += 1) {
        const candidate =
          buttons[
            (index + direction * offset + buttons.length) % buttons.length
          ];
        if (!candidate || candidate.disabled) continue;
        const candidateValue =
          axis === "size" ? candidate.dataset.size : candidate.dataset.color;
        if (!candidateValue) continue;
        candidate.focus();
        handleVariantSelection(axis, candidateValue, true, "select");
        return;
      }
    });
  });
}

function announceVariantSelectionChange(
  axis: "size" | "color",
  value: string,
  previous: VariantSelectionState,
  next: VariantSelectionState,
  availability: VariantOptionAvailability | undefined,
): void {
  const status = cache.variantAvailabilityStatus;
  if (!status) return;

  const axisLabel = optionName(axis === "size" ? "option1" : "option2");
  const opposingLabel = optionName(axis === "size" ? "option2" : "option1");
  const wasSelected =
    axis === "size"
      ? previous.selectedSize === value
      : previous.selectedColor === value;
  const isSelected =
    axis === "size"
      ? next.selectedSize === value
      : next.selectedColor === value;
  const opposingWasCleared =
    axis === "size"
      ? Boolean(previous.selectedColor && !next.selectedColor)
      : Boolean(previous.selectedSize && !next.selectedSize);

  if (wasSelected && !isSelected) {
    status.textContent = `${axisLabel} ${value} cleared.`;
    return;
  }
  if (availability === "incompatible" && opposingWasCleared) {
    status.textContent = `${axisLabel} ${value} selected. ${opposingLabel} selection cleared because that combination is unavailable.`;
    return;
  }
  status.textContent = `${axisLabel} ${value} selected.`;
}

function refreshUI() {
  requestAnimationFrame(() => {
    updateVariantButtons();
    updateStockAndActions();
    updatePriceDisplay();

    if (state.isVariantImagesEnabled) {
      updateVariantImage();
    }
  });
}

function updateStockAndActions(): void {
  const exactVariant =
    state.unavailableRequestedVariant ??
    state.selection?.selectedVariant ??
    null;
  const hasPartialSelection = Boolean(
    state.selection?.selectedSize || state.selection?.selectedColor,
  );
  const stockVariants = exactVariant
    ? [exactVariant]
    : hasPartialSelection && state.selection
      ? filterVariantsBySelection(state.variants, state.selection)
      : state.variants;
  const stockSummary = getBuyerStockSummary(stockVariants);
  const unavailable = !stockSummary.canPurchaseAny;
  const exactAddToCartAvailable = Boolean(
    !state.unavailableRequestedVariant &&
      state.selection?.selectedVariant &&
      getBuyerStockSummary([state.selection.selectedVariant]).canPurchaseAny,
  );

  cache.unavailableQueryNotice?.classList.toggle(
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
      stockSummary.tone === "available" ? "text-primary" : "text-destructive",
      stockSummary.tone === "available" ? "bg-primary/10" : "bg-destructive/10",
    );
    cache.stockBadge.dataset.stockTone = stockSummary.tone;
  }
  if (cache.stockText) cache.stockText.textContent = stockSummary.text;

  updatePurchaseButton(
    cache.addToCartButton,
    cache.addToCartLabel,
    !exactAddToCartAvailable,
    "Add to Cart",
    exactAddToCartAvailable ? addToCartAccessibleName() : "Add to cart",
  );
  updatePurchaseButton(
    cache.buyNowButton,
    cache.buyNowLabel,
    unavailable,
    "Buy Now",
    "Buy now",
  );
}

function addToCartAccessibleName(): string {
  const productName = cache.container?.dataset.productName?.trim() || "product";
  return `Add ${productName} to cart`;
}

function updatePurchaseButton(
  button: HTMLButtonElement | null,
  label: HTMLElement | null,
  unavailable: boolean,
  availableText: string,
  availableAriaLabel: string,
): void {
  if (!button) return;
  button.disabled = unavailable;
  button.setAttribute(
    "aria-label",
    unavailable ? "Product unavailable" : availableAriaLabel,
  );
  if (label) label.textContent = unavailable ? "Unavailable" : availableText;
}

function updateVariantButtons() {
  if (!state.selection) return;

  updateOptionButtonGroup(
    "size",
    cache.sizeButtons,
    state.selection.selectedSize,
    state.selection.sizeOptionAvailability,
  );
  updateOptionButtonGroup(
    "color",
    cache.colorButtons,
    state.selection.selectedColor,
    state.selection.colorOptionAvailability,
  );
}

const OPTION_STATE_CLASSES = [
  "bg-black",
  "text-white",
  "border-black",
  "bg-muted/50",
  "bg-muted",
  "text-muted-foreground",
  "border-dashed",
  "border-muted-foreground/40",
  "border-muted-foreground",
  "opacity-50",
  "line-through",
  "cursor-not-allowed",
  "pointer-events-none",
  "bg-white",
  "text-gray-900",
] as const;

function updateOptionButtonGroup(
  axis: "size" | "color",
  buttons: HTMLButtonElement[],
  selectedValue: string | undefined,
  availabilityByValue: Map<string, VariantOptionAvailability>,
): void {
  const axisLabel = optionName(axis === "size" ? "option1" : "option2");
  const opposingLabel = optionName(axis === "size" ? "option2" : "option1");
  const opposingValue =
    axis === "size"
      ? state.selection?.selectedColor
      : state.selection?.selectedSize;

  for (const button of buttons) {
    const value = axis === "size" ? button.dataset.size : button.dataset.color;
    if (!value) continue;

    const isSelected = selectedValue === value;
    const availability = availabilityByValue.get(value) ?? "sold_out";
    const isSoldOut = availability === "sold_out";
    const isIncompatible = availability === "incompatible";

    button.disabled = isSoldOut;
    button.setAttribute("aria-pressed", String(isSelected));
    button.dataset.optionAvailability = availability;
    button.classList.remove(...OPTION_STATE_CLASSES);
    button.classList.add("bg-background", "text-foreground", "border-input");

    let accessibleStatus = "";
    if (isSoldOut) {
      button.classList.add("opacity-50", "line-through", "cursor-not-allowed");
      accessibleStatus = ". Out of stock.";
    } else if (isSelected) {
      button.classList.remove(
        "bg-background",
        "text-foreground",
        "border-input",
      );
      button.classList.add("bg-black", "text-white", "border-black");
      accessibleStatus = ". Selected; activate again to clear.";
    } else if (isIncompatible) {
      button.classList.remove(
        "bg-background",
        "text-foreground",
        "border-input",
      );
      button.classList.add(
        "bg-muted",
        "text-foreground",
        "border-dashed",
        "border-muted-foreground",
      );
      accessibleStatus = opposingValue
        ? `. Not available with ${opposingLabel} ${opposingValue}; selecting it clears ${opposingLabel}.`
        : ". Not available with the current selection.";
    }

    button.setAttribute(
      "aria-label",
      `${axisLabel}: ${value}${accessibleStatus}`,
    );
    if (accessibleStatus) {
      button.title = accessibleStatus.trim();
    } else {
      button.removeAttribute("title");
    }
  }
}

function updateVariantImage() {
  const selectedOptionValue =
    state.variantImageAxis === "option1"
      ? state.selection?.selectedSize
      : state.selection?.selectedColor;
  const thumbnailByImageId = new Map<string, HTMLElement>();
  cache.thumbnails.forEach((thumbnail) => {
    const imageId = thumbnail.dataset.imageId;
    if (imageId && !thumbnailByImageId.has(imageId)) {
      thumbnailByImageId.set(imageId, thumbnail);
    }
  });
  const mappings = Array.from(thumbnailByImageId.entries()).flatMap(
    ([imageId, thumbnail]) => {
      const variantId = thumbnail.dataset.variantId || null;
      const optionAxis: "option1" | "option2" | null = thumbnail.dataset.optionAxis === "option1"
        || thumbnail.dataset.optionAxis === "option2"
        ? thumbnail.dataset.optionAxis
        : null;
      const optionValue = thumbnail.dataset.optionValue || null;
      if (!variantId && (!optionAxis || !optionValue)) return [];
      return [{
        id: `dom:${imageId}`,
        productId: cache.container?.dataset.productId || "",
        imageId,
        variantId,
        optionAxis,
        optionValue,
        normalizedOptionValue: optionValue?.trim().toLocaleLowerCase("en-US") ?? null,
        sortOrder: Number.parseInt(thumbnail.dataset.index || "0", 10) || 0,
      }];
    },
  );
  const imageId = resolveVariantImageId({
    enabled: state.isVariantImagesEnabled,
    axis: state.variantImageAxis,
    mappings,
    images: Array.from(thumbnailByImageId.entries()).map(([id, thumbnail], index) => ({
      id,
      isPrimary: thumbnail.dataset.imagePrimary === "true",
      sortOrder: Number.parseInt(thumbnail.dataset.index || String(index), 10) || index,
    })),
    selectedVariantId: state.selection?.selectedVariant?.id,
    selectedOptionValue,
  });
  const url = imageId
    ? thumbnailByImageId.get(imageId)?.dataset.imageUrl
    : undefined;
  if (url) switchImage(url);
}

function updatePriceDisplay() {
  if (!state.productPricing || !state.selection || !state.variantIndex) return;

  const hasCustomerOptions =
    state.variantIndex.options.hasSize || state.variantIndex.options.hasColor;
  const exactDisplayVariant =
    state.unavailableRequestedVariant ?? state.selection.selectedVariant;
  const showsStartingPrice =
    state.variants.length > 0 &&
    shouldShowStartingVariantPrice(hasCustomerOptions, exactDisplayVariant);

  if (showsStartingPrice) {
    const matchingVariants = filterVariantsBySelection(state.variants, {
      selectedSize: state.selection.selectedSize,
      selectedColor: state.selection.selectedColor,
    });
    const startingPrice = getBuyerVariantPricePresentation(
      state.productPricing,
      matchingVariants,
    ).pricing.finalPrice;
    const formattedStartingPrice = `From ${formatPrice(startingPrice)}`;

    cache.priceElements.forEach((el) => {
      if (el.textContent !== formattedStartingPrice) {
        el.textContent = formattedStartingPrice;
      }
    });
    cache.originalPriceElements.forEach((el) => el.classList.add("hidden"));
    cache.discountBadge?.classList.add("hidden");
    return;
  }

  let variantPricing: VariantPricing | null = null;
  if (exactDisplayVariant) {
    const v = exactDisplayVariant;
    variantPricing = {
      price: v.price,
      discountType: v.discountType,
      discountPercentage: v.discountPercentage,
      discountAmount: v.discountAmount,
    };
  }

  const res = calculateVariantPrice(state.productPricing, variantPricing);
  const formattedFinal = formatPrice(res.finalPrice);
  const formattedOriginal = formatPrice(res.originalPrice);

  cache.priceElements.forEach((el) => {
    if (el.textContent !== formattedFinal) el.textContent = formattedFinal;
  });

  cache.originalPriceElements.forEach((el) => {
    if (el.textContent !== formattedOriginal)
      el.textContent = formattedOriginal;
    if (res.hasDiscount) {
      el.classList.remove("hidden");
    } else {
      el.classList.add("hidden");
    }
  });

  if (cache.discountBadge) {
    const text = formatDiscountBadge(
      res.discountType,
      res.discountPercentage,
      res.discountAmount,
    );
    if (text) {
      if (cache.discountBadge.textContent !== text)
        cache.discountBadge.textContent = text;
      cache.discountBadge.classList.remove("hidden");
    } else {
      cache.discountBadge.classList.add("hidden");
    }
  }
}

function optionName(axis: "option1" | "option2"): string {
  const fallback = axis === "option1" ? "Option 1" : "Option 2";
  return (
    cache.actionsContainer?.dataset[
      axis === "option1" ? "option1Label" : "option2Label"
    ]?.trim() || fallback
  );
}

function selectedOption(
  name: string,
  label?: string | null,
): CartItemOption | null {
  const optionLabel = label?.trim();
  if (!optionLabel) return null;
  return { name, label: optionLabel };
}

function buildSelectedCartOptions(variant?: Variant): CartItemOption[] {
  if (!state.selection) return [];

  return [
    selectedOption(
      optionName("option1"),
      variant?.size ?? state.selection.selectedSize,
    ),
    selectedOption(
      optionName("option2"),
      variant?.color ?? state.selection.selectedColor,
    ),
  ].filter((option): option is CartItemOption => Boolean(option));
}

function initActionButtons() {
  const container = cache.actionsContainer;
  if (!container) return;

  container.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const addToCartBtn = target.closest('[data-action="add-to-cart"]');
    const buyNowBtn = target.closest('[data-action="buy-now"]');

    if (addToCartBtn) handleAddToCart(false);
    if (buyNowBtn) handleAddToCart(true);
  });
}

function handleAddToCart(redirect: boolean) {
  const container = cache.container;
  if (
    !container ||
    !state.selection ||
    !state.productPricing ||
    !state.variantIndex
  )
    return;

  if (state.unavailableRequestedVariant) {
    showToast(
      "The requested option is out of stock. Choose another option.",
      "error",
    );
    return;
  }

  if (state.variants.length === 0) {
    showToast("This product is not available for checkout right now.", "error");
    return;
  }

  const validation = validateSelection(state.selection, state.variantIndex);
  if (!validation.valid) {
    showToast(validation.error || "Please select options", "error");
    return;
  }
  if (!validation.variant?.id || validation.variant.id === "default") {
    showToast("This product option is no longer available.", "error");
    return;
  }

  const qtyInput = cache.quantityInput;
  const quantity = parseInt(qtyInput?.value || "1");

  let variantPricing: VariantPricing | null = null;
  if (validation.variant) {
    variantPricing = {
      price: validation.variant.price,
      discountType: validation.variant.discountType,
      discountPercentage: validation.variant.discountPercentage,
      discountAmount: validation.variant.discountAmount,
    };
  }
  const priceRes = calculateVariantPrice(state.productPricing, variantPricing);

  const cartData = validateAddToCart({
    productId: container.dataset.productId,
    slug: container.dataset.productSlug,
    name: container.dataset.productName,
    price: priceRes.finalPrice,
    quantity,
    stock: validation.variant?.stock,
    reservedStock: validation.variant?.reservedStock,
    trackInventory: validation.variant?.trackInventory,
    variantId: validation.variant?.id,
    size: state.selection.selectedSize,
    color: state.selection.selectedColor,
    image: state.currentDisplayedImage || container.dataset.productImage,
    freeDelivery: container.dataset.productFreeDelivery === "true",
  });

  if (!cartData.valid) {
    showToast(cartData.errors[0], "error");
    return;
  }

  try {
    if (!cartData.data) {
      showToast("Unable to add this product to cart", "error");
      return;
    }

    const options = buildSelectedCartOptions();
    const added = addToCart({
      ...cartData.data,
      variantId: validation.variant.id,
      ...(options.length > 0 ? { options } : {}),
    });
    if (!added) {
      showToast(
        "This product option could not be added. Please refresh and try again.",
        "error",
      );
      return;
    }

    const pData = extractProductDataFromDOM(container);
    if (pData) {
      trackProductAddToCart({
        product: pData,
        variant: convertVariantToAnalyticsData(validation.variant),
        quantity,
      });
    }

    showToast("Added to cart", "success");

    if (redirect) {
      window.location.href = "/cart";
    } else {
      if (window.innerWidth < 768) window.scrollTo(0, 0);
      document.dispatchEvent(new CustomEvent("open-cart"));
    }
  } catch (e: unknown) {
    console.error(e);
    showToast("Error adding to cart", "error");
  }
}

function showToast(msg: string, type: "success" | "error") {
  const config = TOAST_CONFIG.variants[type];
  const container = cache.actionsContainer;
  if (!container) {
    alert(msg);
    return;
  }

  const toast = document.createElement("div");
  toast.className = `${TOAST_CONFIG.container} ${config.bg} ${config.border} ${config.text} text-sm font-medium`;
  toast.innerHTML = `<span>${config.icon}</span><span class="ml-2">${msg}</span>`;

  container.insertBefore(toast, container.firstChild);
  setTimeout(() => toast.remove(), 3000);
}

// Export init for deferred dynamic import from [slug].astro
export { init };
