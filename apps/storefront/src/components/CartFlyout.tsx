// src/components/CartFlyout.tsx
import {
  Sheet,
  SheetContent,
  SheetClose,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  cartStore,
  updateQuantity,
  removeFromCart,
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
import React, { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { getCurrencySymbol } from "@/lib/currency";

export const cartOpenState = atom<boolean>(false);

export function setCartOpen(value: boolean) {
  if (typeof window !== "undefined") {
    try {
      cartOpenState.set(value);
    } catch (err) {
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

  const clearAutoCloseTimer = () => {
    if (autoCloseTimer.current) {
      clearTimeout(autoCloseTimer.current);
      autoCloseTimer.current = null;
    }
  };

  const disableAutoClose = () => {
    clearAutoCloseTimer();
    isAutoCloseEnabled.current = false;
  };

  const handleMeaningfulInteraction = () => {
    const now = Date.now();
    if (now - lastInteractionTime.current > 1000) disableAutoClose();
    lastInteractionTime.current = now;
  };

  const startAutoCloseTimer = () => {
    clearAutoCloseTimer();
    isAutoCloseEnabled.current = true;
    lastInteractionTime.current = Date.now();
    autoCloseTimer.current = setTimeout(() => {
      if (isAutoCloseEnabled.current) setCartOpen(false);
    }, 5000);
  };

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

  const checkScroll = () => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const hasMoreBelow = scrollHeight - scrollTop - clientHeight > 10;
    setCanScrollMore(hasMoreBelow);
  };

  useEffect(() => {
    if (isOpen) {
      setTimeout(checkScroll, 100);
      setTimeout(checkScroll, 500);
    }
  }, [isOpen, cart.items]);

  useEffect(() => {
    const handleAddToCartEvent = (event: CustomEvent) => {
      if (!event.detail) return;
      addToCart(event.detail);
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
  }, []);

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

          <SheetClose className="group p-1.5 -mr-1.5 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground transition-all active:scale-90 focus:outline-none cursor-pointer">
            <X className="h-4 w-4 sm:h-5 sm:w-5 transition-transform duration-300 group-hover:rotate-90" />
            <span className="sr-only">Close</span>
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
                  className="h-7 px-4 text-[10px] sm:text-xs font-bold rounded-full mt-1 bg-primary text-primary-foreground hover:bg-primary/90 cursor-pointer"
                >
                  Start Shopping
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
                        src={item.image || "/placeholder.jpg"}
                        alt={item.name}
                        className="h-full w-full object-cover object-center transition-transform duration-500 group-hover:scale-105"
                        loading="lazy"
                      />
                    </div>

                    <div className="flex flex-1 flex-col min-w-0 justify-between py-0">
                      <div className="flex justify-between items-start gap-1.5">
                        <div className="space-y-0.5 min-w-0 flex-1">
                          <h3 className="text-[12px] sm:text-[13.5px] font-bold text-foreground leading-tight truncate pr-1">
                            <a
                              href={`/products/${item.slug || item.id}`}
                              className="hover:text-muted-foreground transition-colors"
                            >
                              {item.name}
                            </a>
                          </h3>

                          {/* Separator Based Variants - UPDATED: Dots are now darker (bg-gray-400) */}
                          {(item.size || item.color) && (
                            <div className="flex items-center text-[10px] sm:text-[11px] font-medium text-muted-foreground leading-none">
                              {item.size && <span>{item.size}</span>}
                              {item.size && item.color && (
                                <span className="mx-1.5 h-1 w-1 rounded-full bg-muted-foreground shrink-0" />
                              )}
                              {item.color && <span>{item.color}</span>}
                            </div>
                          )}
                        </div>

                        {/* Price */}
                        <div className="text-[12px] sm:text-sm font-bold text-foreground tabular-nums text-right shrink-0">
                          {getCurrencySymbol()}{(item.price * item.quantity).toLocaleString()}
                        </div>
                      </div>

                      {/* Controls Row - Tighter on mobile */}
                      <div className="flex items-end justify-between mt-1">
                        <div className="flex items-center border border-input rounded-md bg-muted/50 h-6 sm:h-7 overflow-hidden">
                          <button
                            onClick={() => {
                              disableAutoClose();
                              const newQ = Math.max(0, item.quantity - 1);
                              if (newQ === 0)
                                removeFromCart(item.id, item.variantId);
                              else
                                updateQuantity(item.id, item.variantId, newQ);
                            }}
                            className="w-6 sm:w-8 h-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-background transition-colors active:bg-muted cursor-pointer"
                          >
                            <Minus className="h-2.5 w-2.5 sm:h-3 sm:w-3" />
                          </button>
                          <span className="w-5 sm:w-6 text-center text-[11px] sm:text-[12px] font-bold text-foreground tabular-nums h-full flex items-center justify-center leading-none">
                            {item.quantity}
                          </span>
                          <button
                            onClick={() => {
                              disableAutoClose();
                              updateQuantity(
                                item.id,
                                item.variantId,
                                item.quantity + 1,
                              );
                            }}
                            className="w-6 sm:w-8 h-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-background transition-colors active:bg-muted cursor-pointer"
                          >
                            <Plus className="h-2.5 w-2.5 sm:h-3 sm:w-3" />
                          </button>
                        </div>

                        <button
                          onClick={() => {
                            disableAutoClose();
                            removeFromCart(item.id, item.variantId);
                          }}
                          className="text-muted-foreground hover:text-destructive p-1 rounded-md hover:bg-destructive/10 transition-colors active:scale-90 cursor-pointer"
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
                  {getCurrencySymbol()}{cart.totalAmount.toLocaleString()}
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

            {/* Mobile Footer: Super Compact Bar */}
            <div className="flex sm:hidden items-center gap-3 px-1 pb-1">
              {/* Left: Total */}
              <div className="flex flex-col justify-center min-w-0">
                <div className="flex items-center gap-1.5 mb-0.5">
                  <span className="text-[9px] text-muted-foreground font-bold uppercase">
                    Total
                  </span>
                  <button
                    onClick={() => {
                      disableAutoClose();
                      clearCart();
                      setCartOpen(false);
                    }}
                    className="text-[9px] text-muted-foreground underline decoration-dotted hover:text-destructive cursor-pointer"
                  >
                    Clear
                  </button>
                </div>
                <div className="text-lg font-extrabold text-foreground tabular-nums leading-none">
                  {getCurrencySymbol()}{cart.totalAmount.toLocaleString()}
                </div>
              </div>

              {/* Right: Action */}
              <Button
                onClick={() => {
                  disableAutoClose();
                  handleCheckout();
                }}
                className="flex-1 h-9 rounded-full text-[12px] font-bold bg-primary text-primary-foreground shadow-sm active:scale-[0.97] flex items-center justify-center gap-2 ml-auto cursor-pointer"
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
