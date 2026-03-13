// src/components/product/scripts/product-controller.ts

import { addToCart } from "@/store/cart";
import {
  calculateVariantPrice,
  formatPrice,
  formatDiscountBadge,
  type ProductPricing,
  type VariantPricing,
} from "../lib/pricing-engine";
import {
  createVariantIndex,
  createInitialState,
  applyAction,
  validateSelection,
  loadVariantsFromDOM,
  type VariantSelectionState,
  type Variant,
  type VariantIndex,
} from "../lib/variant-state-machine";
import {
  validateQuantity,
  validateAddToCart,
  clampQuantity,
} from "../lib/product-validation";
import {
  trackProductAddToCart,
  extractProductDataFromDOM,
  convertVariantToAnalyticsData,
} from "../lib/product-analytics";
import { TOAST_CONFIG } from "../config";
const state = {
  variants: [] as Variant[],
  variantIndex: null as VariantIndex | null,
  selection: null as VariantSelectionState | null,
  productPricing: null as ProductPricing | null,
  isVariantImagesEnabled: false,
  currentDisplayedImage: "",
};

const cache = {
  container: null as HTMLElement | null,
  mobileMainImage: null as HTMLImageElement | null,
  quantityInput: null as HTMLInputElement | null,
  actionsContainer: null as HTMLElement | null,
  sizeButtons: [] as HTMLElement[],
  colorButtons: [] as HTMLElement[],
  thumbnails: [] as HTMLElement[],
  priceElements: [] as HTMLElement[],
  originalPriceElements: [] as HTMLElement[],
  discountBadge: null as HTMLElement | null,
};

function init() {
  cache.container = document.getElementById("product-container");
  if (!cache.container) return;

  cache.mobileMainImage = document.getElementById(
    "mobile-main-image",
  ) as HTMLImageElement;
  cache.quantityInput = document.getElementById("quantity") as HTMLInputElement;
  cache.actionsContainer = document.getElementById("product-actions");

  cache.sizeButtons = Array.from(document.querySelectorAll(".size-btn"));
  cache.colorButtons = Array.from(document.querySelectorAll(".color-btn"));
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
  window.addEventListener(
    "product-image-change" as any,
    ((e: CustomEvent) => {
      const url = e?.detail?.url;
      if (typeof url === "string" && url) {
        state.currentDisplayedImage = url;
      }
    }) as EventListener,
  );
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
        cache.mobileMainImage.removeAttribute('srcset');
        cache.mobileMainImage.removeAttribute('sizes');
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
  state.currentDisplayedImage = cache.container?.dataset.productImage || "";

  state.productPricing = {
    basePrice: parseInt(cache.container?.dataset.productOriginalPrice || "0"),
    discountType: (cache.container?.dataset.productDiscountType as any) || null,
    discountPercentage:
      parseInt(cache.container?.dataset.productDiscountPercentage || "0") ||
      null,
    discountAmount:
      parseInt(cache.container?.dataset.productDiscountAmount || "0") || null,
  };

  if (!state.variantIndex) return;
  state.selection = createInitialState(state.variantIndex);

  const params = new URLSearchParams(window.location.search);
  const urlSize = params.get("size");
  const urlColor = params.get("color");

  if (urlSize) handleVariantSelection("size", urlSize, false);
  if (urlColor) handleVariantSelection("color", urlColor, false);

  cache.sizeButtons.forEach((btn) => {
    btn.addEventListener("click", () =>
      handleVariantSelection("size", btn.dataset.size!),
    );
  });
  cache.colorButtons.forEach((btn) => {
    btn.addEventListener("click", () =>
      handleVariantSelection("color", btn.dataset.color!),
    );
  });

  refreshUI();
}

function handleVariantSelection(
  type: string,
  value: string,
  updateHistory = true,
) {
  if (!state.selection || !state.variantIndex) return;

  const actionType = type === "size" ? "SELECT_SIZE" : "SELECT_COLOR";
  state.selection = applyAction(
    state.selection,
    { type: actionType, value },
    state.variantIndex,
  );

  refreshUI();

  if (updateHistory && typeof history !== "undefined") {
    const url = new URL(window.location.href);
    url.searchParams.delete("size");
    url.searchParams.delete("color");
    if (state.selection.selectedSize)
      url.searchParams.set("size", state.selection.selectedSize);
    if (state.selection.selectedColor)
      url.searchParams.set("color", state.selection.selectedColor);
    history.replaceState(null, "", url.toString());
  }
}

function refreshUI() {
  requestAnimationFrame(() => {
    updateVariantButtons();
    updatePriceDisplay();

    if (state.isVariantImagesEnabled && state.selection?.selectedColor) {
      updateVariantImage();
    }
  });
}

function updateVariantButtons() {
  if (!state.selection) return;

  const { selectedSize, selectedColor, availableSizes, availableColors } =
    state.selection;

  for (let i = 0; i < cache.sizeButtons.length; i++) {
    const el = cache.sizeButtons[i];
    const val = el.dataset.size!;
    const isSelected = selectedSize === val;

    if (isSelected) {
      el.classList.add("bg-black", "text-white", "border-black");
      el.classList.remove(
        "bg-white",
        "text-gray-900",
        "opacity-50",
        "line-through",
        "pointer-events-none",
      );
    } else {
      el.classList.remove("bg-black", "text-white", "border-black");
      el.classList.add("bg-white", "text-gray-900");

      if (availableSizes.has(val)) {
        el.classList.remove(
          "opacity-50",
          "line-through",
          "pointer-events-none",
        );
      } else {
        el.classList.add("opacity-50", "line-through", "pointer-events-none");
      }
    }
  }

  for (let i = 0; i < cache.colorButtons.length; i++) {
    const el = cache.colorButtons[i];
    const val = el.dataset.color!;
    const isSelected = selectedColor === val;

    if (isSelected) {
      el.classList.add("bg-black", "text-white", "border-black");
      el.classList.remove(
        "bg-white",
        "text-gray-900",
        "opacity-50",
        "line-through",
        "pointer-events-none",
      );
    } else {
      el.classList.remove("bg-black", "text-white", "border-black");
      el.classList.add("bg-white", "text-gray-900");

      if (availableColors.has(val)) {
        el.classList.remove(
          "opacity-50",
          "line-through",
          "pointer-events-none",
        );
      } else {
        el.classList.add("opacity-50", "line-through", "pointer-events-none");
      }
    }
  }
}

function updateVariantImage() {
  if (!state.selection?.selectedColor) return;

  const colorIndex = cache.colorButtons.findIndex(
    (btn) => btn.dataset.color === state.selection!.selectedColor,
  );

  if (colorIndex !== -1 && cache.thumbnails[colorIndex]) {
    const url = cache.thumbnails[colorIndex].dataset.imageUrl;
    if (url) switchImage(url);
  }
}

function updatePriceDisplay() {
  if (!state.productPricing || !state.selection) return;

  let variantPricing: VariantPricing | null = null;
  if (state.selection.selectedVariant) {
    const v = state.selection.selectedVariant;
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

  const validation = validateSelection(state.selection, state.variantIndex);
  if (!validation.valid) {
    showToast(validation.error || "Please select options", "error");
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
    addToCart(cartData.data as any);

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
  } catch (e) {
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
