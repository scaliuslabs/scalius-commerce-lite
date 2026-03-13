// src/components/sliders/ProductCarousel.tsx
// Carousel layout collection component
"use client";

import * as React from "react";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  type CarouselApi,
} from "@/components/ui/carousel";
import type { CollectionWithProducts, Product } from "@/lib/api";
import { ArrowRight, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { formatDiscountBadge } from "@/components/product/lib/pricing-engine";
import { getOptimizedImageUrl } from "@/lib/image-optimizer";
import { getCurrencySymbol } from "@/lib/currency";

function ProductCarouselCard({ product }: { product: Product }) {
  const productImageUrl = getOptimizedImageUrl(product.imageUrl, {
    width: 400,
    height: 400,
    quality: 80,
  });

  const hasDiscount = product.discountedPrice < product.price;
  const discountBadge = formatDiscountBadge(
    product.discountType,
    product.discountPercentage,
    product.discountAmount,
  );

  return (
    <div className="group relative flex h-full flex-col bg-card rounded-2xl overflow-hidden transition-all duration-500 hover:shadow-[0_20px_50px_rgba(0,0,0,0.08)] border border-border/50 hover:border-transparent">
      {/* Image Container */}
      <div className="relative aspect-[4/5] overflow-hidden bg-muted">
        <a
          href={`/products/${product.slug}`}
          className="block w-full h-full"
          aria-label={`View ${product.name}`}
        >
          <img
            src={productImageUrl}
            alt={product.name}
            className="h-full w-full object-contain object-center transition-transform duration-700 ease-out group-hover:scale-110"
            loading="lazy"
            decoding="async"
          />
        </a>
        {discountBadge && (
          <span className="absolute top-3 left-3 px-2.5 py-1 text-[10px] font-bold tracking-wider uppercase text-destructive-foreground bg-destructive rounded-full shadow-sm pointer-events-none">
            {discountBadge}
          </span>
        )}
        {/* Desktop View Button */}
        <div className="absolute inset-x-0 bottom-0 p-3 translate-y-2 opacity-0 group-hover:translate-y-0 group-hover:opacity-100 transition-all duration-300 ease-out hidden lg:block">
          <a
            href={`/products/${product.slug}`}
            className="w-full h-10 flex items-center justify-center gap-2 bg-primary text-primary-foreground text-xs font-semibold rounded-xl shadow-xl hover:bg-primary/90 transition-colors"
          >
            View Details
            <ArrowRight className="h-4 w-4" />
          </a>
        </div>
      </div>

      {/* Details --> tighter padding & hierarchy */}
      <div className="p-3 sm:p-4 flex flex-col flex-1">
        <div className="mb-1">
          <h3 className="text-[14px] sm:text-[15px] font-semibold text-foreground leading-tight line-clamp-2 min-h-[2.25rem] group-hover:text-primary transition-colors duration-300">
            <a href={`/products/${product.slug}`}>{product.name}</a>
          </h3>
        </div>
        <div className="mt-auto flex items-center justify-between gap-1.5">
          <div className="flex flex-col gap-0">
            {hasDiscount && (
              <span className="text-[10px] sm:text-xs text-muted-foreground line-through font-medium leading-none">
                {getCurrencySymbol()}{product.price.toLocaleString()}
              </span>
            )}
            <span className="text-base sm:text-lg font-extrabold text-foreground tracking-tight leading-tight">
              {getCurrencySymbol()}{product.discountedPrice.toLocaleString()}
            </span>
          </div>
          {/* Mobile View Button */}
          <a
            href={`/products/${product.slug}`}
            className="lg:hidden h-8 w-8 flex items-center justify-center rounded-xl bg-muted text-foreground active:scale-90 transition-all border border-border"
            aria-label="View product"
          >
            <ArrowRight className="h-3.5 w-3.5" />
          </a>
        </div>
      </div>
    </div>
  );
}

export default function ProductCarousel({
  collection,
}: {
  collection: CollectionWithProducts;
}) {
  const [api, setApi] = React.useState<CarouselApi>();
  const [current, setCurrent] = React.useState(0);
  const [count, setCount] = React.useState(0);

  const products = collection.products || [];
  const categories = collection.categories || [];
  const config = collection.config || {};
  const title = config.title || collection.name;
  const showViewAll = categories.length === 1;

  React.useEffect(() => {
    if (!api) return;

    setCount(api.scrollSnapList().length);
    setCurrent(api.selectedScrollSnap());

    api.on("select", () => {
      setCurrent(api.selectedScrollSnap());
    });
  }, [api]);

  // Auto-scroll logic with cleanup
  React.useEffect(() => {
    if (!api || products.length <= 1) return;

    const intervalId = setInterval(() => {
      if (api.canScrollNext()) {
        api.scrollNext();
      } else {
        api.scrollTo(0);
      }
    }, 5000);

    return () => clearInterval(intervalId);
  }, [api, products.length]);

  if (products.length === 0) return null;

  return (
    <section className="w-full py-3 md:py-6 overflow-hidden">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Header --> minimized spacing */}
        <div className="flex items-end justify-between gap-4 mb-3 md:mb-5">
          <div className="space-y-1">
            <h2 className="text-xl sm:text-2xl font-extrabold text-foreground tracking-tight">
              {title}
            </h2>
            <div className="h-0.5 w-8 bg-primary rounded-full" />
          </div>

          <div className="flex items-center gap-2">
            {showViewAll && (
              <a
                href={`/categories/${categories[0].slug}`}
                className="group hidden sm:flex items-center gap-1.5 text-xs font-bold text-foreground hover:text-primary transition-colors"
              >
                Explore
                <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-1" />
              </a>
            )}

            {/* Desktop Navigation Arrows */}
            <div className="hidden md:flex items-center gap-1.5 ml-1">
              <Button
                variant="outline"
                size="icon"
                className="rounded-full h-8 w-8 border-input hover:border-primary hover:bg-primary hover:text-primary-foreground transition-all shadow-sm disabled:opacity-30"
                onClick={() => api?.scrollPrev()}
                disabled={!api?.canScrollPrev()}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="rounded-full h-8 w-8 border-input hover:border-primary hover:bg-primary hover:text-primary-foreground transition-all shadow-sm disabled:opacity-30"
                onClick={() => api?.scrollNext()}
                disabled={!api?.canScrollNext()}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>

        {/* Carousel Container */}
        <div className="relative -mx-4 px-4 overflow-visible">
          <Carousel
            setApi={setApi}
            opts={{
              align: "start",
              loop: true,
              skipSnaps: false,
            }}
            className="w-full"
          >
            <CarouselContent className="-ml-3 md:-ml-4">
              {products.map((product) => (
                <CarouselItem
                  key={product.id}
                  className="pl-3 md:pl-4 basis-[72%] sm:basis-1/3 lg:basis-1/4 xl:basis-1/5 py-2"
                >
                  <ProductCarouselCard product={product} />
                </CarouselItem>
              ))}
            </CarouselContent>
          </Carousel>
        </div>

        {/* Footer Navigation */}
        <div className="mt-2 flex flex-col sm:flex-row items-center justify-between gap-3">
          {/* Progress Indicators (Dots) */}
          <div className="flex items-center gap-1.5">
            {Array.from({ length: count }).map((_, i) => (
              <button
                key={i}
                className="group relative p-1.5 -m-1.5" // Optimized target
                onClick={() => api?.scrollTo(i)}
                aria-label={`Go to slide ${i + 1}`}
              >
                <div
                  className={cn(
                    "h-1 transition-all duration-300 rounded-full",
                    current === i
                      ? "w-6 bg-primary"
                      : "w-1.5 bg-muted-foreground/30 group-hover:bg-muted-foreground/50",
                  )}
                />
              </button>
            ))}
          </div>

          {showViewAll && (
            <a
              href={`/categories/${categories[0].slug}`}
              className="sm:hidden flex items-center gap-2 text-[10px] font-bold text-foreground border-b border-primary/30 pb-0.5"
            >
              Explore Collection
              <ArrowRight className="h-3 w-3" />
            </a>
          )}
        </div>
      </div>
    </section>
  );
}
