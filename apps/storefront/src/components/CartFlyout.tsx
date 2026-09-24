// src/components/CartFlyout.tsx
import {
  Sheet,
  SheetContent,
  SheetClose,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  cartStore,
  hydrateCartFromStorage,
  updateCartItemByKey,
  removeCartItemByKey,
  clearCart,
  addToCart,
  restoreCart,
  type CartStore,
} from "@/store/cart";
import { Button } from "@/components/ui/button";
import { useStore } from "@nanostores/react";
import { atom } from "nanostores";
import {
  ShoppingBag,
  Trash2,
  X,
  Plus,
  Minus,
  ArrowRight,
  ChevronDown,
} from "lucide-react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@scalius/shared/utils";
import { formatMoney } from "@/lib/currency";
import { getProductImageUrl } from "@/lib/product-media";
import { previewCartDiscounts } from "@/lib/cart/browser-api";
import type { CheckoutDiscountFacts } from "@/lib/checkout/tax-quote-contract";
import type { CartValidationIssue } from "@/lib/api/orders";
import { cartItemVariantLabel } from "@/lib/cart/item-options";
import type { ProductRecommendations } from "@/lib/api/types";
import {
  fetchRecommendationsFromBrowser,
  recommendationQuery,
  recommendationTitle,
} from "@/lib/recommendations";
import { formatDiscountLineLabel } from "@scalius/shared/checkout-language-format";

export const cartOpenState = atom<boolean>(false);

const CART_RECOMMENDATION_LIMIT = 4;
const cartRecommendationCache = new Map<string, ProductRecommendations | null>();

/**
 * "You might also like" for the open drawer: fetched lazily once per cart
 * contents, only while the drawer is open and has items. Products already in
 * the cart are never suggested.
 */
function useCartRecommendations(cart: CartStore, isOpen: boolean) {
  const productIds = Object.values(cart.items).map((item) => item.id);
  const key = recommendationQuery(productIds, CART_RECOMMENDATION_LIMIT);
  const [result, setResult] = useState<ProductRecommendations | null>(null);
  useEffect(() => {
    if (!isOpen || productIds.length === 0) return;
    if (cartRecommendationCache.has(key)) {
      setResult(cartRecommendationCache.get(key) ?? null);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void fetchRecommendationsFromBrowser(productIds, CART_RECOMMENDATION_LIMIT, controller.signal)
        .then((recommendations) => {
          if (controller.signal.aborted) return;
          cartRecommendationCache.set(key, recommendations);
          setResult(recommendations);
        });
    }, 400);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
    // `key` encodes the product ids.
  }, [key, isOpen]);
  if (!result || productIds.length === 0) return null;
  const inCart = new Set(productIds);
  const products = result.products.filter((product) => !inCart.has(product.id));
  return products.length > 0 ? { reason: result.reason, products } : null;
}

export type AddToCartEventDetail = Parameters<typeof addToCart>[0] & {
  redirectToCart?: boolean;
};

interface Props {
  onReady?: () => void;
}

export function setCartOpen(value: boolean) {
  if (typeof window !== "undefined") {
    try {
      cartOpenState.set(value);
    } catch (err: unknown) {
      console.error("Error setting cart open state:", err);
    }
  }
}

/**
 * Live facts for the open drawer: automatic savings and offers from the
 * server, and per-line stock problems, so a buyer hears about them before
 * reaching checkout.
 */
