// src/components/CartFlyout.tsx
import * as Dialog from "@radix-ui/react-dialog";
import {
  cartStore,
  hydrateCartFromStorage,
  updateCartItemByKey,
  removeCartItemByKey,
  addToCart,
  cartLineKeyFor,
  restoreCart,
  cartLinePropertyInputs,
  type CartStore,
} from "@/store/cart";
import { writeCartLineEdit } from "@/lib/cart/line-edit";
import { purchaseOptionsField } from "@/lib/cart/purchase-option";
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
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { formatMoney, getCurrencyCode, getDecimalPlaces } from "@/lib/currency";
import { formatCount, pageLanguage, storeRegion } from "@/lib/store-time-zone";
import { cartDrawerCopy, type CartDrawerCopy } from "@/lib/cart-drawer-copy";
import { cartLineCopy } from "@/lib/cart-line-copy";
import { lineEntryWords } from "@scalius/shared/line-entry-words";
import { priceCopy as storefrontPriceCopy } from "@/lib/price-copy";
import { formatNumber, numberLocale } from "@scalius/shared/locale-format";
import { PRODUCT_IMAGE_FALLBACK, productImageSources, resolveProductImageUrl } from "@/lib/product-media";
import type { ImageSlot } from "@/lib/responsive-image";
import { previewCartDiscounts } from "@/lib/cart/browser-api";
import { discountLineKey, type CheckoutDiscountFacts } from "@/lib/checkout/quote-facts";
import type { CartRuleError, CartValidationIssue, CartValidationResult } from "@/lib/api/orders";
import { groupCartRuleErrors, parseCartRuleErrors } from "@/lib/cart/rule-errors";
import { isFollowedQuantityIssue, quantitiesByVariant } from "@/lib/cart/quantity-issues";
import { cartItemVariantLabel } from "@/lib/cart/item-options";
import type { ProductRecommendations } from "@/lib/api/types";
import {
  fetchRecommendationsFromBrowser,
  recommendationQuery,
  recommendationTitle,
} from "@/lib/recommendations";
import { formatDiscountLineLabel } from "@scalius/shared/checkout-language-format";
import { currentPresence, pagePath } from "@/lib/presence-url";
import { readBuyerAttributes } from "@/lib/buyer-ui/state";
import { browserBuyerUiLocaleHeaders } from "@/lib/buyer-ui/browser-locale";
import { renderBuyerUiWhenNeeded } from "@/lib/buyer-ui/lazy";
import { readCartDrawerLook } from "@/lib/cart/drawer-look";
import { cartLineInputFacts, NO_LINE_INPUTS, type CartLineInputFacts } from "@/lib/cart/line-inputs";
import { cartHasMixedFulfilment, cartLineView, type CartLineDiscount } from "@/lib/cart/line-view";

export const cartOpenState = atom<boolean>(false);

/*
 * The drawer's class lists are written out whole: it ships no runtime class
 * merger (tailwind-merge alone was 8.8 KiB gzip of the first add to cart), so
 * each list is what that merge would keep (CartFlyout.classes.test.tsx). The
 * merge does not see every overlap (`inset-y-0` and `top-auto` both set `top`),
 * so a list never repeats a property the stylesheet's order would then decide.
 */
const DRAWER_OVERLAY =
  "fixed inset-0 z-[var(--scalius-z-overlay,70)] bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0";
/** Mobile: a bottom sheet of most of the screen (Shopify: room for the lines). From `sm`: a side sheet, its width the theme's. */
const DRAWER_SHEET =
  "z-[var(--scalius-z-overlay,70)] w-full flex flex-col p-0 bg-card shadow-2xl gap-0 transition-transform duration-300 ease-out border-s border-none focus:outline-none"
  + " data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:duration-300 data-[state=open]:duration-500"
  + " fixed inset-x-0 bottom-0 h-[85dvh] max-h-[85dvh] top-auto rounded-t-[20px] border-t-0"
  + " sm:fixed sm:inset-y-0 sm:inset-e-0 sm:inset-s-auto sm:h-full sm:max-h-none sm:w-full sm:rounded-none sm:border-s";
