"use client";

import { useEffect, useMemo, useState } from "react";
import type { ProductPageData } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addToCart } from "@/store/cart";
import { trackFbAddToCart } from "@/lib/analytics";
import { Minus, Plus, ShoppingCart, Check } from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { formatPrice, getCurrencyCode, getCurrencySymbol, getDecimalPlaces } from "@/lib/currency";
import { getBuyerVariantPricePresentation, type ProductPricing } from "@/components/product/lib/pricing-engine";
import {
  createInitialSelection,
  filterVariantsBySelection,
  getVariantOptionAvailabilityMap,
  reconcileSelectionForValue,
  resolveExactVariantSelection,
  shouldShowStartingVariantPrice,
  type VariantSelection,
} from "@/components/product/lib/variant-state-machine";
import { getProductImageUrl, hasProductImage, PRODUCT_IMAGE_FALLBACK } from "@/lib/product-media";
import { isVariantAvailable, resolveBuyerVariants } from "@/lib/product-sellable-variants";
import { roundPriceToPrecision } from "@scalius/shared/price-utils";

export default function ProductShortcode({ productData }: { productData: ProductPageData }) {
  const { product, media, variants } = productData;
  const images = useMemo(() => media.flatMap((item) => {
    if (item.kind === "image") {
      return [{ id: item.id, mediaId: item.mediaId, url: item.url, alt: item.altText, isPrimary: item.isPrimary }];
    }
    return item.posterMediaId && item.posterUrl
      ? [{ id: item.id, mediaId: item.posterMediaId, url: item.posterUrl, alt: item.altText, isPrimary: item.isPrimary }]
      : [];
  }), [media]);
  const options = product.options ?? [];
  const buyerVariants = useMemo(() => resolveBuyerVariants(variants).variants, [variants]);
  const isUnavailable = !buyerVariants.some(isVariantAvailable);
  const currencyCode = getCurrencyCode();
  const currencySymbol = getCurrencySymbol();
  const decimals = typeof window !== "undefined" && Number.isInteger(window.__CURRENCY_DECIMAL_PLACES__)
    ? window.__CURRENCY_DECIMAL_PLACES__!
    : getDecimalPlaces(currencyCode);
  const formatBuyerPrice = (price: number) => formatPrice(price, { symbol: currencySymbol, code: currencyCode, precision: decimals });
  const primaryImage = product.imageUrl
    ?? images.find((image) => image.isPrimary && hasProductImage(image.url))?.url
    ?? images.find((image) => hasProductImage(image.url))?.url
    ?? PRODUCT_IMAGE_FALLBACK;
  const primaryImageMediaId = product.imageMediaId
    ?? images.find((image) => image.url === primaryImage)?.mediaId;
  const [quantity, setQuantity] = useState(1);
  const [selection, setSelection] = useState<VariantSelection>(() => createInitialSelection(options, buyerVariants));
  const [currentImage, setCurrentImage] = useState(primaryImage);
  const [currentImageMediaId, setCurrentImageMediaId] = useState(primaryImageMediaId);
  const [toast, setToast] = useState<{ msg: string; type: "success" | "error" } | null>(null);
  const matchingVariant = resolveExactVariantSelection(buyerVariants, selection)?.variant;
  const compatibleVariants = filterVariantsBySelection(buyerVariants, selection);
  const pricing: ProductPricing = {
    basePrice: product.price,
    discountType: product.discountType,
    discountPercentage: product.discountPercentage,
    discountAmount: product.discountAmount,
    currencyDecimalPlaces: decimals,
  };
  const presentation = getBuyerVariantPricePresentation(pricing, matchingVariant ? [matchingVariant] : compatibleVariants);
  const finalPrice = presentation.pricing.finalPrice;
  const originalPrice = roundPriceToPrecision(presentation.pricing.originalPrice, decimals);
  const starting = shouldShowStartingVariantPrice(options.length > 0, matchingVariant);
  const canAdd = Boolean(matchingVariant && isVariantAvailable(matchingVariant));

  useEffect(() => {
    const selected = images.find((image) => image.id === matchingVariant?.imageId);
    setCurrentImage(selected?.url && hasProductImage(selected.url) ? selected.url : primaryImage);
    setCurrentImageMediaId(selected?.mediaId ?? primaryImageMediaId);
  }, [images, matchingVariant?.imageId, primaryImage, primaryImageMediaId]);

  const showToast = (msg: string, type: "success" | "error") => {
    setToast({ msg, type });
    window.setTimeout(() => setToast(null), 3000);
  };

  const add = (redirect: boolean) => {
    if (!matchingVariant || !isVariantAvailable(matchingVariant)) {
      showToast(options.some((option) => !selection[option.id]) ? "Please select all required options." : "Selected combination is unavailable.", "error");
      return;
    }
    const added = addToCart({
      id: product.id,
      slug: product.slug,
      name: product.name,
      price: finalPrice,
      image: currentImage,
      ...(currentImageMediaId ? { imageMediaId: currentImageMediaId } : {}),
      quantity,
      variantId: matchingVariant.id,
      options: matchingVariant.selectedOptions.map(({ name, value }) => ({ name, label: value })),
      freeDelivery: product.freeDelivery,
    });
    if (!added) return showToast("This product option could not be added. Please refresh and try again.", "error");
    trackFbAddToCart({
      content_ids: [matchingVariant.id], content_name: product.name, content_type: "product",
      contents: [{ id: matchingVariant.id, quantity, item_price: finalPrice }],
      currency: currencyCode, value: finalPrice * quantity,
    });
    showToast("Added to cart successfully!", "success");
    if (redirect) window.setTimeout(() => { window.location.href = "/cart"; }, 300);
    else document.dispatchEvent(new CustomEvent("open-cart"));
  };

  return (
    <div className="product-shortcode rounded-xl border border-gray-200 bg-white p-4 shadow-sm transition-all hover:shadow-md sm:p-6">
      <div className="grid grid-cols-1 gap-4 sm:gap-6 lg:grid-cols-2">
        <div>
          <div className="aspect-square overflow-hidden rounded-lg border border-gray-100 bg-gray-50">
            <img src={getProductImageUrl(currentImage, { width: 600, height: 600, quality: 85, format: "auto", fit: "contain" })} alt={product.name} className="h-full w-full object-contain" loading="lazy" />
          </div>
          {images.filter((image) => hasProductImage(image.url)).length > 1 ? (
            <div className="mt-3 flex gap-2 overflow-x-auto pb-2">
              {images.filter((image) => hasProductImage(image.url)).map((image) => (
                <button key={image.id} onClick={() => {
                  setCurrentImage(image.url);
                  setCurrentImageMediaId(image.mediaId);
                }} className={cn("h-16 w-16 shrink-0 overflow-hidden rounded-lg border-2 sm:h-20 sm:w-20", currentImage === image.url ? "border-primary" : "border-gray-200")}>
                  <img src={getProductImageUrl(image.url, { width: 120, height: 120, quality: 75, format: "auto", fit: "cover" })} alt={image.alt || product.name} className="h-full w-full object-cover" />
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <div className="space-y-4">
          <h3 className="text-xl font-bold text-gray-900 sm:text-2xl">{product.name}</h3>
          <div className="flex items-center gap-3">
            <span className="text-2xl font-bold text-destructive sm:text-3xl">{starting ? "From " : ""}{formatBuyerPrice(finalPrice)}</span>
            {matchingVariant && presentation.pricing.hasDiscount ? <span className="text-lg text-gray-500 line-through">{formatBuyerPrice(originalPrice)}</span> : null}
          </div>
          {options.map((option) => {
            const availability = getVariantOptionAvailabilityMap(buyerVariants, option.id, option.values.map((value) => value.id), selection);
            return (
              <div key={option.id}>
                <h4 className="mb-2 text-sm font-medium text-gray-900">{option.name}</h4>
                <div className="flex flex-wrap gap-2">
                  {option.values.map((value) => {
                    const status = availability.get(value.id) ?? "sold_out";
                    const selected = selection[option.id] === value.id;
                    return (
                      <Button key={value.id} type="button" variant={selected ? "default" : "outline"} disabled={status === "sold_out"} aria-pressed={selected} className={cn(status === "incompatible" && "border-dashed bg-muted", status === "sold_out" && "line-through opacity-50")} onClick={() => setSelection((current) => current[option.id] === value.id ? Object.fromEntries(Object.entries(current).filter(([id]) => id !== option.id)) : reconcileSelectionForValue(buyerVariants, option.id, value.id, current, options.map((item) => item.id)))}>
                        {value.value}
                      </Button>
                    );
                  })}
                </div>
              </div>
            );
          })}
          <div className="flex items-center gap-4">
            <h4 className="text-sm font-medium text-gray-700">Quantity</h4>
            <div className="flex items-center">
              <Button variant="outline" size="icon" className="h-9 w-9" onClick={() => setQuantity((value) => Math.max(1, value - 1))}><Minus className="h-4 w-4" /></Button>
              <Input type="number" value={quantity} readOnly className="h-9 w-14 border-y-0 text-center" />
              <Button variant="outline" size="icon" className="h-9 w-9" onClick={() => setQuantity((value) => value + 1)}><Plus className="h-4 w-4" /></Button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 pt-2">
            <Button variant="outline" size="lg" disabled={!canAdd} onClick={() => add(false)}><ShoppingCart className="mr-2 h-4 w-4" />Add to Cart</Button>
            <Button size="lg" disabled={isUnavailable} onClick={() => add(true)}><Check className="mr-2 h-4 w-4" />Buy Now</Button>
          </div>
          {toast ? <div className={cn("rounded-md p-3 text-sm", toast.type === "success" ? "bg-primary/10 text-primary" : "bg-destructive/10 text-destructive")}>{toast.msg}</div> : null}
        </div>
      </div>
    </div>
  );
}
