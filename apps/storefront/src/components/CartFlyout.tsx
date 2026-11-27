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
  adoptCheckedLinePrices,
  cartLineCheckPrice,
  type CartStore,
} from "@/store/cart";
import { writeCartLineEdit } from "@/lib/cart/line-edit";
import { purchaseOptionsField } from "@/lib/cart/purchase-option";
import { useStore } from "@nanostores/react";
import { atom } from "nanostores";
import { ArrowRight, Check, ChevronDown, Minus, Plus, ShoppingBag, Trash2, X } from "@/components/icons/lucide-svg";
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { formatMoney, getCurrencyCode, getDecimalPlaces } from "@/lib/currency";
import { fromMinor, toMinor } from "@scalius/shared/money";
import { addOnRowsOver, readAddOnRows, type AddOnTotalRow } from "@scalius/shared/add-on-totals";
import type { AddOnRowsShown } from "@/lib/add-on-row";
import { formatCount, pageLanguage, storeRegion } from "@/lib/store-time-zone";
import { cartDrawerCopy, type CartDrawerCopy } from "@/lib/cart-drawer-copy";
import { cartLineCopy, isLongAnswer } from "@/lib/cart-line-copy";
import { cartLineStockText } from "@/lib/cart-line-stock-copy";
import { buyerApiErrorTextNow, loadBuyerApiErrors } from "@/lib/buyer-api-error-text-later";
import { lineEntryWords } from "@scalius/shared/line-entry-words";
import { formatNumber, numberLocale } from "@scalius/shared/locale-format";
import { PRODUCT_IMAGE_FALLBACK, productImageSources, resolveProductImageUrl } from "@/lib/product-media";
import type { ImageSlot } from "@/lib/responsive-image";
import { readCartCheckDiscount } from "@/lib/cart/browser-api";
import { discountLineKey, type CheckoutDiscountFacts } from "@/lib/checkout/quote-facts";
import type { CartRuleError, CartValidationIssue, CartValidationResult } from "@/lib/api/orders";
import { groupCartRuleErrors, parseCartRuleErrors } from "@/lib/cart/rule-errors";
import { cartItemVariantLabel } from "@/lib/cart/item-options";
import { formatDiscountLineLabel } from "@scalius/shared/checkout-language-format";
import { currentPresence, pagePath } from "@/lib/presence-url";
import { readBuyerAttributes } from "@/lib/buyer-ui/state";
import { browserBuyerUiLocaleHeaders } from "@/lib/buyer-ui/browser-locale";
import { renderBuyerUiWhenNeeded } from "@/lib/buyer-ui/lazy";
import { readCartDrawerPlan, type CartDrawerNode } from "@/lib/cart/drawer-plan";
import { orderClass, reordered, titleFirst, type OrderedLineNode } from "@/lib/cart/line-reading-order";
import { cartLineInputFacts, NO_LINE_INPUTS, type CartLineInputFacts } from "@/lib/cart/line-inputs";
import { cartEstimate, cartHasMixedFulfilment, cartLineDiscountsOf, cartLineEntries, cartLineIssues, cartLineView, type CartLineDiscount } from "@/lib/cart/line-view";

/** The drawer's suggestions: a chunk of their own, loaded with the open drawer (never with the first add to cart). */
const DrawerRecommendations = React.lazy(() => import("./cart/DrawerRecommendations"));

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
/**
 * Mobile: a bottom sheet of the screen but a 3rem strip above it (the page shows there, and a tap on it closes the
 * sheet), so five real lines leave two whole on a 390x844 phone and one on a 320x568 one under the pinned total and
 * Check out. From `sm`: a side sheet, its width the theme's.
 */
const DRAWER_SHEET =
  "z-[var(--scalius-z-overlay,70)] w-full flex flex-col p-0 bg-card shadow-2xl gap-0 transition-transform duration-300 ease-out border-s border-none focus:outline-none"
  + " data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:duration-300 data-[state=open]:duration-500"
  + " fixed inset-x-0 bottom-0 h-[calc(100dvh-3rem)] max-h-[calc(100dvh-3rem)] top-auto rounded-t-[20px] border-t-0"
  + " sm:fixed sm:inset-y-0 sm:inset-e-0 sm:inset-s-auto sm:h-full sm:max-h-none sm:w-full sm:rounded-none sm:border-s";
/** The drawer's filled buttons (the storefront button's look, flat in the primary colour). */

const DRAWER_BUTTON =
  "whitespace-nowrap ring-offset-background transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
  + " disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 active:scale-[0.97] active:translate-y-[1px]"
  + " relative after:absolute after:inset-0 after:rounded-md after:pointer-events-none after:shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]"
  + " border border-primary/20 shadow-md hover:shadow-lg bg-primary font-bold text-primary-foreground";
const DRAWER_CHECKOUT = "flex items-center justify-center gap-2 h-12 w-full rounded-xl px-4 py-2 text-base";