/** The drawer's filled buttons (the storefront button's look, flat in the primary colour). */
const DRAWER_BUTTON =
  "whitespace-nowrap ring-offset-background transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
  + " disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 active:scale-[0.97] active:translate-y-[1px]"
  + " relative after:absolute after:inset-0 after:rounded-md after:pointer-events-none after:shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]"
  + " border border-primary/20 shadow-md hover:shadow-lg bg-primary font-bold text-primary-foreground";
const DRAWER_CHECKOUT = "flex items-center justify-center gap-2 h-12 w-full rounded-xl px-4 py-2 text-base";

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
export type OpenCartEventDetail = { addedLineKey?: string; addedCount?: number };

/** Where "Checkout" lands: the cart page is also the checkout form. */
const CHECKOUT_FORM_ID = "checkoutFormCard";

interface Props {
  onReady?: () => void;
}

/** No buyer UI blocks (one array, so an unchanged answer redraws nothing). */
const NO_BLOCKS: unknown[] = [];
const NO_LINE_DISCOUNTS = new Map<string, CartLineDiscount>();

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
 * server, per-line stock problems, so a buyer hears about them before
 * reaching checkout, and the store apps' blocks for the drawer's footer
 * (the same check answers them: no request of their own).
 */
function useDrawerCartFacts(cart: CartStore, isOpen: boolean) {
  const [discounts, setDiscounts] = useState<CheckoutDiscountFacts & { totalDiscount: number } | null>(null);
  /** Each line's share of those discounts, by cart key, for the quantity it was priced at (a free gift reads free). */
  const [lineDiscounts, setLineDiscounts] = useState<Map<string, CartLineDiscount>>(NO_LINE_DISCOUNTS);
  const [issues, setIssues] = useState<Record<string, CartValidationIssue>>({});
  /** Store app rules that block checkout, in the app's own words. */
  const [ruleErrors, setRuleErrors] = useState<CartRuleError[]>([]);
  /** The apps' buyer UI blocks, as the check answered them (parsed where they are drawn). */
  const [buyerUi, setBuyerUi] = useState<unknown[]>(NO_BLOCKS);
  /** The apps' line inputs each line takes (the check's), drawn by line-input-controls.ts. */
  const [lineInputs, setLineInputs] = useState<CartLineInputFacts>(NO_LINE_INPUTS);
  /** Bumped when a block changed what the check reads (an answer it set). */
  const [revision, setRevision] = useState(0);
  const recheck = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    const items = Object.entries(cart.items);
    if (!isOpen || items.length === 0) return;
    let current = true;
    const timer = window.setTimeout(() => {
      void previewCartDiscounts(cart.discountCodes, items.map(([, item]) => item)).then((preview) => {
        if (!current) return;
        setDiscounts(preview.ok ? preview : null);
        // The preview names each line's share by position: keyed here to the lines it priced.
        const decimalPlaces = getDecimalPlaces(getCurrencyCode());
        setLineDiscounts(preview.ok
          ? new Map(items.map(([key, item], index) => [key, { discountMinor: preview.lineDiscountsMinor[index] ?? 0, quantity: item.quantity, decimalPlaces }]))
          : NO_LINE_DISCOUNTS);
      });
      const attributes = readBuyerAttributes();
      void fetch("/api/checkout/validate-cart", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...browserBuyerUiLocaleHeaders() },
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
            ...purchaseOptionsField(item),
          })),
          // Answers to the apps' checkout questions: their rules and blocks read them.
          ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
          // The page's market prices the cart (MARKETS-DESIGN D5).
          ...(currentPresence() ? { presence: currentPresence() } : {}),
        }),
      })
        .then((response) => response.json())
        .then((json: { data?: CartValidationResult; details?: { itemIssues?: CartValidationIssue[] } }) => {
          if (!current) return;
          const found = json?.data?.issues ?? json?.details?.itemIssues ?? [];
          setLineInputs(json?.data ? cartLineInputFacts(json.data, found) : NO_LINE_INPUTS);
          setIssues(Object.fromEntries(found.flatMap((issue) => issue.cartKey ? [[issue.cartKey, issue]] : [])));
          setRuleErrors(parseCartRuleErrors(json?.data?.ruleErrors));
          // A refused check keeps no blocks: they belong to a cart the store read.
          const blocks = json?.data?.buyerUi;
          setBuyerUi(Array.isArray(blocks) && blocks.length > 0 ? blocks : NO_BLOCKS);
        })
        .catch(() => undefined);
    }, 300);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [cart.items, cart.discountCodes, isOpen, revision]);
  const hasItems = Object.keys(cart.items).length > 0;
  // An "only N left" the line already follows (capped after the add) is not shown again.
  const current = useMemo(() => {
    const byVariant = quantitiesByVariant(cart.items);
    return Object.fromEntries(Object.entries(issues).filter(([key, issue]) => {
      const line = cart.items[key];
      return !line || !isFollowedQuantityIssue(issue, line.quantity, byVariant.get(line.variantId ?? "") ?? line.quantity);
    }));
  }, [issues, cart.items]);
  return { discounts: hasItems ? discounts : null, lineDiscounts, issues: current, ruleErrors, buyerUi: hasItems ? buyerUi : NO_BLOCKS, lineInputs: hasItems ? lineInputs : NO_LINE_INPUTS, recheck };
}

