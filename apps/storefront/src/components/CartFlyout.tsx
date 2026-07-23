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
import { formatPriceShort } from "@/lib/currency";
import { getProductImageUrl } from "@/lib/product-media";

export const cartOpenState = atom<boolean>(false);

type AddToCartEventDetail = Parameters<typeof addToCart>[0] & {
  redirectToCart?: boolean;
};

export function setCartOpen(value: boolean) {
  if (typeof window !== "undefined") {
    try {
      cartOpenState.set(value);
    } catch (err: unknown) {
      console.error("Error setting cart open state:", err);
    }
  }
}

export default function CartFlyout() {
  const cart = useStore(cartStore);
  const isOpen = useStore(cartOpenState);
  const autoCloseTimer = useRef<NodeJS.Timeout | null>(null);
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
        setCartOpen(true);
        startAutoCloseTimer();
      }
    };

    const handleOpenCartEvent = () => {
      disableAutoClose();
      setCartOpen(true);
    };

    document.addEventListener(
      "add-to-cart",
      handleAddToCartEvent as EventListener,
    );
    document.addEventListener("open-cart", handleOpenCartEvent);
    window.addEventListener("resize", checkScroll);

    return () => {
      document.removeEventListener(
        "add-to-cart",
        handleAddToCartEvent as EventListener,
      );
      document.removeEventListener("open-cart", handleOpenCartEvent);
      window.removeEventListener("resize", checkScroll);
      clearAutoCloseTimer();
    };
  }, [checkScroll, clearAutoCloseTimer, disableAutoClose, startAutoCloseTimer]);

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
                        src={getProductImageUrl(
                          item.image,
                          {
                            width: 96,
                            height: 96,
                            quality: 75,
                            format: "auto",
                            fit: "contain",
                          },
                        )}
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
                            <div className="flex items-center text-[10px] sm:text-[11px] font-medium text-muted-foreground leading-none">
                              {item.options.map((option, index) => (
                                <span key={`${option.name}:${option.label}`} className="contents">
                                  {index > 0 && (
                                    <span className="mx-1.5 h-1 w-1 rounded-full bg-muted-foreground shrink-0" />
                                  )}
                                  <span className="truncate">
                                    {option.name}: {option.label}
                                  </span>
                                </span>
                              ))}
                            </div>
                          )}
                        </div>

                        {/* Price */}
                        <div className="text-[12px] sm:text-sm font-bold text-foreground tabular-nums text-right shrink-0">
                          {formatPriceShort(item.price * item.quantity)}
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
                                removeCartItemByKey(key);
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
                            removeCartItemByKey(key);
                          }}
                          className="flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive active:scale-90 sm:h-8 sm:w-8 cursor-pointer"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
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

        {/* 3. FOOTER */}
        {cart.totalItems > 0 && (
          <div className="border-t border-border bg-card p-2 sm:p-5 shrink-0 z-30 shadow-[0_-4px_20px_-4px_rgba(0,0,0,0.05)] safe-area-pb">
            {/* Desktop Footer */}
            <div className="hidden sm:block space-y-4">
              <div className="flex justify-between items-end">
                <div className="text-xs text-muted-foreground font-medium">
                  Subtotal (excl. shipping)
                </div>
                <div className="text-xl font-bold text-foreground tabular-nums tracking-tight">
                  {formatPriceShort(cart.totalAmount)}
                </div>
              </div>
              <Button
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
                  className="text-[11px] font-medium text-muted-foreground hover:text-foreground underline decoration-border underline-offset-2 cursor-pointer"
                >
                  Continue Shopping
                </button>
                <button
                  onClick={() => {
                    disableAutoClose();
                    clearCart();
                    setCartOpen(false);
                  }}
                  className="text-[11px] font-medium text-muted-foreground hover:text-destructive transition-colors cursor-pointer"
                >
                  Clear Cart
                </button>
              </div>
            </div>

            {/* Mobile Footer */}
            <div className="flex sm:hidden items-center gap-3 px-1 pb-1">
              {/* Left: Total */}
              <div className="flex min-w-0 items-center gap-1">
                <div className="flex flex-col justify-center">
                  <span className="text-[10px] font-bold uppercase text-muted-foreground">
                    Total
                  </span>
                  <div className="text-lg font-extrabold leading-none text-foreground tabular-nums">
                    {formatPriceShort(cart.totalAmount)}
                  </div>
                </div>
                <button
                  aria-label="Clear cart"
                  onClick={() => {
                    disableAutoClose();
                    clearCart();
                    setCartOpen(false);
                  }}
                  className="flex min-h-11 items-center rounded-md px-2 text-[11px] font-medium text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-destructive cursor-pointer"
                >
                  Clear
                </button>
              </div>

              {/* Right: Action */}
              <Button
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