/** Line photo: h-12 w-12, sm:h-18 sm:w-18. */
const CART_LINE_IMAGE: ImageSlot = { width: 160, sizes: "(min-width: 640px) 72px, 48px", maxWidth: 320 };
/** Suggestion photo: a w-28 card minus p-1.5 and its border. */

function productImageProps(
  url: string | null | undefined,
  slot: ImageSlot,
): { src: string; srcSet?: string; sizes?: string } {
  const { src, srcset, sizes } = productImageSources(url, slot);
  return { src, srcSet: srcset, sizes };
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

/** The lines and codes the cart check prices the discounts for: when they change, the shown discounts are for another cart. */
function cartPricingKey(cart: Pick<CartStore, "items" | "discountCodes">): string {
  return JSON.stringify([cart.items, cart.discountCodes]);
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

/** Draws again once the refusal catalogue (buyer-api-error-text-later.ts) has loaded, when a line needs it. */
function useRefusalWords(needed: boolean): void {
  const [, setLoaded] = useState(false);
  useEffect(() => {
    if (needed) void loadBuyerApiErrors().then((loaded) => setLoaded(Boolean(loaded)), () => undefined);
  }, [needed]);
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
  /** Every issue of each line, grouped as the cart page groups them (`cartLineIssues`): the estimate counts lines through them. */
  const [issueLists, setIssueLists] = useState<Record<string, CartValidationIssue[]>>({});
  /** The lines and codes the shown discounts were priced for: another set means they are being priced again. */
  const [pricedFor, setPricedFor] = useState("");
  /** Units the store can sell of each line, as the check said (the cart page's limits): "+" stops there. */
  const [limits, setLimits] = useState<Record<string, number | null>>({});
  /** Store app rules that block checkout, in the app's own words. */
  const [ruleErrors, setRuleErrors] = useState<CartRuleError[]>([]);
  /** The apps' add-on rows as the check folded them (the server's rows; the drawer never folds its own). */
  const [addOnRows, setAddOnRows] = useState<AddOnTotalRow[]>([]);
  /** The rows the drawer's checks showed last, across its openings (lib/add-on-row.ts). */
  const addOnRowsShown = useRef<AddOnRowsShown>({}).current;
  /** The apps' buyer UI blocks, as the check answered them (parsed where they are drawn). */
  const [buyerUi, setBuyerUi] = useState<unknown[]>(NO_BLOCKS);
  /** The apps' line inputs each line takes (the check's), drawn by line-input-controls.ts. */
  const [lineInputs, setLineInputs] = useState<CartLineInputFacts>(NO_LINE_INPUTS);
  /** Bumped when a block changed what the check reads (an answer it set). */
  const [revision, setRevision] = useState(0);
  const recheck = useCallback(() => setRevision((value) => value + 1), []);
  // What a check reads: the lines and their quantities. A line taking the store's price from the
  // check (`adoptCheckedLinePrices`) changes neither, so it never asks for a second check.
  const checkKey = useMemo(() => JSON.stringify(Object.entries(cart.items).map(([key, item]) => [key, item.quantity])), [cart.items]);
  useEffect(() => {
    const items = Object.entries(cart.items);
    if (!isOpen || items.length === 0) return;
    let current = true;
    // The cart's discounts come with the check (its codes sent): the lines it can sell, at the store's prices.
    const priceDiscounts = (answer: Awaited<ReturnType<typeof readCartCheckDiscount>>) => {
      if (!current) return;
      setDiscounts(answer.ok ? answer : null);
      setLineDiscounts(answer.ok ? cartLineDiscountsOf(items, answer.lineDiscountsMinor) : NO_LINE_DISCOUNTS);
      setPricedFor(cartPricingKey(cartStore.get()));
    };
    const timer = window.setTimeout(() => {
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
            ...cartLineCheckPrice(item),
            productName: item.name,
            variantLabel: cartItemVariantLabel(item.options),
            ...(item.properties?.length ? { properties: cartLinePropertyInputs(item) } : {}),
            ...purchaseOptionsField(item),
          })),
          // Answers to the apps' checkout questions: their rules and blocks read them.
          ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
          // The page's market prices the cart (MARKETS-DESIGN D5).
          ...(currentPresence() ? { presence: currentPresence() } : {}),
          // The applied codes: the check answers the cart's discounts too (no request of their own).
          discountCodes: cart.discountCodes,
        }),
      })
        .then(async (response) => ({ response, json: await response.json() as { data?: CartValidationResult; details?: { itemIssues?: CartValidationIssue[] } } }))
        .then(async ({ response, json }) => {
          const addOnRows = readAddOnRows((json?.data as { addOns?: unknown } | undefined)?.addOns);
          // The row markup loads with the first add-on row, so the rows draw with the amounts they add up to;
          // with none, the next row to show is one the buyer adds (it opens by itself).
          if (addOnRows.length > 0) await addOnRowMarkup();
          else addOnRowsShown.keys = new Set();
          if (!current) return;
          // An edited line takes the store's price from this check.
          if (json?.data?.items) adoptCheckedLinePrices(json.data.items);
          const found = json?.data?.issues ?? json?.details?.itemIssues ?? [];
          setLineInputs(json?.data ? cartLineInputFacts(json.data, found) : NO_LINE_INPUTS);
          setLimits(Object.fromEntries((json?.data?.items ?? []).flatMap((line) => {
            const key = line.cartKey ?? items[line.index]?.[0];
            return key ? [[key, typeof line.availableQuantity === "number" ? Math.max(0, Math.floor(line.availableQuantity)) : null]] : [];
          })));
          setRuleErrors(parseCartRuleErrors(json?.data?.ruleErrors));
          setAddOnRows(addOnRows);
          // A refused check keeps no blocks: they belong to a cart the store read.
          const blocks = json?.data?.buyerUi;
          setBuyerUi(Array.isArray(blocks) && blocks.length > 0 ? blocks : NO_BLOCKS);
          setIssueLists(cartLineIssues(found, cart.items));
          priceDiscounts(await readCartCheckDiscount(response, json, items.length));
        })
        // A check that failed prices no discount.
        .catch(() => priceDiscounts({ ok: false, message: null }));
    }, 300);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [checkKey, cart.discountCodes, isOpen, revision]);
  const hasItems = Object.keys(cart.items).length > 0;
  // The lines the cart still holds, regrouped against them: an "only N left" the line already follows
  // (capped after the add) is not shown again. A line's first issue is the one it shows.
  const currentIssueLists = useMemo(() => cartLineIssues(Object.values(issueLists).flat(), cart.items), [issueLists, cart.items]);
  const current = useMemo(() => Object.fromEntries(Object.entries(currentIssueLists).map(([key, list]) => [key, list[0]!])), [currentIssueLists]);
  // Discounts priced for other lines than these are being priced again: shown as pending, never as final.
  const discountsPending = hasItems && pricedFor !== cartPricingKey(cart) && (discounts?.totalDiscount ?? 0) > 0;
  return { discounts: hasItems ? discounts : null, discountsPending, lineDiscounts, issues: current, issueLists: currentIssueLists, limits, ruleErrors, buyerUi: hasItems ? buyerUi : NO_BLOCKS, lineInputs: hasItems ? lineInputs : NO_LINE_INPUTS, addOnRows: hasItems ? addOnRows : [], addOnRowsShown, recheck };
}

