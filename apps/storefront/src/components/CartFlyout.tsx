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
  cartLineKeyFor,
  restoreCart,
  cartLinePropertyInputs,
  type CartStore,
} from "@/store/cart";
import { cartLineEditHref, cartLinePropertyText } from "@/lib/cart/line-properties-view";
import { writeCartLineEdit } from "@/lib/cart/line-edit";
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
  Check,
  ChevronDown,
} from "lucide-react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@scalius/shared/utils";
import { formatMoney } from "@/lib/currency";
import { PRODUCT_IMAGE_FALLBACK, productImageSources, resolveProductImageUrl } from "@/lib/product-media";
import type { ImageSlot } from "@/lib/responsive-image";
import { previewCartDiscounts } from "@/lib/cart/browser-api";
import { discountLineKey, type CheckoutDiscountFacts } from "@/lib/checkout/tax-quote-contract";
import type { CartRuleError, CartValidationIssue } from "@/lib/api/orders";
import { parseCartRuleErrors } from "@/lib/checkout/tax-quote-error-contract";
import { groupCartRuleErrors } from "@/lib/cart/rule-errors";
import { cartItemVariantLabel } from "@/lib/cart/item-options";
import type { ProductRecommendations } from "@/lib/api/types";
import {
  fetchRecommendationsFromBrowser,
  recommendationQuery,
  recommendationTitle,
} from "@/lib/recommendations";
import { formatDiscountLineLabel } from "@scalius/shared/checkout-language-format";
import { currentPresence, pagePath } from "@/lib/presence-url";

export const cartOpenState = atom<boolean>(false);

const CART_RECOMMENDATION_LIMIT = 4;
/** Line photo: h-12 w-12, sm:h-18 sm:w-18. */
const CART_LINE_IMAGE: ImageSlot = { width: 160, sizes: "(min-width: 640px) 72px, 48px", maxWidth: 320 };
/** Suggestion photo: a w-28 card minus p-1.5 and its border. */
const CART_RECOMMENDATION_IMAGE: ImageSlot = { width: 160, sizes: "98px", maxWidth: 320 };

function productImageProps(
  url: string | null | undefined,
  slot: ImageSlot,
): { src: string; srcSet?: string; sizes?: string } {
  const { src, srcset, sizes } = productImageSources(url, slot);
  return { src, srcSet: srcset, sizes };
}

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

/**
 * Detail of the document `open-cart` event. `addedLineKey` is the cart line
 * an add just created or grew: the drawer then confirms it ("Added to your
 * cart") and lists it first. A plain `open-cart` (the header cart icon) shows
 * the cart as it is.
 */
export type OpenCartEventDetail = { addedLineKey?: string };

/** Where "Checkout" lands: the cart page is also the checkout form. */
const CHECKOUT_FORM_ID = "checkoutFormCard";

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
  /** Store app rules that block checkout, in the app's own words. */
  const [ruleErrors, setRuleErrors] = useState<CartRuleError[]>([]);
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
            ...(item.properties?.length ? { properties: cartLinePropertyInputs(item) } : {}),
          })),
          // The page's market prices the cart (MARKETS-DESIGN D5).
          ...(currentPresence() ? { presence: currentPresence() } : {}),
        }),
      })
        .then((response) => response.json())
        .then((json: { data?: { issues?: CartValidationIssue[]; ruleErrors?: unknown }; details?: { itemIssues?: CartValidationIssue[] } }) => {
          if (!current) return;
          const found = json?.data?.issues ?? json?.details?.itemIssues ?? [];
          setIssues(Object.fromEntries(found.flatMap((issue) => issue.cartKey ? [[issue.cartKey, issue]] : [])));
          setRuleErrors(parseCartRuleErrors(json?.data?.ruleErrors));
        })
        .catch(() => undefined);
    }, 300);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [cart.items, cart.discountCodes, isOpen]);
  return { discounts: Object.keys(cart.items).length > 0 ? discounts : null, issues, ruleErrors };
}

/**
 * True shortly after `active` turns on (or `key` changes while on). A live
 * region only speaks text that arrives after it is in the page, and the
 * drawer mounts its content together with the region.
 */
function useDelayedFlag(active: boolean, key: string | null): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    setOn(false);
    if (!active) return;
    const timer = window.setTimeout(() => setOn(true), 150);
    return () => window.clearTimeout(timer);
  }, [active, key]);
  return on;
}

/**
 * A line photo. It loads at once (the drawer shows it straight away; lazy
 * loading inside a sliding sheet can leave it empty) and falls back to the
 * stored full image, then the placeholder, when a rendition fails to load.
 */
