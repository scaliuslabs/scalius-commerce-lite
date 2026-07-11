// src/components/ProductShortcode.tsx
"use client";

import {
  useState,
  useEffect,
  useMemo,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { ProductPageData } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addToCart, type CartItemOption } from "@/store/cart";
import { trackFbAddToCart } from "@/lib/analytics";
import { Minus, Plus, ShoppingCart, Check } from "lucide-react";
import { cn } from "@scalius/shared/utils";
import {
  formatPrice,
  getCurrencyCode,
  getCurrencySymbol,
  getDecimalPlaces,
} from "@/lib/currency";
import {
  getBuyerVariantPricePresentation,
  type ProductPricing,
} from "@/components/product/lib/pricing-engine";
import {
  filterVariantsBySelection,
  getVariantOptionAvailabilityMap,
  resolveExactVariantSelection,
  selectVariantOption,
  shouldShowStartingVariantPrice,
  toggleVariantOption,
  type VariantOptionAvailability,
  type VariantOptionAxis,
} from "@/components/product/lib/variant-state-machine";
import {
  getProductImageUrl,
  hasProductImage,
  PRODUCT_IMAGE_FALLBACK,
} from "@/lib/product-media";
import {
  isVariantAvailable,
  resolveBuyerVariants,
} from "@/lib/product-sellable-variants";
import { roundPriceToPrecision } from "@scalius/shared/price-utils";
import {
  resolveProductVariantImageConfiguration,
  resolveVariantImageId,
} from "@/lib/variant-image-mapping";

interface ProductShortcodeProps {
  productData: ProductPageData;
}