/** The add-on rows' markup (lib/add-on-row.ts), loaded with the check that first names one. */
const addOnRowMarkup = () => import("@/lib/add-on-row");

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
 * block lands, so a drawer without one never shifts. The drawer is its own
 * scope, so the page's renders (the cart page's) never clear its mounts, nor
 * it theirs; one render draws the footer and the blocks under each line
 * (`cart.line.after`), again whenever the lines change. The renderer loads
 * only once there is something to draw.
 */
function DrawerBuyerUi({ blocks, onChange, lines, lineInputs }: { blocks: unknown[]; onChange: () => void; lines: unknown; lineInputs: CartLineInputFacts }) {
  const mount = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = mount.current?.closest<HTMLElement>("[data-buyer-ui-scope]") ?? mount.current;
    if (element) void renderBuyerUiWhenNeeded(blocks, { root: element, onChange, lineInputs: () => lineInputs });
  }, [blocks, onChange, lines, lineInputs]);
  return <div ref={mount} data-buyer-ui-target="cart_drawer.footer" className="space-y-2 text-sm" hidden />;
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

/** The drawer's plain layouts (a theme shapes them further through their `data-hook`). */
const DRAWER_LAYOUTS: Record<string, string> = {
  stack: "flex min-w-0 flex-col gap-2",
  columns: "grid min-w-0 gap-2 sm:grid-flow-col sm:auto-cols-fr",
  grid: "grid min-w-0 gap-2",
  group: "min-w-0",
};

function drawerHas(nodes: readonly CartDrawerNode[], part: string): boolean {
  return nodes.some((node) => (node.type === "part" && node.part === part) || (node.type === "layout" && drawerHas(node.children, part)));
}

/**
 * A theme's arrangement of the drawer or of its line: its parts where it put
 * them and the host's layouts. `target` draws an extension target (a line's is its `target` part);
 * `scroll` the drawer's scrolling region.
 */