/**
 * Draws the apps' line inputs into the drawer's line mounts and its bulk bar
 * after each render; the controls' module loads only once the check names
 * an input some line takes.
 */
function useDrawerLineInputs(root: React.RefObject<HTMLElement | null>, facts: CartLineInputFacts, cart: CartStore): void {
  useEffect(() => {
    const element = root.current;
    if (!element || facts.inputs.size === 0) return;
    let current = true;
    void import("@/lib/cart/line-input-controls").then(({ mountCartLineInputs }) => {
      if (current) mountCartLineInputs(element, facts);
    }).catch(() => undefined);
    return () => { current = false; };
  }, [root, facts, cart.items]);
}

/**
 * The drawer's own buyer UI mount (`cart_drawer.footer`): hidden until a
 * block lands, so a drawer without one never shifts. It is its own scope, so
 * the page's renders (the cart page's) never clear it, nor it theirs. The
 * renderer loads only once there is something to draw.
 */
function DrawerBuyerUi({ blocks, onChange }: { blocks: unknown[]; onChange: () => void }) {
  const mount = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = mount.current;
    if (element) void renderBuyerUiWhenNeeded(blocks, { root: element, onChange });
  }, [blocks, onChange]);
  return <div ref={mount} data-buyer-ui-scope="" data-buyer-ui-target="cart_drawer.footer" className="space-y-2 text-sm" hidden />;
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

/** An offer's saving in the page's digits: "20% off", "২০% ছাড়", or "free". */
function offerSaving(percentOff: number, copy: CartDrawerCopy): string {
  if (percentOff >= 100) return copy.offerFree;
  return copy.offerPercent(formatNumber(percentOff / 100, numberLocale(pageLanguage(), storeRegion()), { style: "percent", maximumFractionDigits: 0 }));
}