export default function ProductShortcode({
  productData,
}: ProductShortcodeProps) {
  const { product, images, variants, variantImageMappings } = productData;
  const buyerVariants = useMemo(
    () => resolveBuyerVariants(variants).variants,
    [variants],
  );
  const isUnavailable =
    buyerVariants.length === 0 ||
    !buyerVariants.some((variant) => isVariantAvailable(variant));
  const option1Label = product.variantOption1Label?.trim() || "Option 1";
  const option2Label = product.variantOption2Label?.trim() || "Option 2";
  const currencyCode = getCurrencyCode();
  const currencySymbol = getCurrencySymbol();
  const configuredDecimalPlaces =
    typeof window !== "undefined" &&
    Number.isInteger(window.__CURRENCY_DECIMAL_PLACES__) &&
    window.__CURRENCY_DECIMAL_PLACES__! >= 0 &&
    window.__CURRENCY_DECIMAL_PLACES__! <= 6
      ? window.__CURRENCY_DECIMAL_PLACES__!
      : getDecimalPlaces(currencyCode);
  const formatBuyerPrice = (price: number) =>
    formatPrice(price, {
      symbol: currencySymbol,
      code: currencyCode,
      precision: configuredDecimalPlaces,
    });

  const [quantity, setQuantity] = useState(1);
  const [currentImage, setCurrentImage] = useState(
    images.find((img) => hasProductImage(img.url) && img.isPrimary)?.url ||
      images.find((img) => hasProductImage(img.url))?.url ||
      product.imageUrl ||
      PRODUCT_IMAGE_FALLBACK,
  );
  const [toastMessage, setToastMessage] = useState<{
    msg: string;
    type: "success" | "error";
  } | null>(null);

  const variantImageConfiguration = useMemo(
    () => resolveProductVariantImageConfiguration({
      product,
      images,
      variants: buyerVariants,
      mappings: variantImageMappings ?? [],
    }),
    [buyerVariants, images, product, variantImageMappings],
  );
  const isVariantImagesEnabled = variantImageConfiguration.enabled;
  const variantImageAxis = variantImageConfiguration.axis;

  const sizeOptions = useMemo(
    () => [
      ...new Set(
        buyerVariants.flatMap((variant) => {
          const value = variant.size?.trim();
          return value ? [value] : [];
        }),
      ),
    ],
    [buyerVariants],
  );
  const colorOptions = useMemo(
    () => [
      ...new Set(
        buyerVariants.flatMap((variant) => {
          const value = variant.color?.trim();
          return value ? [value] : [];
        }),
      ),
    ],
    [buyerVariants],
  );
  const globalSizeAvailability = useMemo(
    () =>
      getVariantOptionAvailabilityMap(buyerVariants, "size", sizeOptions, {}),
    [buyerVariants, sizeOptions],
  );
  const globalColorAvailability = useMemo(
    () =>
      getVariantOptionAvailabilityMap(buyerVariants, "color", colorOptions, {}),
    [buyerVariants, colorOptions],
  );
  const [selectedSize, setSelectedSize] = useState<string | undefined>(() =>
    sizeOptions.length === 1 &&
    globalSizeAvailability.get(sizeOptions[0] ?? "") !== "sold_out"
      ? sizeOptions[0]
      : undefined,
  );
  const [selectedColor, setSelectedColor] = useState<string | undefined>(() =>
    colorOptions.length === 1 &&
    globalColorAvailability.get(colorOptions[0] ?? "") !== "sold_out"
      ? colorOptions[0]
      : undefined,
  );
  const sizeOptionAvailability = useMemo(
    () =>
      getVariantOptionAvailabilityMap(buyerVariants, "size", sizeOptions, {
        selectedSize,
        selectedColor,
      }),
    [buyerVariants, selectedColor, selectedSize, sizeOptions],
  );
  const colorOptionAvailability = useMemo(
    () =>
      getVariantOptionAvailabilityMap(buyerVariants, "color", colorOptions, {
        selectedSize,
        selectedColor,
      }),
    [buyerVariants, colorOptions, selectedColor, selectedSize],
  );

  const exactSelection = resolveExactVariantSelection(buyerVariants, {
    selectedSize,
    selectedColor,
  });
  const matchingVariant = exactSelection?.variant;
  const canAddToCart = Boolean(
    matchingVariant && isVariantAvailable(matchingVariant),
  );
  const addToCartAriaLabel = canAddToCart && matchingVariant
    ? `Add ${product.name} to cart`
    : `Select an available ${product.name} option to add to cart`;
  const compatibleVariants = filterVariantsBySelection(buyerVariants, {
    selectedSize,
    selectedColor,
  });
  const productPricing: ProductPricing = {
    basePrice: product.price,
    discountType: product.discountType,
    discountPercentage: product.discountPercentage,
    discountAmount: product.discountAmount,
    currencyDecimalPlaces: configuredDecimalPlaces,
  };
  const pricePresentation = getBuyerVariantPricePresentation(
    productPricing,
    matchingVariant ? [matchingVariant] : compatibleVariants,
  );
  const finalPrice = pricePresentation.pricing.finalPrice;
  const originalPrice = roundPriceToPrecision(
    pricePresentation.pricing.originalPrice,
    configuredDecimalPlaces,
  );
  const showsStartingPrice = shouldShowStartingVariantPrice(
    sizeOptions.length > 0 || colorOptions.length > 0,
    matchingVariant,
  );
  const hasDiscount = Boolean(
    matchingVariant && pricePresentation.pricing.hasDiscount,
  );
  const currentDisplayImage = getProductImageUrl(currentImage, {
    width: 600,
    height: 600,
    quality: 85,
    format: "auto",
    fit: "contain",
  });

  useEffect(() => {
    const selectedOptionValue =
      variantImageAxis === "option1" ? selectedSize : selectedColor;
    if (isVariantImagesEnabled) {
      const imageId = resolveVariantImageId({
        enabled: true,
        axis: variantImageAxis,
        mappings: variantImageConfiguration.mappings,
        images,
        selectedVariantId: matchingVariant?.id,
        selectedOptionValue,
      });
      const variantImage = images.find((image) => image.id === imageId);
      if (variantImage?.url && hasProductImage(variantImage.url)) {
        setCurrentImage(variantImage.url);
      }
    }
  }, [
    images,
    isVariantImagesEnabled,
    matchingVariant?.id,
    selectedColor,
    selectedSize,
    variantImageAxis,
    variantImageConfiguration.mappings,
  ]);

  const showToast = (msg: string, type: "success" | "error") => {
    setToastMessage({ msg, type });
    setTimeout(() => setToastMessage(null), 3000);
  };

  const toggleOption = (axis: VariantOptionAxis, value: string) => {
    const next = toggleVariantOption(
      buyerVariants,
      { selectedSize, selectedColor },
      axis,
      value,
    );
    setSelectedSize(next.selectedSize);
    setSelectedColor(next.selectedColor);
  };

  const selectOption = (axis: VariantOptionAxis, value: string) => {
    const next = selectVariantOption(
      buyerVariants,
      { selectedSize, selectedColor },
      axis,
      value,
    );
    setSelectedSize(next.selectedSize);
    setSelectedColor(next.selectedColor);
  };

  const navigateOptionButtons = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    axis: VariantOptionAxis,
  ) => {
    const direction =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (!direction) return;

    const buttons = Array.from(
      event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
        `[data-option-axis="${axis}"]`,
      ) ?? [],
    ).filter((button) => !button.disabled);
    const currentIndex = buttons.indexOf(event.currentTarget);
    if (currentIndex < 0 || buttons.length < 2) return;

    event.preventDefault();
    const next =
      buttons[(currentIndex + direction + buttons.length) % buttons.length];
    next?.focus();
    const nextValue = next?.dataset.optionValue;
    if (nextValue) selectOption(axis, nextValue);
  };

  const optionAriaLabel = (
    axis: VariantOptionAxis,
    value: string,
    availability: VariantOptionAvailability,
    selected: boolean,
  ) => {
    const axisLabel = axis === "size" ? option1Label : option2Label;
    if (availability === "sold_out") {
      return `${axisLabel}: ${value}. Out of stock.`;
    }
    if (selected) {
      return `${axisLabel}: ${value}. Selected; activate again to clear.`;
    }
    if (availability === "incompatible") {
      const opposingLabel = axis === "size" ? option2Label : option1Label;
      const opposingValue = axis === "size" ? selectedColor : selectedSize;
      return opposingValue
        ? `${axisLabel}: ${value}. Not available with ${opposingLabel} ${opposingValue}; selecting it clears ${opposingLabel}.`
        : `${axisLabel}: ${value}. Not available with the current selection.`;
    }
    return `${axisLabel}: ${value}`;
  };

  const handleAddToCart = (redirectToCart: boolean) => {
    if (isUnavailable) {
      showToast("This product is not available right now.", "error");
      return;
    }
    if (
      (sizeOptions.length > 0 && !selectedSize) ||
      (colorOptions.length > 0 && !selectedColor)
    ) {
      showToast("Please select all required options.", "error");
      return;
    }
    if (!matchingVariant) {
      showToast("Selected combination is not available.", "error");
      return;
    }
    if (!isVariantAvailable(matchingVariant)) {
      showToast("Selected option is out of stock.", "error");
      return;
    }

    const options: CartItemOption[] = [
      selectedSize ? { name: option1Label, label: selectedSize } : null,
      selectedColor ? { name: option2Label, label: selectedColor } : null,
    ].filter((option): option is CartItemOption => Boolean(option));

    const itemToAdd = {
      id: product.id,
      slug: product.slug,
      name: product.name,
      price: finalPrice,
      image: currentImage || PRODUCT_IMAGE_FALLBACK,
      quantity,
      variantId: matchingVariant.id,
      stock: matchingVariant.stock,
      reservedStock: matchingVariant.reservedStock,
      trackInventory: matchingVariant.trackInventory,
      size: selectedSize,
      color: selectedColor,
      ...(options.length > 0 ? { options } : {}),
      freeDelivery: product.freeDelivery,
    };

    if (!addToCart(itemToAdd)) {
      showToast(
        "This product option could not be added. Please refresh and try again.",
        "error",
      );
      return;
    }
    trackFbAddToCart({
      content_ids: [matchingVariant?.id || product.id],
      content_name: product.name,
      content_type: "product",
      contents: [
        {
          id: matchingVariant?.id || product.id,
          quantity,
          item_price: finalPrice,
        },
      ],
      currency: currencyCode,
      value: finalPrice * quantity,
    });

    showToast("Added to cart successfully!", "success");

    if (redirectToCart) {
      setTimeout(() => {
        window.location.href = "/cart";
      }, 500);
    } else {
      document.dispatchEvent(new CustomEvent("open-cart"));
    }
  };

  return (
    <div className="product-shortcode bg-white border border-gray-200 rounded-xl p-4 sm:p-6 shadow-sm hover:shadow-md transition-all duration-300">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
        {/* Image Gallery */}
        <div>
          <div className="aspect-square overflow-hidden rounded-lg bg-gray-50 border border-gray-100">
            <img
              src={currentDisplayImage}
              alt={product.name}
              className="w-full h-full object-contain"
              loading="lazy"
              decoding="async"
            />
          </div>
          {images.filter((img) => hasProductImage(img.url)).length > 1 && (
            <div className="flex gap-2 mt-3 overflow-x-auto pb-2">
              {images
                .filter((img) => hasProductImage(img.url))
                .map((img) => (
                  <button
                    key={img.id}
                    onClick={() => setCurrentImage(img.url)}
                    className={cn(
                      "shrink-0 w-16 h-16 sm:w-20 sm:h-20 overflow-hidden rounded-lg border-2 hover:border-primary transition-colors",
                      currentImage === img.url
                        ? "border-primary"
                        : "border-gray-200",
                    )}
                  >
                    <img
                      src={getProductImageUrl(img.url, {
                        width: 120,
                        height: 120,
                        quality: 75,
                        format: "auto",
                        fit: "cover",
                      })}
                      alt={img.alt || product.name}
                      className="w-full h-full object-cover"
                    />
                  </button>
                ))}
            </div>
          )}
        </div>

        {/* Product Info */}
        <div className="product-info space-y-4">
          <h3 className="text-xl sm:text-2xl font-bold text-gray-900">
            {product.name}
          </h3>
          <div className="flex items-center gap-3">
            <span className="text-2xl sm:text-3xl font-bold text-destructive">
              {`${showsStartingPrice ? "From " : ""}${formatBuyerPrice(finalPrice)}`}
            </span>
            {hasDiscount && (
              <span className="text-lg text-gray-500 line-through">
                {formatBuyerPrice(originalPrice)}
              </span>
            )}
          </div>
          {sizeOptions.length > 0 && (
            <div>
              <h4 className="text-sm font-medium text-gray-900 mb-2">
                {option1Label}
              </h4>
              <div className="flex flex-wrap gap-2">
                {sizeOptions.map((size) => {
                  const availability =
                    sizeOptionAvailability.get(size) ?? "sold_out";
                  const isSelected = selectedSize === size;
                  return (
                    <Button
                      key={size}
                      type="button"
                      variant={isSelected ? "default" : "outline"}
                      disabled={availability === "sold_out"}
                      aria-pressed={isSelected}
                      aria-label={optionAriaLabel(
                        "size",
                        size,
                        availability,
                        isSelected,
                      )}
                      data-option-availability={availability}
                      data-option-axis="size"
                      data-option-value={size}
                      className={cn(
                        availability === "incompatible" &&
                          "border-dashed border-muted-foreground bg-muted text-foreground",
                        availability === "sold_out" &&
                          "cursor-not-allowed line-through opacity-50",
                      )}
                      onClick={() => toggleOption("size", size)}
                      onKeyDown={(event) =>
                        navigateOptionButtons(event, "size")
                      }
                    >
                      {size}
                    </Button>
                  );
                })}
              </div>
            </div>
          )}
          {colorOptions.length > 0 && (
            <div>
              <h4 className="text-sm font-medium text-gray-900 mb-2">
                {option2Label}
              </h4>
              <div className="flex flex-wrap gap-2">
                {colorOptions.map((color) => {
                  const availability =
                    colorOptionAvailability.get(color) ?? "sold_out";
                  const isSelected = selectedColor === color;
                  return (
                    <Button
                      key={color}
                      type="button"
                      variant={isSelected ? "default" : "outline"}
                      disabled={availability === "sold_out"}
                      aria-pressed={isSelected}
                      aria-label={optionAriaLabel(
                        "color",
                        color,
                        availability,
                        isSelected,
                      )}
                      data-option-availability={availability}
                      data-option-axis="color"
                      data-option-value={color}
                      className={cn(
                        availability === "incompatible" &&
                          "border-dashed border-muted-foreground bg-muted text-foreground",
                        availability === "sold_out" &&
                          "cursor-not-allowed line-through opacity-50",
                      )}
                      onClick={() => toggleOption("color", color)}
                      onKeyDown={(event) =>
                        navigateOptionButtons(event, "color")
                      }
                    >
                      {color}
                    </Button>
                  );
                })}
              </div>
            </div>
          )}
          <div className="flex items-center gap-4">
            <h4 className="text-sm font-medium text-gray-700">Quantity</h4>
            <div className="flex items-center">
              <Button
                variant="outline"
                size="icon"
                className="h-9 w-9"
                onClick={() => setQuantity((q) => Math.max(1, q - 1))}
              >
                <Minus className="h-4 w-4" />
              </Button>
              <Input
                type="number"
                value={quantity}
                readOnly
                className="h-9 w-14 text-center border-y-0"
              />
              <Button
                variant="outline"
                size="icon"
                className="h-9 w-9"
                onClick={() => setQuantity((q) => q + 1)}
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <div className="action-buttons grid grid-cols-2 gap-3 pt-2">
            <Button
              variant="outline"
              size="lg"
              disabled={!canAddToCart}
              aria-label={addToCartAriaLabel}
              onClick={() => handleAddToCart(false)}
            >
              <ShoppingCart className="mr-2 h-4 w-4" /> Add to Cart
            </Button>
            <Button
              size="lg"
              disabled={isUnavailable}
              onClick={() => handleAddToCart(true)}
            >
              <Check className="mr-2 h-4 w-4" /> Buy Now
            </Button>
          </div>
          {toastMessage && (
            <div
              className={cn(
                "p-3 rounded-md text-sm",
                toastMessage.type === "success"
                  ? "bg-primary/10 text-primary border-primary/20"
                  : "bg-destructive/10 text-destructive border-destructive/20",
              )}
            >
              {toastMessage.msg}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