function useDrawerCartFacts(cart: CartStore, isOpen: boolean) {
  const [discounts, setDiscounts] = useState<CheckoutDiscountFacts & { totalDiscount: number } | null>(null);
  const [issues, setIssues] = useState<Record<string, CartValidationIssue>>({});
  useEffect(() => {
    const items = Object.entries(cart.items);
    if (!isOpen || items.length === 0) return;
    let current = true;
    const timer = window.setTimeout(() => {
      void previewCartDiscounts(cart.discountCodes, items.map(([, item]) => item)).then((preview) => {
        if (current) setDiscounts(preview.ok ? preview : null);
      });
      void fetch("/api/checkout/validate-cart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: items.map(([cartKey, item]) => ({
            cartKey,
            productId: item.id,
            variantId: item.variantId,
            quantity: item.quantity,
            price: item.price,
            productName: item.name,
            variantLabel: cartItemVariantLabel(item.options),
          })),
        }),
      })
        .then((response) => response.json())
        .then((json: { data?: { issues?: CartValidationIssue[] }; details?: { itemIssues?: CartValidationIssue[] } }) => {
          if (!current) return;
          const found = json?.data?.issues ?? json?.details?.itemIssues ?? [];
          setIssues(Object.fromEntries(found.flatMap((issue) => issue.cartKey ? [[issue.cartKey, issue]] : [])));
        })
        .catch(() => undefined);
    }, 300);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [cart.items, cart.discountCodes, isOpen]);
  return { discounts: Object.keys(cart.items).length > 0 ? discounts : null, issues };
}

