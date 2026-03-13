// src/components/ProductShortcode.tsx
"use client";

import { useState, useEffect } from "react";
import type { ProductPageData } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addToCart } from "@/store/cart";
import { trackFbAddToCart } from "@/lib/analytics";
import { Minus, Plus, ShoppingCart, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { getCurrencySymbol, getCurrencyCode } from "@/lib/currency";
import { getVariantDiscountedPrice } from "@/components/product/lib/pricing-engine";

interface ProductShortcodeProps {
  productData: ProductPageData;
}

export default function ProductShortcode({
  productData,
}: ProductShortcodeProps) {
  const { product, images, variants } = productData;

  const [selectedSize, setSelectedSize] = useState<string | undefined>();
  const [selectedColor, setSelectedColor] = useState<string | undefined>();
  const [quantity, setQuantity] = useState(1);
  const [currentImage, setCurrentImage] = useState(
    images.find((img) => img.isPrimary)?.url || images[0]?.url,
  );
  const [toastMessage, setToastMessage] = useState<{
    msg: string;
    type: "success" | "error";
  } | null>(null);

  const isVariantImagesEnabled = product.metaDescription?.includes(
    "<!--variant_images:enabled-->",
  );

  const sizeOptions = [...new Set(variants.map((v) => v.size).filter(Boolean))];
  const colorOptions = [
    ...new Set(variants.map((v) => v.color).filter(Boolean)),
  ];

  const matchingVariant = variants.find(
    (v) =>
      (!sizeOptions.length || v.size === selectedSize) &&
      (!colorOptions.length || v.color === selectedColor),
  );

  const finalPrice = matchingVariant
    ? getVariantDiscountedPrice(
      matchingVariant.price,
      product.price,
      matchingVariant.discountType,
      matchingVariant.discountPercentage,
      matchingVariant.discountAmount,
      product.discountType,
      product.discountPercentage,
      product.discountAmount,
    )
    : product.discountedPrice;
  const originalPrice = matchingVariant?.price || product.price;
  const hasDiscount = finalPrice < originalPrice;

  useEffect(() => {
    if (isVariantImagesEnabled && selectedColor) {
      const colorIndex = colorOptions.indexOf(selectedColor);
      if (colorIndex !== -1 && images[colorIndex]) {
        setCurrentImage(images[colorIndex].url);
      }
    }
  }, [selectedColor, isVariantImagesEnabled, colorOptions, images]);

  const showToast = (msg: string, type: "success" | "error") => {
    setToastMessage({ msg, type });
    setTimeout(() => setToastMessage(null), 3000);
  };

  const handleAddToCart = (redirectToCart: boolean) => {
    if (
      (sizeOptions.length > 0 && !selectedSize) ||
      (colorOptions.length > 0 && !selectedColor)
    ) {
      showToast("Please select all required options.", "error");
      return;
    }
    if (variants.length > 0 && !matchingVariant) {
      showToast("Selected combination is not available.", "error");
      return;
    }

    const itemToAdd = {
      id: product.id,
      slug: product.slug,
      name: product.name,
      price: finalPrice,
      image: currentImage,
      quantity,
      variantId: matchingVariant?.id,
      size: selectedSize,
      color: selectedColor,
      freeDelivery: product.freeDelivery,
    };

    addToCart(itemToAdd);
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
      currency: getCurrencyCode(),
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
              src={currentImage}
              alt={product.name}
              className="w-full h-full object-cover"
            />
          </div>
          {images.length > 1 && (
            <div className="flex gap-2 mt-3 overflow-x-auto pb-2">
              {images.map((img) => (
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
                    src={img.url}
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
              {getCurrencySymbol()}{finalPrice.toLocaleString()}
            </span>
            {hasDiscount && (
              <span className="text-lg text-gray-500 line-through">
                {getCurrencySymbol()}{originalPrice.toLocaleString()}
              </span>
            )}
          </div>
          {sizeOptions.length > 0 && (
            <div>
              <h4 className="text-sm font-medium text-gray-900 mb-2">Size</h4>
              <div className="flex flex-wrap gap-2">
                {sizeOptions.map((size) => (
                  <Button
                    key={size}
                    variant={selectedSize === size ? "default" : "outline"}
                    onClick={() => setSelectedSize(size || undefined)}
                  >
                    {size}
                  </Button>
                ))}
              </div>
            </div>
          )}
          {colorOptions.length > 0 && (
            <div>
              <h4 className="text-sm font-medium text-gray-900 mb-2">Color</h4>
              <div className="flex flex-wrap gap-2">
                {colorOptions.map((color) => (
                  <Button
                    key={color}
                    variant={selectedColor === color ? "default" : "outline"}
                    onClick={() => setSelectedColor(color || undefined)}
                  >
                    {color}
                  </Button>
                ))}
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
              onClick={() => handleAddToCart(false)}
            >
              <ShoppingCart className="mr-2 h-4 w-4" /> Add to Cart
            </Button>
            <Button size="lg" onClick={() => handleAddToCart(true)}>
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