function drawerNodes(
  nodes: readonly OrderedLineNode[],
  parts: Record<string, React.ReactNode>,
  hosts: { target?: (name: string) => React.ReactNode; scroll?: (children: React.ReactNode, key: number) => React.ReactNode } = {},
): React.ReactNode {
  return nodes.map((node, index) => {
    // A part or target moved ahead of the title's box mates keeps its place on screen (line-reading-order.ts).
    const placed = (content: React.ReactNode) => node.order === undefined ? <React.Fragment key={index}>{content}</React.Fragment> : <div key={index} className={`min-w-0 ${orderClass(node)}`}>{content}</div>;
    if (node.type === "part") return placed(parts[node.part!]);
    if (node.type === "target") return placed(hosts.target ? hosts.target(node.target!) : parts.target);
    // The plan names host parts, targets and layouts only: anything else draws nothing.
    if (node.type !== "layout" || !Array.isArray(node.children)) return null;
    const children = drawerNodes(node.children, parts, hosts);
    if (node.layout === "scroll" && hosts.scroll) return hosts.scroll(children, index);
    const column = node.layout === "group" && reordered(node.children) ? "flex flex-col " : "";
    return <div key={index} data-layout={node.layout} data-hook={node.hook} className={`${column}${DRAWER_LAYOUTS[node.layout!] ?? "min-w-0"} ${orderClass(node)}`.trim()}>{children}</div>;
  });
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
  const cart = useStore(cartStore);
  const isOpen = useStore(cartOpenState);
  const { discounts, discountsPending, lineDiscounts, issues, issueLists, limits, ruleErrors, buyerUi, lineInputs, addOnRows, addOnRowsShown, recheck } = useDrawerCartFacts(cart, isOpen);
  // Any other issue in the catalogue's words (never the API's English), which load with the first one.
  useRefusalWords(Object.keys(issues).length > 0);
  // Some lines ship and some don't: the ones that don't say so, as on the cart page.
  const mixedFulfilment = cartHasMixedFulfilment(cart.items);
  const linesRef = useRef<HTMLDivElement>(null);
  useDrawerLineInputs(linesRef, lineInputs, cart);
  // The theme's drawer (lib/cart/drawer-plan.ts): its frame, its arrangement and its words. It
  // suggests products only where its arrangement keeps them (none are fetched otherwise).
  const plan = readCartDrawerPlan();
  const look = { width: plan.frame === "wide" ? "wide" : "standard", recommendations: !plan.layout || drawerHas(plan.layout, "recommendations") };
  const label = (key: string, fallback: string) => plan.labels[key] ?? fallback;

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
  // The cart page's amounts (`cartEstimate`): the subtotal of what can be bought now,
  // the discounts listed above, and the total net of them.
  const discountTotal = discounts?.totalDiscount ?? 0;
  const estimate = cartEstimate(cart.items, issueLists, discountTotal);
  const moneyPlaces = getDecimalPlaces(getCurrencyCode());
  // The check's add-on rows over the estimate's subtotal: Subtotal is what they leave of it.
  const addOns = addOnRowsOver(toMinor(estimate.subtotal, moneyPlaces), addOnRows);
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
  // The cart page's order (`cartLineEntries`); the line an add just touched is marked, not moved.
  const lineEntries = cartLineEntries(cart.items);

  // ── The drawer's parts (private-anatomy.ts, page `cartDrawer`) ──────────
  // Each is drawn the same way in the host's own drawer and in a theme's
  // arrangement; only where it sits differs.
  const dragZone = {
    onTouchStart: handleDragStart,
    onTouchMove: handleDragMove,
    onTouchEnd: handleDragEnd,
  };
  const header = (
    <div
      className="flex items-center justify-between px-4 pb-2 pt-0 sm:pt-4 sm:px-5 sm:pb-4 border-b border-border bg-card shrink-0 z-20 h-auto shadow-[0_1px_2px_rgba(0,0,0,0.03)]"
      {...dragZone}
      data-part="drawer-header"
    >
      <div className="flex items-center gap-2">
        <Dialog.Title className="text-[15px] sm:text-lg font-bold text-foreground tracking-tight flex items-center gap-2" data-part="drawer-title">
          {label("drawer.title", copy.title)}
          <span aria-hidden="true" className="bg-primary text-primary-foreground text-sm font-bold px-2 py-0.5 rounded-full leading-none min-w-[18px] text-center" data-part="drawer-count">
            {formatCount(cart.totalItems)}
          </span>
          <span className="sr-only">{itemsText}</span>
        </Dialog.Title>
      </div>

      <Dialog.Close
        aria-label={copy.close}
        className="group -me-2 flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground transition-all hover:bg-muted hover:text-foreground active:scale-90 focus:outline-none sm:-me-2 sm:h-9 sm:w-9 cursor-pointer"
        data-part="drawer-close"
      >
        <X className="h-4 w-4 sm:h-5 sm:w-5 transition-transform duration-300 group-hover:rotate-90" />
      </Dialog.Close>
    </div>
  );
  // Confirmation of an add, like Shopify's cart notification. A fixed strip in the sheet, never in the page.
  const added = addedItem && (
    <div className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-4 py-2 text-sm font-medium text-foreground sm:px-5" data-cart-added data-part="drawer-added">
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
  );
  const emptyState = (
    <div className="flex flex-col items-center justify-center h-full py-8 sm:py-12 text-center space-y-3" data-part="drawer-empty">
      <div className="h-12 w-12 sm:h-16 sm:w-16 bg-card rounded-full flex items-center justify-center border border-border shadow-sm">
        {plan.icons["drawer.empty"]
          ? <img src={plan.icons["drawer.empty"]} alt="" width={24} height={24} className="h-5 w-5 object-contain sm:h-6 sm:w-6" data-part="drawer-empty-icon" />
          : <ShoppingBag className="h-5 w-5 sm:h-6 sm:w-6 text-muted-foreground" data-part="drawer-empty-icon" />}
      </div>
      <div className="space-y-0.5">
        <h3 className="text-sm font-bold text-foreground">
          {label("drawer.empty", copy.empty)}
        </h3>
      </div>
      <button
        type="button"
        onClick={() => setCartOpen(false)}
        data-theme-component="button"
        data-theme-variant="default"
        data-theme-size="sm"
        className={`${DRAWER_BUTTON} inline-flex items-center justify-center gap-2 mt-1 h-11 rounded-full px-5 text-xs hover:bg-primary-hover sm:h-9 cursor-pointer`}
      >
        {label("drawer.startShopping", copy.startShopping)}
      </button>
    </div>
  );
  // The suggestions load with the open drawer once it holds items (components/cart/DrawerRecommendations.tsx).
  const recommendationsPart = isOpen && look.recommendations && cart.totalItems > 0 && (
    <React.Suspense fallback={null}>
      <DrawerRecommendations productIds={Object.values(cart.items).map((item) => item.id)} />
    </React.Suspense>
  );
  /** One line: its sub-parts, in the host's own card or the theme's arrangement of them. */
  const line = ([key, item]: (typeof lineEntries)[number], index: number) => {
    const view = cartLineView(key, item, {
      discount: lineDiscounts.get(key),
      quantityLimit: limits[key] ?? null,
      mixedFulfilment,
      words: lineWords,
      surchargeText: "+{price}",
      issues: issueLists[key],
    });
    // A stock issue in the words the cart page uses; any other issue as the check said it.
    const stockText = cartLineStockText(view);
    const describedBy = inputsId(index, item);
    const remove = () => removeWithUndo(copy.removed(view.lineName), () => removeCartItemByKey(key));
    const parts: Record<string, React.ReactNode> = {
      image: (
        <div className="h-12 w-12 sm:h-18 sm:w-18 shrink-0 overflow-hidden rounded-lg border border-border bg-muted" data-part="line-image">
          <CartLineImage url={view.image} alt={view.name} />
        </div>
      ),
      title: (
        // The clamp is the link's own (as on the cart page): a clamp on the heading would clip the link's focus ring.
        <h3 className="pe-1 text-[12px] font-bold leading-tight text-foreground sm:text-[13.5px]" data-part="line-title">
          <a
            href={view.productHref}
            className="line-clamp-2 break-words hover:text-muted-foreground transition-colors"
            data-cart-line-name
          >
            {view.name}
          </a>
        </h3>
      ),
      details: (
        <>
          {view.options.length > 0 && (
            <div className="text-xs text-muted-foreground" data-part="line-details">
              {view.options.map((option) => (
                <span key={`${option.name}:${option.label}`} className="block" data-cart-line-option>
                  {option.name}: {option.label}
                </span>
              ))}
            </div>
          )}
          {view.purchaseOptions.map((option) => (
            <p key={option.id} className="text-xs font-medium text-foreground" data-cart-line-purchase-option data-part="line-details">
              {option.title}
            </p>
          ))}
          {(view.inputs.length > 0 || view.components.length > 0) && (
            <div className="text-xs text-muted-foreground" data-cart-line-properties data-part="line-details">
              <ul id={describedBy}>
                {view.inputs.map((input) => (
                  <li key={input.key} className="break-words" data-property-key={input.key}>
                    {/* A long answer folds to three lines, as on the cart page (lib/long-answer.ts). */}
                    {isLongAnswer(input.text) ? (
                      <span className="long-answer block" data-long-answer>
                        <span className="long-answer-text" data-answer-text>{input.text}</span>
                        <details className="long-answer-toggle">
                          <summary><span className="long-answer-more">{lineCopy.answerMore}</span><span className="long-answer-less">{lineCopy.answerLess}</span></summary>
                        </details>
                      </span>
                    ) : input.text}
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
              data-part="line-details"
            >
              {view.fulfilment === "ships-free" ? lineCopy.shipsFree : view.fulfilment === "digital" ? lineCopy.digital : lineCopy.service}
            </p>
          )}
        </>
      ),
      inputs: <div className="mt-1.5 grid gap-2" data-cart-line-inputs data-line-key={key} hidden data-part="line-inputs" />,
      // The apps' block for this line (`cart.line.after`), drawn by DrawerBuyerUi.
      target: <div className="mt-1.5 grid gap-2 text-sm" data-buyer-ui-target="cart.line.after" data-buyer-ui-line={key} data-buyer-ui-line-name={view.lineName} hidden />,
      issue: issues[key] && (
        <div className="space-y-1" role="alert" data-part="line-issue">
          <p className="text-sm font-medium text-destructive" data-cart-line-stock={view.stock && view.stock.state !== "at-limit" ? view.stock.state : undefined}>
            {view.stock && view.stock.state !== "at-limit" ? stockText : buyerApiErrorTextNow(issues[key]) ?? copy.fixToCheckout}
          </p>
          {issues[key].action === "reduce_quantity" && (issues[key].availableQuantity ?? 0) >= 1 ? (
            <button
              type="button"
              data-control="action"
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
              data-control="action"
              className="min-h-9 rounded-md border border-border px-2 text-sm font-medium text-foreground hover:bg-muted cursor-pointer"
              aria-label={lineCopy.removeFor(view.lineName)}
              aria-describedby={describedBy}
              onClick={remove}
            >
              {lineCopy.remove}
            </button>
          ) : null}
        </div>
      ),
      rule: (rules.lines[key] ?? []).map((rule, position) => (
        <p key={`${rule.code}:${position}`} className="text-sm font-medium text-destructive" role="alert" data-part="line-rule">
          {rule.message}
        </p>
      )),
      // Price: a free line struck then zero, as the cart page and the receipt draw it.
      price: (
        <div className="text-[12px] sm:text-sm font-bold text-foreground tabular-nums text-end shrink-0" data-part="line-price">
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
      ),
      quantity: (
        <div className="flex h-11 items-center justify-center overflow-hidden rounded-md bg-muted/50 ring-1 ring-inset ring-input sm:h-8" data-part="line-quantity">
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
      ),
      remove: (
        <button
          aria-label={lineCopy.removeFor(view.lineName)}
          aria-describedby={describedBy}
          onClick={remove}
          className="flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive active:scale-90 sm:h-8 sm:w-8 cursor-pointer"
          data-part="line-remove"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      ),
      limit: view.stock?.state === "at-limit" && (
        <p className="mt-1 text-xs text-muted-foreground" data-cart-line-limit data-part="line-limit">{stockText}</p>
      ),
    };
    const ring = key === addedKey ? "border-primary ring-1 ring-primary" : "border-border";
    if (plan.line) {
      return (
        <div key={key} data-line-key={key} aria-current={key === addedKey ? "true" : undefined} className={`relative min-w-0 bg-card p-2 sm:p-2.5 rounded-xl border shadow-sm ${ring}`} data-part="line">
          {drawerNodes(titleFirst(plan.line), parts)}
        </div>
      );
    }
    // The apps' block sits where the cart page's line puts it (`plan.lineTarget`): in the text column, or under the
    // whole line at its full width, from the image's edge.
    const below = plan.lineTarget === "below";
    return (
    <div
      key={key}
      data-line-key={key}
      aria-current={key === addedKey ? "true" : undefined}
      className={`group relative bg-card p-2 sm:p-2.5 rounded-xl border shadow-sm ${ring}`}
      data-part="line"
    >
      <div className="flex gap-2.5 sm:gap-3">
        {/* Compact Image */}
        {parts.image}

        <div className="flex flex-1 flex-col min-w-0 justify-between py-0">
          <div className="flex justify-between items-start gap-1.5">
            <div className="space-y-0.5 min-w-0 flex-1">
              {parts.title}
              {parts.details}
              {parts.inputs}
              {!below && parts.target}
              {parts.issue}
              {parts.rule}
            </div>

            {parts.price}
          </div>

          {/* Controls Row */}
          <div className="flex items-end justify-between mt-1">
            {parts.quantity}

            {parts.remove}
          </div>
          {parts.limit}
        </div>
      </div>
      {below && parts.target}
    </div>
    );
  };
  const lineList = (withRecommendations: boolean) => (
    // Mobile: gap-2 (tighter), Desktop: gap-3
    <div ref={linesRef} className="space-y-2 sm:space-y-3 pb-4" data-part="drawer-lines">
      {/* The apps' bulk actions on their line inputs, drawn by the line-input controls (only once a line takes one). */}
      {lineInputs.inputs.size > 0 && <div className="flex flex-wrap gap-2" data-cart-line-input-bulk hidden />}
      {lineInputs.inputs.size > 0 && <p className="sr-only" role="status" data-cart-line-input-status />}
      {lineEntries.map(line)}
      {withRecommendations && recommendationsPart}
    </div>
  );
  const undoPart = undo && (
    <p className="shrink-0 border-t border-border bg-card px-4 py-2 text-sm text-muted-foreground" role="status" data-part="drawer-undo">
      {undo.message} ·{" "}
      <button type="button" onClick={undoRemoval} className="font-medium text-foreground underline underline-offset-2 cursor-pointer">
        {copy.undo}
      </button>
    </p>
  );
  // Savings and offers the cart already qualifies for.
  const offers = cart.totalItems > 0 && discounts && discounts.offers.length > 0 && (
    <div className="shrink-0 space-y-1 border-t border-border bg-card px-3 py-2 text-sm sm:px-5" data-part="drawer-offers">
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
  );
  // The one order of money rows on every surface (lib/money-summary-order.ts): subtotal, the apps' add-ons, discounts, total.
  const summaryRows = cart.totalItems > 0 && (
    <>
      {(discountTotal > 0 || addOns.rows.length > 0) && (
        <div className="space-y-1 text-sm" data-part="drawer-summary">
          <div className="flex items-center justify-between gap-3 text-muted-foreground" data-cart-subtotal-row data-summary-row="subtotal">
            <span>{copy.subtotal}</span>
            <span className="tabular-nums" data-cart-subtotal>{formatMoney(fromMinor(addOns.itemsSubtotalMinor, moneyPlaces))}</span>
          </div>
          {/* The add-on rows, drawn into their box on every render by lib/add-on-row.ts (the one row markup): a row
              the buyer opened stays open as the drawer redraws, and one the buyer just added opens by itself. */}
          {addOns.rows.length > 0 && <div className="space-y-1" data-add-on-rows ref={(root) => {
            if (root) void addOnRowMarkup().then((rows) => rows.drawAddOnRows(root, addOns.rows, moneyPlaces, "drawer", addOnRowsShown, true));
          }} />}
          {discounts?.discounts.map((line, position) => ({ line, key: discountLineKey(line, position) })).filter(({ line }) => line.amount > 0).map(({ line, key }) => (
            <div key={key} className="flex justify-between gap-3 text-primary" data-discount-line={key} data-summary-row="discount">
              <span className="min-w-0">{formatDiscountLineLabel(copy.discount, line)}</span>
              <span className="shrink-0 tabular-nums" aria-busy={discountsPending || undefined}>{discountsPending ? copy.updating : `-${formatMoney(line.amount)}`}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
  const summaryTotal = cart.totalItems > 0 && (
    <>
      <div className="flex items-end justify-between gap-3" data-summary-row="total" data-part="drawer-total">
        <div className="text-sm text-muted-foreground">
          {/* Subtotal is the items alone wherever add-on rows show: the sum below them is the total. */}
          {discountTotal > 0 || addOns.rows.length > 0 ? copy.estimatedTotal : copy.subtotal}
        </div>
        <div className="text-lg font-semibold text-foreground tabular-nums sm:text-xl" data-cart-total aria-busy={discountsPending || undefined}>
          {discountsPending ? copy.updating : formatMoney(estimate.total)}
        </div>
      </div>
      {checkoutBlocked && (
        <p id="drawerCheckoutBlocked" className="text-sm text-destructive" role="status" data-part="drawer-blocked">{blockedText}</p>
      )}
    </>
  );
  const footerTarget = cart.totalItems > 0 && <DrawerBuyerUi blocks={buyerUi} onChange={recheck} lines={cart.items} lineInputs={lineInputs} />;
  const mainAction = cart.totalItems > 0 && (
    <>
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
          data-part="drawer-checkout"
        >
          <span>{label("drawer.checkout", copy.checkout)}</span>
          <ArrowRight className="h-4 w-4" />
        </button>
      ) : (
        <a
          href={checkoutHref}
          onClick={() => setCartOpen(false)}
          data-theme-component="button"
          data-theme-variant="default"
          data-theme-size="default"
          className={`${DRAWER_BUTTON} ${DRAWER_CHECKOUT} hover:bg-primary-hover cursor-pointer`}
          data-part="drawer-checkout"
        >
          <span>{label("drawer.checkout", copy.checkout)}</span>
          <ArrowRight className="h-4 w-4" />
        </a>
      )}
    </>
  );
  const secondaryActions = cart.totalItems > 0 && (
    <>
      <div className="flex items-center justify-between gap-3 px-1" data-part="drawer-actions">
        <a
          href={cartHref}
          onClick={() => setCartOpen(false)}
          className="inline-flex min-h-11 items-center text-sm font-medium text-foreground underline underline-offset-2 hover:text-primary sm:min-h-9"
          data-part="drawer-view-cart"
        >
          {label("drawer.viewCart", copy.viewCart)}
        </a>
        <button
          type="button"
          onClick={() => setCartOpen(false)}
          className="min-h-11 text-sm text-muted-foreground hover:text-foreground underline decoration-border underline-offset-2 cursor-pointer sm:min-h-9"
          data-part="drawer-continue"
        >
          {label("drawer.continue", copy.continueShopping)}
        </button>
      </div>
    </>
  );
  /**
   * The bottom group's rows above the total: the money rows and the apps' footer blocks (`cart_drawer.footer`), or
   * what a theme placed after its scrolling region. They end the scrolling region, at the sheet's foot while the lines
   * leave room (`mt-auto`) and after the lines once they do not, each block at its own height: the lines keep the
   * sheet, nothing is ever squeezed or clipped to a sliver, and only the total and Check out stay pinned under it.
   */
  const extrasBox = (children: React.ReactNode) => (
    <div className="mt-auto shrink-0 space-y-3 border-t border-border bg-card p-3 sm:space-y-4 sm:p-5 [&:not(:has(>:not([hidden])))]:hidden" data-drawer-extras>{children}</div>
  );
  /** The scrolling region between the drawer's fixed parts (its rows above the total last), with its fade when more lies below. */
  const scrollRegion = (children: React.ReactNode, key?: number, extras?: React.ReactNode) => (
    <div key={key} className="flex-1 relative overflow-hidden flex flex-col bg-muted/50" data-layout="scroll" data-part="drawer-scroll">
      <div
        ref={scrollRef}
        onScroll={checkScroll}
        className="flex flex-1 flex-col overflow-y-auto overflow-x-hidden overscroll-contain"
      >
        <div className="shrink-0 px-3 py-2 sm:px-5 sm:py-4">{children}</div>
        {extras}
      </div>

      {/* More below: a soft fade only, so nothing covers a price or a button. */}
      <div
        aria-hidden="true"
        className={`absolute bottom-0 inset-s-0 inset-e-0 h-6 bg-linear-to-t from-card to-transparent pointer-events-none transition-opacity duration-300 ${canScrollMore ? "opacity-100" : "opacity-0"}`}
      />
    </div>
  );
  /** The total and Check out with View cart, pinned at the sheet's foot. */
  const pinned = (children: React.ReactNode) => (
    <div className="shrink-0 z-30 space-y-3 border-t border-border bg-card p-3 shadow-[0_-4px_20px_-4px_rgba(0,0,0,0.05)] safe-area-pb sm:space-y-4 sm:p-5" data-layout="group" data-drawer-pinned>{children}</div>
  );
  /**
   * A theme's arrangement of the drawer, with the same guarantee as the host's: what it places after its scrolling region
   * ends that region (money rows, the apps' footer blocks, offers), and the total, Check out and View cart stay pinned.
   */
  const themeDrawer = (layout: readonly CartDrawerNode[]) => {
    const hosts = { target: (name: string) => (name === "cart_drawer.footer" ? footerTarget : null), scroll: scrollRegion };
    const at = layout.findIndex((node) => node.type === "layout" && node.layout === "scroll");
    const after = at < 0 ? [] : layout.slice(at + 1);
    const total = drawerHas(after, "summary");
    const buttons = drawerHas(after, "actions");
    if (at < 0 || cart.totalItems === 0 || (!total && !buttons && after.length === 0)) return drawerNodes(layout, pageParts, hosts);
    const extraParts = { ...pageParts, ...(total ? { summary: summaryRows } : {}), ...(buttons ? { actions: null } : {}) };
    const extras = extrasBox(drawerNodes(after, extraParts, hosts));
    return (
      <>
        {drawerNodes(layout.slice(0, at + 1), pageParts, { ...hosts, scroll: (children, key) => scrollRegion(children, key, extras) })}
        {(total || buttons) && pinned(<>{total && summaryTotal}{buttons && <>{mainAction}{secondaryActions}</>}</>)}
      </>
    );
  };
  const pageParts: Record<string, React.ReactNode> = {
    header,
    added,
    // The theme placed the suggestions on their own: the lines draw without them.
    lines: cart.totalItems === 0 ? emptyState : lineList(false),
    recommendations: cart.totalItems > 0 && recommendationsPart,
    undo: undoPart,
    offers,
    summary: <>{summaryRows}{summaryTotal}</>,
    actions: <>{mainAction}{secondaryActions}</>,
  };

  return (
    <Dialog.Root
      open={isOpen}
      onOpenChange={setCartOpen}
    >
      <Dialog.Portal>
      <Dialog.Overlay className={DRAWER_OVERLAY} />
      <Dialog.Content
        data-buyer-ui-scope=""
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
        data-private="cart-drawer"
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
          {...dragZone}
        >
          <div className="w-8 h-1 rounded-full bg-muted-foreground/30" />
          <ChevronDown className="w-3 h-3 text-muted-foreground animate-bounce mt-0.5 opacity-60" />
        </div>

        {plan.layout ? themeDrawer(plan.layout) : (
        <>
        {/* 1. HEADER */}
        {header}

        {added}

        {/* 2. CONTENT, ending in the rows above the total: the money rows and the apps' footer blocks. */}
        {scrollRegion(cart.totalItems === 0 ? emptyState : lineList(true), undefined, cart.totalItems > 0 && extrasBox(<>{summaryRows}{footerTarget}</>))}

        {undoPart}

        {offers}

        {/* 3. FOOTER: the total and Check out, pinned. */}
        {cart.totalItems > 0 && pinned(<>{summaryTotal}{mainAction}{secondaryActions}</>)}
        </>
        )}
      </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