export default function CartFlyout({ onReady }: Props) {
  // The page's language: Bangla words and digits on a Bangla page.
  const copy = cartDrawerCopy();
  const lineCopy = cartLineCopy();
  // The platform's words on a line ("Yes", "Add-on") in the page's language, from the checkout catalogue.
  const lineWords = lineEntryWords(pageLanguage());
  // A line's buyer inputs describe its controls: two engravings of one SKU are two lines.
  const inputsIdBase = useId();
  const inputsId = (index: number, item: { properties?: unknown[] }) =>
    item.properties && item.properties.length > 0 ? `${inputsIdBase}-inputs-${index}` : undefined;
  const priceCopy = storefrontPriceCopy(pageLanguage());
  const cart = useStore(cartStore);
  const isOpen = useStore(cartOpenState);
  const { discounts, lineDiscounts, issues, ruleErrors, buyerUi, lineInputs, recheck } = useDrawerCartFacts(cart, isOpen);
  // Some lines ship and some don't: the ones that don't say so, as on the cart page.
  const mixedFulfilment = cartHasMixedFulfilment(cart.items);
  const linesRef = useRef<HTMLDivElement>(null);
  useDrawerLineInputs(linesRef, lineInputs, cart);
  // The theme's drawer: its width, and whether it suggests products (none fetched when it does not).
  const look = readCartDrawerLook();
  const recommendations = useCartRecommendations(cart, isOpen && look.recommendations === "shown");
  // A line that can't be bought as is blocks Checkout here, like on the cart page,
  // and so does a store app's rule (on its line, or about the whole cart).
  const lineIssues = Object.entries(issues).filter(([key]) => cart.items[key]);
  const rules = groupCartRuleErrors(ruleErrors, cart.items);
  const cartRuleMessages = rules.cart.map(({ message }) => message).filter(Boolean);
  const checkoutBlocked =
    lineIssues.length > 0 || Object.keys(rules.lines).length > 0 || rules.cart.length > 0;
  const blockedText = cartRuleMessages.length > 0 && lineIssues.length === 0 && Object.keys(rules.lines).length === 0
    ? cartRuleMessages.join(" ")
    : copy.fixToCheckout;
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
  /** How many lines one action added (Buy again adds several); 1 for a single add. */
  const [addedCount, setAddedCount] = useState(1);
  const addedItem = addedKey ? cart.items[addedKey] : undefined;
  const announced = useDelayedFlag(isOpen && Boolean(addedItem), addedKey);
  /**
   * What the add came to once the server counted the stock: the line capped
   * to the units left (Shopify: "All 40 … are in your cart"), or nothing
   * left to add. Null while the add went through as asked.
   */
  const [addedOutcome, setAddedOutcome] = useState<{ key: string; left: number } | null>(null);
  useEffect(() => {
    if (!addedKey) {
      setAddedOutcome(null);
      return;
    }
    const issue = issues[addedKey];
    const line = cart.items[addedKey];
    if (!line || issue?.code !== "quantity_unavailable" || typeof issue.availableQuantity !== "number") return;
    const left = Math.max(0, Math.floor(issue.availableQuantity));
    // The buyer asked for more than is left: the line takes what is left,
    // instead of an "added" note beside an error on the same line.
    if (left >= 1 && line.quantity > left) updateCartItemByKey(addedKey, { quantity: left });
    setAddedOutcome({ key: addedKey, left });
  }, [addedKey, issues, cart.items]);
  const outcome = addedOutcome && addedOutcome.key === addedKey ? addedOutcome : null;
  const addedText = !outcome
    ? copy.added
    : outcome.left > 0
      ? copy.addedLeft(formatCount(outcome.left))
      : copy.soldOut;
  const itemsText = copy.itemCount(formatCount(cart.totalItems), cart.totalItems === 1);

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

    const openCart = (addedLineKey?: string, count = 1) => {
      rememberTrigger();
      setAddedKey(addedLineKey ?? null);
      setAddedCount(count);
      setAddedOutcome(null);
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
      const detail = (event as CustomEvent<OpenCartEventDetail | undefined> | undefined)?.detail;
      openCart(detail?.addedLineKey, detail?.addedCount);
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
        openCart(pendingEvent.detail?.addedLineKey, pendingEvent.detail?.addedCount);
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
    <Dialog.Root
      open={isOpen}
      onOpenChange={setCartOpen}
    >
      <Dialog.Portal>
      <Dialog.Overlay className={DRAWER_OVERLAY} />
      <Dialog.Content
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
        className={`${DRAWER_SHEET} ${look.width === "wide" ? "sm:max-w-[440px]" : "sm:max-w-[380px]"}`}
      >
        <Dialog.Description className="text-sm text-muted-foreground sr-only">
          {addedItem ? copy.describeAdded(addedItem.name, addedCount > 1 ? formatCount(addedCount) : undefined) : copy.describe}
        </Dialog.Description>
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
          className="flex items-center justify-between px-4 pb-2 pt-0 sm:pt-4 sm:px-5 sm:pb-4 border-b border-border bg-card shrink-0 z-20 h-auto shadow-[0_1px_2px_rgba(0,0,0,0.03)]"
          onTouchStart={handleDragStart}
          onTouchMove={handleDragMove}
          onTouchEnd={handleDragEnd}
        >
          <div className="flex items-center gap-2">
            <Dialog.Title className="text-[15px] sm:text-lg font-bold text-foreground tracking-tight flex items-center gap-2">
              {copy.title}
              <span aria-hidden="true" className="bg-primary text-primary-foreground text-sm font-bold px-2 py-0.5 rounded-full leading-none min-w-[18px] text-center">
                {formatCount(cart.totalItems)}
              </span>
              <span className="sr-only">{itemsText}</span>
            </Dialog.Title>
          </div>

          <Dialog.Close
            aria-label={copy.close}
            className="group -me-2 flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground transition-all hover:bg-muted hover:text-foreground active:scale-90 focus:outline-none sm:-me-2 sm:h-9 sm:w-9 cursor-pointer"
          >
            <X className="h-4 w-4 sm:h-5 sm:w-5 transition-transform duration-300 group-hover:rotate-90" />
          </Dialog.Close>
        </div>

        {/* Confirmation of an add, like Shopify's cart notification. A fixed strip in the sheet, never in the page. */}
        {addedItem && (
          <div className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-4 py-2 text-sm font-medium text-foreground sm:px-5" data-cart-added>
            <span aria-hidden="true" className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
              <Check className="h-3 w-3" strokeWidth={3} />
            </span>
            <span aria-hidden="true" data-cart-added-text>{addedText}</span>
            <p role="status" className="sr-only">
              {announced
                ? addedCount > 1
                  ? copy.announceAddedMany(formatCount(addedCount), itemsText)
                  : outcome
                    ? copy.announceOutcome(addedItem.name, addedText, itemsText)
                    : copy.announceAdded(addedItem.name, itemsText)
                : ""}
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
                    {copy.empty}
                  </h3>
                </div>
                <button
                  type="button"
                  onClick={() => setCartOpen(false)}
                  data-theme-component="button"
                  data-theme-variant="default"
                  data-theme-size="sm"
                  className={`${DRAWER_BUTTON} inline-flex items-center justify-center gap-2 mt-1 h-11 rounded-full px-5 text-xs hover:bg-primary/90 sm:h-9 cursor-pointer`}
                >
                  {copy.startShopping}
                </button>
              </div>
            ) : (
              // Mobile: gap-2 (tighter), Desktop: gap-3
              <div ref={linesRef} className="space-y-2 sm:space-y-3 pb-4">
                {/* The apps' bulk actions on their line inputs, drawn by the line-input controls (only once a line takes one). */}
                {lineInputs.inputs.size > 0 && <div className="flex flex-wrap gap-2" data-cart-line-input-bulk hidden />}
                {lineInputs.inputs.size > 0 && <p className="sr-only" role="status" data-cart-line-input-status />}
                {lineEntries.map(([key, item], index) => {
                  const view = cartLineView(key, item, {
                    discount: lineDiscounts.get(key),
                    // The drawer does not track stock limits: the check's issue caps the line.
                    quantityLimit: null,
                    mixedFulfilment,
                    words: lineWords,
                    surchargeText: "+{price}",
                  });
                  const describedBy = inputsId(index, item);
                  const remove = () => removeWithUndo(copy.removed(view.lineName), () => removeCartItemByKey(key));
                  return (
                  <div
                    key={key}
                    data-line-key={key}
                    aria-current={key === addedKey ? "true" : undefined}
                    className={`group relative flex gap-2.5 sm:gap-3 bg-card p-2 sm:p-2.5 rounded-xl border shadow-sm ${key === addedKey ? "border-primary ring-1 ring-primary" : "border-border"}`}
                  >
                    {/* Compact Image */}
                    <div className="h-12 w-12 sm:h-18 sm:w-18 shrink-0 overflow-hidden rounded-lg border border-border bg-muted">
                      <CartLineImage url={view.image} alt={view.name} />
                    </div>

                    <div className="flex flex-1 flex-col min-w-0 justify-between py-0">
                      <div className="flex justify-between items-start gap-1.5">
                        <div className="space-y-0.5 min-w-0 flex-1">
                          <h3 className="line-clamp-2 pe-1 text-[12px] font-bold leading-tight text-foreground sm:text-[13.5px]">
                            <a
                              href={view.productHref}
                              className="hover:text-muted-foreground transition-colors"
                              data-cart-line-name
                            >
                              {view.name}
                            </a>
                          </h3>

                          {view.options.length > 0 && (
                            <div className="text-xs text-muted-foreground">
                              {view.options.map((option) => (
                                <span key={`${option.name}:${option.label}`} className="block" data-cart-line-option>
                                  {option.name}: {option.label}
                                </span>
                              ))}
                            </div>
                          )}
                          {view.purchaseOptions.map((option) => (
                            <p key={option.id} className="text-xs font-medium text-foreground" data-cart-line-purchase-option>
                              {option.title}
                            </p>
                          ))}
                          {(view.inputs.length > 0 || view.components.length > 0) && (
                            <div className="text-xs text-muted-foreground" data-cart-line-properties>
                              <ul id={describedBy}>
                                {view.inputs.map((input) => (
                                  <li key={input.key} className="break-words" data-property-key={input.key}>
                                    {input.text}
                                  </li>
                                ))}
                                {view.components.map((component, position) => (
                                  <li key={`component:${position}`} className="break-words" data-cart-line-component>
                                    {component}
                                  </li>
                                ))}
                              </ul>
                              {view.editHref && (
                                <a
                                  data-cart-line-edit=""
                                  href={view.editHref}
                                  className="inline-flex min-h-9 items-center font-medium text-foreground underline underline-offset-2"
                                  aria-label={copy.editItem(view.lineName)}
                                  aria-describedby={describedBy}
                                  onClick={() => {
                                    // Session storage, not the URL: the inputs are buyer content.
                                    writeCartLineEdit({
                                      lineKey: key,
                                      productId: item.id,
                                      variantId: item.variantId,
                                      quantity: item.quantity,
                                      properties: cartLinePropertyInputs(item),
                                      ...purchaseOptionsField(item),
                                    });
                                  }}
                                >
                                  {copy.edit}
                                </a>
                              )}
                            </div>
                          )}
                          {view.fulfilment && (
                            <p
                              className={view.fulfilment === "ships-free" ? "text-xs font-medium text-foreground" : "text-xs text-muted-foreground"}
                              data-cart-line-fulfilment={view.fulfilment}
                            >
                              {view.fulfilment === "ships-free" ? lineCopy.shipsFree : view.fulfilment === "digital" ? lineCopy.digital : lineCopy.service}
                            </p>
                          )}
                          <div className="mt-1.5 grid gap-2" data-cart-line-inputs data-line-key={key} hidden />
                          {issues[key] && (
                            <div className="space-y-1" role="alert">
                              <p className="text-sm font-medium text-destructive">{issues[key].message}</p>
                              {issues[key].action === "reduce_quantity" && (issues[key].availableQuantity ?? 0) >= 1 ? (
                                <button
                                  type="button"
                                  className="min-h-9 rounded-md border border-border px-2 text-sm font-medium text-foreground hover:bg-muted cursor-pointer"
                                  aria-label={lineCopy.updateQuantityFor(formatCount(Math.floor(issues[key].availableQuantity!)), view.lineName)}
                                  aria-describedby={describedBy}
                                  onClick={() => {
                                    updateCartItemByKey(key, { quantity: Math.floor(issues[key]!.availableQuantity!) });
                                  }}
                                >
                                  {lineCopy.updateQuantity(formatCount(Math.floor(issues[key].availableQuantity!)))}
                                </button>
                              ) : issues[key].action === "remove" || issues[key].action === "reduce_quantity" ? (
                                <button
                                  type="button"
                                  className="min-h-9 rounded-md border border-border px-2 text-sm font-medium text-foreground hover:bg-muted cursor-pointer"
                                  aria-label={lineCopy.removeFor(view.lineName)}
                                  aria-describedby={describedBy}
                                  onClick={remove}
                                >
                                  {lineCopy.remove}
                                </button>
                              ) : null}
                            </div>
                          )}
                          {(rules.lines[key] ?? []).map((rule, position) => (
                            <p key={`${rule.code}:${position}`} className="text-sm font-medium text-destructive" role="alert">
                              {rule.message}
                            </p>
                          ))}
                        </div>

                        {/* Price: a free line struck then zero, as the cart page and the receipt draw it. */}
                        <div className="text-[12px] sm:text-sm font-bold text-foreground tabular-nums text-end shrink-0">
                          <div data-cart-line-price data-cart-line-free={view.free ? "" : undefined}>
                            {view.compareAt ? (
                              <>
                                <span className="sr-only">{lineCopy.freeLine(view.compareAt)}</span>
                                <span aria-hidden="true">
                                  <s className="me-1 font-normal text-muted-foreground" data-cart-line-compare-at>{view.compareAt}</s>
                                  <span data-cart-line-amount>{view.linePrice}</span>
                                </span>
                              </>
                            ) : <span data-cart-line-amount>{view.linePrice}</span>}
                          </div>
                          {view.unitPrice && (
                            <div className="text-xs font-normal text-muted-foreground" data-cart-line-unit-price>
                              {view.unitPrice} {lineCopy.each}
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Controls Row */}
                      <div className="flex items-end justify-between mt-1">
                        <div className="flex h-11 items-center overflow-hidden rounded-md bg-muted/50 ring-1 ring-inset ring-input sm:h-8">
                          <button
                            aria-label={copy.decrease(view.lineName)}
                            aria-describedby={describedBy}
                            onClick={() => {
                              if (view.decreaseTo === 0) remove();
                              else updateCartItemByKey(key, { quantity: view.decreaseTo });
                            }}
                            className="flex h-full w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-background hover:text-foreground active:bg-muted sm:w-8 cursor-pointer"
                          >
                            <Minus className="h-3 w-3" />
                          </button>
                          <span className="flex h-full w-8 items-center justify-center text-center text-sm font-bold leading-none text-foreground tabular-nums" data-cart-line-quantity>
                            {view.quantityText}
                          </span>
                          <button
                            aria-label={copy.increase(view.lineName)}
                            aria-describedby={describedBy}
                            disabled={view.increaseBlocked !== null}
                            onClick={() => {
                              updateCartItemByKey(key, { quantity: view.increaseTo });
                            }}
                            className="flex h-full w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-background hover:text-foreground active:bg-muted sm:w-8 cursor-pointer"
                          >
                            <Plus className="h-3 w-3" />
                          </button>
                        </div>

                        <button
                          aria-label={lineCopy.removeFor(view.lineName)}
                          aria-describedby={describedBy}
                          onClick={remove}
                          className="flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive active:scale-90 sm:h-8 sm:w-8 cursor-pointer"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                  );
                })}
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
                              {product.priceVaries
                                ? priceCopy.from(formatMoney(product.discountedPrice))
                                : formatMoney(product.discountedPrice)}
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
            className={`absolute bottom-0 inset-s-0 inset-e-0 h-6 bg-linear-to-t from-card to-transparent pointer-events-none transition-opacity duration-300 ${canScrollMore ? "opacity-100" : "opacity-0"}`}
          />
        </div>

        {undo && (
          <p className="shrink-0 border-t border-border bg-card px-4 py-2 text-sm text-muted-foreground" role="status">
            {undo.message} ·{" "}
            <button type="button" onClick={undoRemoval} className="font-medium text-foreground underline underline-offset-2 cursor-pointer">
              {copy.undo}
            </button>
          </p>
        )}

        {/* Savings and offers the cart already qualifies for */}
        {cart.totalItems > 0 && discounts && (discounts.discounts.length > 0 || discounts.offers.length > 0) && (
          <div className="shrink-0 space-y-1 border-t border-border bg-card px-3 py-2 text-sm sm:px-5">
            {discounts.discounts.map((line, position) => ({ line, key: discountLineKey(line, position) })).filter(({ line }) => line.amount > 0).map(({ line, key }) => (
              <div key={key} className="flex justify-between gap-3 text-primary">
                <span className="min-w-0">{formatDiscountLineLabel(copy.discount, line)}</span>
                <span className="shrink-0 tabular-nums">-{formatMoney(line.amount)}</span>
              </div>
            ))}
            {discounts.offers.map((offer) => (
              <div key={offer.promotionId} className="flex items-center justify-between gap-2 text-foreground">
                <span className="line-clamp-2 min-w-0 break-words">
                  <span className="font-medium">{offer.title}:</span>{" "}
                  {offer.products.map(({ name }) => name).join(" / ")} {offerSaving(offer.percentOff, copy)}
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
                    {copy.add}
                  </button>
                ) : offer.products[0] ? (
                  <a href={pagePath(`/products/${encodeURIComponent(offer.products[0].slug)}`)} className="shrink-0 text-sm font-medium underline underline-offset-2">
                    {copy.view}
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
                  {discountTotal > 0 ? copy.estimatedTotal : copy.subtotal}
                </div>
                <div className="text-lg font-semibold text-foreground tabular-nums sm:text-xl">
                  {formatMoney(estimatedTotal)}
                </div>
              </div>
              {checkoutBlocked && (
                <p id="drawerCheckoutBlocked" className="text-sm text-destructive" role="status">{blockedText}</p>
              )}
              <DrawerBuyerUi blocks={buyerUi} onChange={recheck} />
              {/* One primary action (Shopify): Check out. The cart page is a link beside Continue shopping; Clear cart lives there. */}
              {checkoutBlocked ? (
                <button
                  type="button"
                  disabled
                  aria-describedby="drawerCheckoutBlocked"
                  data-theme-component="button"
                  data-theme-variant="default"
                  data-theme-size="default"
                  className={`${DRAWER_BUTTON} ${DRAWER_CHECKOUT}`}
                >
                  <span>{copy.checkout}</span>
                  <ArrowRight className="h-4 w-4" />
                </button>
              ) : (
                <a
                  href={checkoutHref}
                  onClick={() => setCartOpen(false)}
                  data-theme-component="button"
                  data-theme-variant="default"
                  data-theme-size="default"
                  className={`${DRAWER_BUTTON} ${DRAWER_CHECKOUT} hover:bg-primary/90 cursor-pointer`}
                >
                  <span>{copy.checkout}</span>
                  <ArrowRight className="h-4 w-4" />
                </a>
              )}
              <div className="flex items-center justify-between gap-3 px-1">
                <a
                  href={cartHref}
                  onClick={() => setCartOpen(false)}
                  className="inline-flex min-h-11 items-center text-sm font-medium text-foreground underline underline-offset-2 hover:text-primary sm:min-h-9"
                >
                  {copy.viewCart}
                </a>
                <button
                  type="button"
                  onClick={() => setCartOpen(false)}
                  className="min-h-11 text-sm text-muted-foreground hover:text-foreground underline decoration-border underline-offset-2 cursor-pointer sm:min-h-9"
                >
                  {copy.continueShopping}
                </button>
              </div>
            </div>
          </div>
        )}
      </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