export default function CartFlyout({ onReady }: Props) {
  const cart = useStore(cartStore);
  const isOpen = useStore(cartOpenState);
  const { discounts, issues } = useDrawerCartFacts(cart, isOpen);
  const recommendations = useCartRecommendations(cart, isOpen);
  // A line that can't be bought as is blocks Checkout here, like on the cart page.
  const lineIssues = Object.entries(issues).filter(([key]) => cart.items[key]);
  const checkoutBlocked = lineIssues.length > 0;
  // Shopify's drawer: discounts listed above, the total already net of them.
  const discountTotal = discounts?.totalDiscount ?? 0;
  const estimatedTotal = Math.max(0, Math.round((cart.totalAmount - discountTotal) * 100) / 100);
  const [undo, setUndo] = useState<{ message: string; snapshot: CartStore } | null>(null);
  const undoTimer = useRef<number | null>(null);
  /** Removals are undoable for 10 seconds instead of silent. */
  const removeWithUndo = (message: string, remove: () => void) => {
    const snapshot = cartStore.get();
    remove();
    if (undoTimer.current !== null) window.clearTimeout(undoTimer.current);
    setUndo({ message, snapshot });
    undoTimer.current = window.setTimeout(() => setUndo(null), 10_000);
  };
  const undoRemoval = () => {
    if (undo) restoreCart(undo.snapshot);
    setUndo(null);
  };
  const autoCloseTimer = useRef<NodeJS.Timeout | null>(null);
  const cartTriggerRef = useRef<HTMLElement | null>(null);
  const isAutoCloseEnabled = useRef(false);
  const lastInteractionTime = useRef<number>(0);

  // Scroll & Swipe Logic
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollMore, setCanScrollMore] = useState(false);
  const dragStartY = useRef(0);
  const dragCurrentY = useRef(0);

  const clearAutoCloseTimer = useCallback(() => {
    if (autoCloseTimer.current) {
      clearTimeout(autoCloseTimer.current);
      autoCloseTimer.current = null;
    }
  }, []);

  const disableAutoClose = useCallback(() => {
    clearAutoCloseTimer();
    isAutoCloseEnabled.current = false;
  }, [clearAutoCloseTimer]);

  const handleMeaningfulInteraction = () => {
    const now = Date.now();
    if (now - lastInteractionTime.current > 1000) disableAutoClose();
    lastInteractionTime.current = now;
  };

  const startAutoCloseTimer = useCallback(() => {
    clearAutoCloseTimer();
    isAutoCloseEnabled.current = true;
    lastInteractionTime.current = Date.now();
    autoCloseTimer.current = setTimeout(() => {
      if (isAutoCloseEnabled.current) setCartOpen(false);
    }, 5000);
  }, [clearAutoCloseTimer]);

  // Mobile Swipe Down Logic
  const handleDragStart = (e: React.TouchEvent) => {
    dragStartY.current = e.touches[0].clientY;
  };

  const handleDragMove = (e: React.TouchEvent) => {
    dragCurrentY.current = e.touches[0].clientY;
  };

  const handleDragEnd = () => {
    const diff = dragCurrentY.current - dragStartY.current;
    if (diff > 50) {
      // If swiped down more than 50px
      setCartOpen(false);
    }
    dragStartY.current = 0;
    dragCurrentY.current = 0;
  };

  const checkScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const hasMoreBelow = scrollHeight - scrollTop - clientHeight > 10;
    setCanScrollMore(hasMoreBelow);
  }, []);

  useEffect(() => {
    if (isOpen) {
      setTimeout(checkScroll, 100);
      setTimeout(checkScroll, 500);
    }
  }, [isOpen, cart.items, checkScroll]);

  useEffect(() => {
    hydrateCartFromStorage();

    const handleAddToCartEvent = (event: CustomEvent<AddToCartEventDetail>) => {
      if (!event.detail) return;
      if (!addToCart(event.detail)) return;
      if (event.detail.redirectToCart) {
        window.location.href = "/cart";
      } else {
        const activeElement = document.activeElement;
        cartTriggerRef.current = activeElement instanceof HTMLElement
          ? activeElement
          : null;
        setCartOpen(true);
        startAutoCloseTimer();
      }
    };

    const handleOpenCartEvent = () => {
      disableAutoClose();
      const activeElement = document.activeElement;
      cartTriggerRef.current = activeElement instanceof HTMLElement
        ? activeElement
        : null;
      setCartOpen(true);
    };

    document.addEventListener(
      "add-to-cart",
      handleAddToCartEvent as EventListener,
    );
    document.addEventListener("open-cart", handleOpenCartEvent);
    window.addEventListener("resize", checkScroll);

    const pendingEvents = window.__scaliusCartPendingEvents?.splice(0) ?? [];
    for (const pendingEvent of pendingEvents) {
      if (pendingEvent.type === "add") {
        handleAddToCartEvent(
          new CustomEvent<AddToCartEventDetail>("add-to-cart", {
            detail: pendingEvent.detail,
          }),
        );
      } else {
        handleOpenCartEvent();
      }
    }
    onReady?.();

    return () => {
      document.removeEventListener(
        "add-to-cart",
        handleAddToCartEvent as EventListener,
      );
      document.removeEventListener("open-cart", handleOpenCartEvent);
      window.removeEventListener("resize", checkScroll);
      clearAutoCloseTimer();
    };
  }, [checkScroll, clearAutoCloseTimer, disableAutoClose, onReady, startAutoCloseTimer]);

  const handleCheckout = () => {
    window.location.href = "/cart";
    setCartOpen(false);
  };

  return (
    <Sheet
      open={isOpen}
      onOpenChange={(value) => {
        setCartOpen(value);
        if (!value) {
          clearAutoCloseTimer();
          isAutoCloseEnabled.current = false;
        }
      }}
    >
      <SheetContent
        side="right"
        role="dialog"
        aria-modal="true"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const trigger = cartTriggerRef.current;
          cartTriggerRef.current = null;
          window.requestAnimationFrame(() => {
            if (trigger?.isConnected) trigger.focus();
          });
        }}
        className={cn(
          "flex flex-col p-0 bg-card shadow-2xl gap-0 transition-transform duration-300 ease-out border-none focus:outline-none z-100",
          // Mobile: Bottom Half Sheet
          "fixed inset-x-0 bottom-0 h-auto max-h-[55dvh] top-auto rounded-t-[20px] border-t-0",
          // Desktop: Side Sheet
          "sm:fixed sm:inset-y-0 sm:right-0 sm:left-auto sm:h-full sm:max-h-none sm:w-full sm:max-w-[380px] sm:rounded-none sm:border-l",
        )}
        onMouseEnter={handleMeaningfulInteraction}
        onTouchStart={handleMeaningfulInteraction}
      >
        <SheetDescription className="sr-only">
          Review cart items, change quantities, or continue to checkout.
        </SheetDescription>
        {/*
          SWIPE ZONE (Mobile Only)
          Visible drag handle with animation to suggest pulling down
        */}
        <div
          className="w-full flex flex-col items-center justify-center pt-2 pb-0 sm:hidden cursor-grab active:cursor-grabbing touch-none z-30 bg-card rounded-t-[20px]"
          onTouchStart={handleDragStart}
          onTouchMove={handleDragMove}
          onTouchEnd={handleDragEnd}
        >
          <div className="w-8 h-1 rounded-full bg-muted-foreground/30" />
          <ChevronDown className="w-3 h-3 text-muted-foreground animate-bounce mt-0.5 opacity-60" />
        </div>

        {/* 1. HEADER */}
        <div
          className={cn(
            "flex items-center justify-between px-4 pb-2 pt-0 sm:pt-4 sm:px-5 sm:pb-4 border-b border-border bg-card shrink-0 z-20 h-auto shadow-[0_1px_2px_rgba(0,0,0,0.03)]",
          )}
          onTouchStart={handleDragStart}
          onTouchMove={handleDragMove}
          onTouchEnd={handleDragEnd}
        >
          <div className="flex items-center gap-2">
            <SheetTitle className="text-[15px] sm:text-lg font-bold text-foreground tracking-tight flex items-center gap-2">
              Cart
              <span className="bg-primary text-primary-foreground text-[10px] sm:text-xs font-bold px-1.5 py-0.5 rounded-full leading-none min-w-[18px] text-center">
                {cart.totalItems}
              </span>
            </SheetTitle>
          </div>

          <SheetClose
            aria-label="Close cart"
            className="group -mr-2 flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground transition-all hover:bg-muted hover:text-foreground active:scale-90 focus:outline-none sm:-mr-2 sm:h-9 sm:w-9 cursor-pointer"
          >
            <X className="h-4 w-4 sm:h-5 sm:w-5 transition-transform duration-300 group-hover:rotate-90" />
          </SheetClose>
        </div>

        {/* 2. CONTENT */}
        <div className="flex-1 relative overflow-hidden flex flex-col bg-muted/50">
          <div
            ref={scrollRef}
            onScroll={checkScroll}
            className="flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-3 py-2 sm:px-5 sm:py-4"
          >
            {cart.totalItems === 0 ? (
              <div className="flex flex-col items-center justify-center h-full py-8 sm:py-12 text-center space-y-3">
                <div className="h-12 w-12 sm:h-16 sm:w-16 bg-card rounded-full flex items-center justify-center border border-border shadow-sm">
                  <ShoppingBag className="h-5 w-5 sm:h-6 sm:w-6 text-muted-foreground" />
                </div>
                <div className="space-y-0.5">
                  <h3 className="text-sm font-bold text-foreground">
                    Cart is empty
                  </h3>
                </div>
                <Button
                  onClick={() => setCartOpen(false)}
                  variant="default"
                  size="sm"
                  className="mt-1 h-11 rounded-full bg-primary px-5 text-xs font-bold text-primary-foreground hover:bg-primary/90 sm:h-9 cursor-pointer"
                >
                  Start shopping
                </Button>
              </div>
            ) : (
              // Mobile: gap-2 (tighter), Desktop: gap-3
              <div className="space-y-2 sm:space-y-3 pb-4">
                {Object.entries(cart.items).map(([key, item]) => (
                  <div
                    key={key}
                    className="group relative flex gap-2.5 sm:gap-3 bg-card p-2 sm:p-2.5 rounded-xl border border-border shadow-sm"
                  >
                    {/* Compact Image */}
                    <div className="h-12 w-12 sm:h-18 sm:w-18 shrink-0 overflow-hidden rounded-lg border border-border bg-muted">
                      <img
                        src={getProductImageUrl(item.image, 96)}
                        alt={item.name}
                        className="h-full w-full object-contain object-center transition-transform duration-500 group-hover:scale-105"
                        loading="lazy"
                      />
                    </div>

                    <div className="flex flex-1 flex-col min-w-0 justify-between py-0">
                      <div className="flex justify-between items-start gap-1.5">
                        <div className="space-y-0.5 min-w-0 flex-1">
                          <h3 className="line-clamp-2 pr-1 text-[12px] font-bold leading-tight text-foreground sm:text-[13.5px]">
                            <a
                              href={`/products/${item.slug || item.id}`}
                              className="hover:text-muted-foreground transition-colors"
                            >
                              {item.name}
                            </a>
                          </h3>

                          {item.options && item.options.length > 0 && (
                            <div className="text-xs text-muted-foreground">
                              {item.options.map((option) => (
                                <span key={`${option.name}:${option.label}`} className="block">
                                  {option.name}: {option.label}
                                </span>
                              ))}
                            </div>
                          )}
                          {issues[key] && (
                            <div className="space-y-1" role="alert">
                              <p className="text-xs font-medium text-destructive">{issues[key].message}</p>
                              {issues[key].action === "reduce_quantity" && (issues[key].availableQuantity ?? 0) >= 1 ? (
                                <button
                                  type="button"
                                  className="min-h-9 rounded-md border border-border px-2 text-xs font-medium text-foreground hover:bg-muted cursor-pointer"
                                  onClick={() => {
                                    disableAutoClose();
                                    updateCartItemByKey(key, { quantity: Math.floor(issues[key]!.availableQuantity!) });
                                  }}
                                >
                                  Update quantity to {Math.floor(issues[key].availableQuantity!)}
                                </button>
                              ) : issues[key].action === "remove" || issues[key].action === "reduce_quantity" ? (
                                <button
                                  type="button"
                                  className="min-h-9 rounded-md border border-border px-2 text-xs font-medium text-foreground hover:bg-muted cursor-pointer"
                                  onClick={() => {
                                    disableAutoClose();
                                    removeWithUndo(`${item.name} removed`, () => removeCartItemByKey(key));
                                  }}
                                >
                                  Remove
                                </button>
                              ) : null}
                            </div>
                          )}
                        </div>

                        {/* Price */}
                        <div className="text-[12px] sm:text-sm font-bold text-foreground tabular-nums text-right shrink-0">
                          {formatMoney(item.price * item.quantity)}
                        </div>
                      </div>

                      {/* Controls Row */}
                      <div className="flex items-end justify-between mt-1">
                        <div className="flex h-11 items-center overflow-hidden rounded-md bg-muted/50 ring-1 ring-inset ring-input sm:h-8">
                          <button
                            aria-label={`Decrease ${item.name} quantity`}
                            onClick={() => {
                              disableAutoClose();
                              const newQ = Math.max(0, item.quantity - 1);
                              if (newQ === 0)
                                removeWithUndo(`${item.name} removed`, () => removeCartItemByKey(key));
                              else
                                updateCartItemByKey(key, { quantity: newQ });
                            }}
                            className="flex h-full w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-background hover:text-foreground active:bg-muted sm:w-8 cursor-pointer"
                          >
                            <Minus className="h-3 w-3" />
                          </button>
                          <span className="flex h-full w-7 items-center justify-center text-center text-xs font-bold leading-none text-foreground tabular-nums sm:w-6">
                            {item.quantity}
                          </span>
                          <button
                            aria-label={`Increase ${item.name} quantity`}
                            onClick={() => {
                              disableAutoClose();
                              updateCartItemByKey(key, {
                                quantity: item.quantity + 1,
                              });
                            }}
                            className="flex h-full w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-background hover:text-foreground active:bg-muted sm:w-8 cursor-pointer"
                          >
                            <Plus className="h-3 w-3" />
                          </button>
                        </div>

                        <button
                          aria-label={`Remove ${item.name} from cart`}
                          onClick={() => {
                            disableAutoClose();
                            removeWithUndo(`${item.name} removed`, () => removeCartItemByKey(key));
                          }}
                          className="flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive active:scale-90 sm:h-8 sm:w-8 cursor-pointer"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
                {recommendations && (
                  <section aria-labelledby="cart-recommendations-title" className="pt-2">
                    <h3 id="cart-recommendations-title" className="mb-2 text-xs font-bold text-foreground sm:text-sm">
                      {recommendationTitle(recommendations.reason)}
                    </h3>
                    <ul className="flex gap-2 overflow-x-auto pb-1">
                      {recommendations.products.map((product) => (
                        <li key={product.id} className="w-28 shrink-0">
                          <a
                            href={`/products/${encodeURIComponent(product.slug)}`}
                            onClick={disableAutoClose}
                            className="flex h-full flex-col rounded-lg border border-border bg-card p-1.5 transition-colors hover:border-foreground/30"
                          >
                            <img
                              src={getProductImageUrl(product.imageUrl, 160)}
                              alt={product.imageAlt || product.name}
                              width={100}
                              height={100}
                              loading="lazy"
                              className="aspect-square w-full rounded-md bg-muted object-cover"
                            />
                            <span className="mt-1 line-clamp-2 text-xs font-medium leading-tight text-foreground">
                              {product.name}
                            </span>
                            <span className="mt-auto pt-0.5 text-xs font-semibold tabular-nums text-foreground">
                              {product.priceVaries ? "From " : ""}
                              {formatMoney(product.discountedPrice)}
                            </span>
                          </a>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
              </div>
            )}
          </div>

          {/* More Below Indicator */}
          <div
            className={cn(
              "absolute bottom-0 left-0 right-0 h-10 bg-linear-to-t from-muted/80 to-transparent pointer-events-none transition-opacity duration-300 flex items-end justify-center pb-1",
              canScrollMore ? "opacity-100" : "opacity-0",
            )}
          >
            <div className="bg-card/90 backdrop-blur text-muted-foreground text-[9px] border border-border font-bold px-2 py-0.5 rounded-full shadow-sm flex items-center gap-1 animate-bounce">
              More <ChevronDown className="h-2.5 w-2.5" />
            </div>
          </div>
        </div>

        {undo && (
          <p className="shrink-0 border-t border-border bg-card px-4 py-2 text-sm text-muted-foreground" role="status">
            {undo.message} ·{" "}
            <button type="button" onClick={undoRemoval} className="font-medium text-foreground underline underline-offset-2 cursor-pointer">
              Undo
            </button>
          </p>
        )}

        {/* Savings and offers the cart already qualifies for */}
        {cart.totalItems > 0 && discounts && (discounts.discounts.length > 0 || discounts.offers.length > 0) && (
          <div className="shrink-0 space-y-1 border-t border-border bg-card px-4 py-2 text-sm">
            {discounts.discounts.filter((line) => line.amount > 0).map((line) => (
              <div key={line.promotionId} className="flex justify-between gap-3 text-primary">
                <span className="min-w-0">{formatDiscountLineLabel("Discount", line)}</span>
                <span className="shrink-0 tabular-nums">-{formatMoney(line.amount)}</span>
              </div>
            ))}
            {discounts.offers.map((offer) => (
              <div key={offer.promotionId} className="flex items-center justify-between gap-2 text-foreground">
                <span className="min-w-0">
                  <span className="font-medium">{offer.title}:</span>{" "}
                  {offer.products.map(({ name }) => name).join(" / ")} {offer.percentOff >= 100 ? "free" : `${offer.percentOff}% off`}
                </span>
                {offer.products[0]?.variantId && offer.products[0].price !== null ? (
                  <button
                    type="button"
                    className="shrink-0 rounded-md border border-border px-2 py-1 text-sm font-medium hover:bg-muted cursor-pointer"
                    onClick={() => {
                      const product = offer.products[0]!;
                      disableAutoClose();
                      addToCart({
                        id: product.id,
                        slug: product.slug,
                        name: product.name,
                        price: product.price!,
                        variantId: product.variantId!,
                        quantity: Math.max(1, offer.quantity),
                      });
                    }}
                  >
                    Add
                  </button>
                ) : offer.products[0] ? (
                  <a href={`/products/${encodeURIComponent(offer.products[0].slug)}`} className="shrink-0 text-sm font-medium underline underline-offset-2">
                    View
                  </a>
                ) : null}
              </div>
            ))}
          </div>
        )}

        {/* 3. FOOTER */}
        {cart.totalItems > 0 && (
          <div className="border-t border-border bg-card p-2 sm:p-5 shrink-0 z-30 shadow-[0_-4px_20px_-4px_rgba(0,0,0,0.05)] safe-area-pb">
            {/* Desktop Footer */}
            <div className="hidden sm:block space-y-4">
              <div className="flex justify-between items-end">
                <div className="text-sm text-muted-foreground">
                  {discountTotal > 0 ? "Estimated total (excl. shipping)" : "Subtotal (excl. shipping)"}
                </div>
                <div className="text-xl font-semibold text-foreground tabular-nums">
                  {formatMoney(estimatedTotal)}
                </div>
              </div>
              {checkoutBlocked && (
                <p className="text-sm text-destructive" role="status">Fix the highlighted items to check out.</p>
              )}
              <Button
                disabled={checkoutBlocked}
                onClick={() => {
                  disableAutoClose();
                  handleCheckout();
                }}
                className="w-full h-11 rounded-xl text-[14px] font-bold bg-primary hover:bg-primary/90 text-primary-foreground shadow-md transition-all flex items-center justify-center gap-2 cursor-pointer"
              >
                <span>Checkout</span>
                <ArrowRight className="h-4 w-4" />
              </Button>
              <div className="flex justify-between items-center px-1">
                <button
                  onClick={() => setCartOpen(false)}
                  className="min-h-9 text-sm text-muted-foreground hover:text-foreground underline decoration-border underline-offset-2 cursor-pointer"
                >
                  Continue shopping
                </button>
                <button
                  onClick={() => {
                    disableAutoClose();
                    removeWithUndo("Cart cleared", clearCart);
                  }}
                  className="min-h-9 text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                >
                  Clear cart
                </button>
              </div>
            </div>

            {/* Mobile Footer */}
            {checkoutBlocked && (
              <p id="drawerCheckoutBlocked" className="px-1 pb-1 text-xs text-destructive sm:hidden" role="status">Fix the highlighted items to check out.</p>
            )}
            <div className="flex sm:hidden items-center gap-3 px-1 pb-1">
              {/* Left: Total */}
              <div className="flex min-w-0 items-center gap-1">
                <div className="flex flex-col justify-center">
                  <span className="text-xs text-muted-foreground">
                    {discountTotal > 0 ? "Estimated total" : "Subtotal"}
                  </span>
                  <div className="text-lg font-semibold leading-none text-foreground tabular-nums">
                    {formatMoney(estimatedTotal)}
                  </div>
                </div>
                <button
                  aria-label="Clear cart"
                  onClick={() => {
                    disableAutoClose();
                    removeWithUndo("Cart cleared", clearCart);
                  }}
                  className="flex min-h-11 items-center rounded-md px-2 text-sm text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground cursor-pointer"
                >
                  Clear
                </button>
              </div>

              {/* Right: Action */}
              <Button
                disabled={checkoutBlocked}
                aria-describedby={checkoutBlocked ? "drawerCheckoutBlocked" : undefined}
                onClick={() => {
                  disableAutoClose();
                  handleCheckout();
                }}
                className="ml-auto flex h-11 flex-1 items-center justify-center gap-2 rounded-full bg-primary text-[12px] font-bold text-primary-foreground shadow-sm active:scale-[0.97] cursor-pointer"
              >
                <span>Checkout</span>
                <ArrowRight className="h-3 w-3" />
              </Button>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