function CartLineImage({ url, alt }: { url: string | undefined; alt: string }) {
  const [stage, setStage] = useState<"rendition" | "original" | "placeholder">("rendition");
  useEffect(() => setStage("rendition"), [url]);
  const sources =
    stage === "rendition"
      ? productImageProps(url, CART_LINE_IMAGE)
      : { src: stage === "original" ? resolveProductImageUrl(url) : PRODUCT_IMAGE_FALLBACK };
  return (
    <img
      {...sources}
      alt={alt}
      width={72}
      height={72}
      decoding="async"
      onError={() => {
        setStage((current) =>
          current === "rendition" && resolveProductImageUrl(url) !== sources.src ? "original" : "placeholder");
      }}
      className="h-full w-full object-contain object-center"
    />
  );
}

export default function CartFlyout({ onReady }: Props) {
  const cart = useStore(cartStore);
  const isOpen = useStore(cartOpenState);
  const { discounts, issues, ruleErrors } = useDrawerCartFacts(cart, isOpen);
  const recommendations = useCartRecommendations(cart, isOpen);
  // A line that can't be bought as is blocks Checkout here, like on the cart page,
  // and so does a store app's rule (on its line, or about the whole cart).
  const lineIssues = Object.entries(issues).filter(([key]) => cart.items[key]);
  const rules = groupCartRuleErrors(ruleErrors, cart.items);
  const cartRuleMessages = rules.cart.map(({ message }) => message).filter(Boolean);
  const checkoutBlocked =
    lineIssues.length > 0 || Object.keys(rules.lines).length > 0 || rules.cart.length > 0;
  const blockedText = cartRuleMessages.length > 0 && lineIssues.length === 0 && Object.keys(rules.lines).length === 0
    ? cartRuleMessages.join(" ")
    : "Fix the highlighted items to check out.";
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
  const cartTriggerRef = useRef<HTMLElement | null>(null);
  /** The line an add just touched; null for a plain open. */
  const [addedKey, setAddedKey] = useState<string | null>(null);
  const addedItem = addedKey ? cart.items[addedKey] : undefined;
  const announced = useDelayedFlag(isOpen && Boolean(addedItem), addedKey);

  // Scroll & Swipe Logic
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollMore, setCanScrollMore] = useState(false);
  const dragStartY = useRef(0);
  const dragCurrentY = useRef(0);

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

    /** Remembers what to refocus on close; a re-add while open keeps the first. */
    const rememberTrigger = () => {
      if (cartOpenState.get()) return;
      const activeElement = document.activeElement;
      cartTriggerRef.current = activeElement instanceof HTMLElement && activeElement !== document.body
        ? activeElement
        : null;
    };

    const openCart = (addedLineKey?: string) => {
      rememberTrigger();
      setAddedKey(addedLineKey ?? null);
      setCartOpen(true);
    };

    const handleAddToCartEvent = async (event: CustomEvent<AddToCartEventDetail>) => {
      if (!event.detail) return;
      if (!(await addToCart(event.detail))) return;
      if (event.detail.redirectToCart) {
        window.location.href = pagePath("/cart");
      } else {
        const { id, variantId, properties } = event.detail;
        openCart(variantId ? await cartLineKeyFor({ id, variantId, properties }).catch(() => undefined) : undefined);
      }
    };

    const handleOpenCartEvent = (event?: Event) => {
      openCart((event as CustomEvent<OpenCartEventDetail | undefined> | undefined)?.detail?.addedLineKey);
    };

    const onAddToCart: EventListener = (event) =>
      void handleAddToCartEvent(event as CustomEvent<AddToCartEventDetail>);
    document.addEventListener("add-to-cart", onAddToCart);
    document.addEventListener("open-cart", handleOpenCartEvent);
    window.addEventListener("resize", checkScroll);

    const pendingEvents = window.__scaliusCartPendingEvents?.splice(0) ?? [];
    for (const pendingEvent of pendingEvents) {
      if (pendingEvent.type === "add") {
        void handleAddToCartEvent(
          new CustomEvent<AddToCartEventDetail>("add-to-cart", {
            detail: pendingEvent.detail,
          }),
        );
      } else {
        openCart(pendingEvent.detail?.addedLineKey);
      }
    }
    onReady?.();

    return () => {
      document.removeEventListener("add-to-cart", onAddToCart);
      document.removeEventListener("open-cart", handleOpenCartEvent);
      window.removeEventListener("resize", checkScroll);
    };
  }, [checkScroll, onReady]);

  const checkoutHref = `${pagePath("/cart")}#${CHECKOUT_FORM_ID}`;
  const cartHref = pagePath("/cart");
  /** The line an add just touched comes first, as Shopify's cart notification shows it. */
  const lineEntries = Object.entries(cart.items).sort(([a], [b]) =>
    Number(b === addedKey) - Number(a === addedKey));

  return (
    <Sheet
      open={isOpen}
      onOpenChange={setCartOpen}
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
          "sm:fixed sm:inset-y-0 sm:inset-e-0 sm:inset-s-auto sm:h-full sm:max-h-none sm:w-full sm:max-w-[380px] sm:rounded-none sm:border-s",
        )}
      >
        <SheetDescription className="sr-only">
          {addedItem
            ? `${addedItem.name} was added to your cart. View your cart, check out, or continue shopping.`
            : "Review cart items, change quantities, or continue to checkout."}
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
            className="group -me-2 flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground transition-all hover:bg-muted hover:text-foreground active:scale-90 focus:outline-none sm:-me-2 sm:h-9 sm:w-9 cursor-pointer"
          >
            <X className="h-4 w-4 sm:h-5 sm:w-5 transition-transform duration-300 group-hover:rotate-90" />
          </SheetClose>
        </div>

        {/* Confirmation of an add, like Shopify's cart notification. A fixed strip in the sheet, never in the page. */}
        {addedItem && (
          <div className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-4 py-2 text-sm font-medium text-foreground sm:px-5" data-cart-added>
            <span aria-hidden="true" className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
              <Check className="h-3 w-3" strokeWidth={3} />
            </span>
            <span aria-hidden="true">Added to your cart</span>
            <p role="status" className="sr-only">
              {announced ? `${addedItem.name} added to your cart. Cart has ${cart.totalItems} ${cart.totalItems === 1 ? "item" : "items"}.` : ""}
            </p>
          </div>
        )}

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
                {lineEntries.map(([key, item]) => (
                  <div
                    key={key}
                    aria-current={key === addedKey ? "true" : undefined}
                    className={cn(
                      "group relative flex gap-2.5 sm:gap-3 bg-card p-2 sm:p-2.5 rounded-xl border border-border shadow-sm",
                      key === addedKey && "border-primary ring-1 ring-primary",
                    )}
                  >
                    {/* Compact Image */}
                    <div className="h-12 w-12 sm:h-18 sm:w-18 shrink-0 overflow-hidden rounded-lg border border-border bg-muted">
                      <CartLineImage url={item.image} alt={item.name} />
                    </div>

                    <div className="flex flex-1 flex-col min-w-0 justify-between py-0">
                      <div className="flex justify-between items-start gap-1.5">
                        <div className="space-y-0.5 min-w-0 flex-1">
                          <h3 className="line-clamp-2 pe-1 text-[12px] font-bold leading-tight text-foreground sm:text-[13.5px]">
                            <a
                              href={pagePath(`/products/${item.slug || item.id}`)}
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
                          {item.properties && item.properties.length > 0 && (
                            <div className="text-xs text-muted-foreground">
                              <ul>
                                {item.properties.map((property) => (
                                  <li key={property.key} className="break-words">
                                    {cartLinePropertyText(property, "+{price}")}
                                  </li>
                                ))}
                              </ul>
                              {cartLineEditHref(item) && (
                                <a
                                  href={cartLineEditHref(item)!}
                                  className="inline-flex min-h-9 items-center font-medium text-foreground underline underline-offset-2"
                                  aria-label={`Edit ${item.name}`}
                                  onClick={() => {
                                    // Session storage, not the URL: the inputs are buyer content.
                                    writeCartLineEdit({
                                      lineKey: key,
                                      productId: item.id,
                                      variantId: item.variantId,
                                      quantity: item.quantity,
                                      properties: cartLinePropertyInputs(item),
                                    });
                                  }}
                                >
                                  Edit
                                </a>
                              )}
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
                                    removeWithUndo(`${item.name} removed`, () => removeCartItemByKey(key));
                                  }}
                                >
                                  Remove
                                </button>
                              ) : null}
                            </div>
                          )}
                          {(rules.lines[key] ?? []).map((rule, position) => (
                            <p key={`${rule.code}:${position}`} className="text-xs font-medium text-destructive" role="alert">
                              {rule.message}
                            </p>
                          ))}
                        </div>

                        {/* Price */}
                        <div className="text-[12px] sm:text-sm font-bold text-foreground tabular-nums text-end shrink-0">
                          {formatMoney(item.price * item.quantity)}
                        </div>
                      </div>

                      {/* Controls Row */}
                      <div className="flex items-end justify-between mt-1">
                        <div className="flex h-11 items-center overflow-hidden rounded-md bg-muted/50 ring-1 ring-inset ring-input sm:h-8">
                          <button
                            aria-label={`Decrease ${item.name} quantity`}
                            onClick={() => {
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
                    {/* Padding inside the scroller gives the focus outline room: overflow clips it. */}
                    <ul data-h-rail className="-mx-1 flex gap-2 overflow-x-auto px-1 py-1">
                      {recommendations.products.map((product) => (
                        <li key={product.id} className="w-28 shrink-0">
                          <a
                            href={pagePath(`/products/${encodeURIComponent(product.slug)}`)}
                            className="flex h-full flex-col rounded-lg border border-border bg-card p-1.5 transition-colors hover:border-foreground/30"
                          >
                            <img
                              {...productImageProps(product.imageUrl, CART_RECOMMENDATION_IMAGE)}
                              alt={product.imageAlt || product.name}
                              width={100}
                              height={100}
                              loading="lazy"
                              decoding="async"
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

          {/* More below: a soft fade only, so nothing covers a price or a button. */}
          <div
            aria-hidden="true"
            className={cn(
              "absolute bottom-0 inset-s-0 inset-e-0 h-6 bg-linear-to-t from-card to-transparent pointer-events-none transition-opacity duration-300",
              canScrollMore ? "opacity-100" : "opacity-0",
            )}
          />
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
            {discounts.discounts.map((line, position) => ({ line, key: discountLineKey(line, position) })).filter(({ line }) => line.amount > 0).map(({ line, key }) => (
              <div key={key} className="flex justify-between gap-3 text-primary">
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
                      void addToCart({
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
                  <a href={pagePath(`/products/${encodeURIComponent(offer.products[0].slug)}`)} className="shrink-0 text-sm font-medium underline underline-offset-2">
                    View
                  </a>
                ) : null}
              </div>
            ))}
          </div>
        )}

        {/* 3. FOOTER */}
        {cart.totalItems > 0 && (
          <div className="border-t border-border bg-card p-3 sm:p-5 shrink-0 z-30 shadow-[0_-4px_20px_-4px_rgba(0,0,0,0.05)] safe-area-pb">
            <div className="space-y-3 sm:space-y-4">
              <div className="flex items-end justify-between gap-3">
                <div className="text-sm text-muted-foreground">
                  {discountTotal > 0 ? "Estimated total (excl. shipping)" : "Subtotal (excl. shipping)"}
                </div>
                <div className="text-lg font-semibold text-foreground tabular-nums sm:text-xl">
                  {formatMoney(estimatedTotal)}
                </div>
              </div>
              {checkoutBlocked && (
                <p id="drawerCheckoutBlocked" className="text-xs text-destructive sm:text-sm" role="status">{blockedText}</p>
              )}
              <div className="flex flex-col gap-2 sm:gap-3">
                <Button asChild variant="outline" className="h-11 w-full rounded-xl text-[14px] font-bold cursor-pointer">
                  <a href={cartHref} onClick={() => setCartOpen(false)}>View cart</a>
                </Button>
                {checkoutBlocked ? (
                  <Button
                    disabled
                    aria-describedby="drawerCheckoutBlocked"
                    className="h-11 w-full rounded-xl text-[14px] font-bold bg-primary text-primary-foreground shadow-md flex items-center justify-center gap-2"
                  >
                    <span>Checkout</span>
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                ) : (
                  <Button asChild className="h-11 w-full rounded-xl text-[14px] font-bold bg-primary hover:bg-primary/90 text-primary-foreground shadow-md transition-all flex items-center justify-center gap-2 cursor-pointer">
                    <a href={checkoutHref} onClick={() => setCartOpen(false)}>
                      <span>Checkout</span>
                      <ArrowRight className="h-4 w-4" />
                    </a>
                  </Button>
                )}
              </div>
              <div className="flex items-center justify-between px-1">
                <button
                  type="button"
                  onClick={() => setCartOpen(false)}
                  className="min-h-11 text-sm text-muted-foreground hover:text-foreground underline decoration-border underline-offset-2 cursor-pointer sm:min-h-9"
                >
                  Continue shopping
                </button>
                <button
                  type="button"
                  onClick={() => removeWithUndo("Cart cleared", clearCart)}
                  className="min-h-11 text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer sm:min-h-9"
                >
                  Clear cart
                </button>
              </div>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
