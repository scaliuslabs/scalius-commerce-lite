import { readBuyerAttributes, renderBuyerUi } from "@/lib/buyer-ui";
import { cartStore, hydrateCartFromStorage, removeOrderedLines } from "@/store/cart";
import type { CheckoutConfig, PaymentContext } from "./types";
import { registerGateway, getGateway } from "./registry";
import { codHandler } from "./handlers/cod";
import { resetStripePaymentElement, stripeHandler } from "./handlers/stripe";
import { createHostedGatewayHandler } from "./handlers/hosted";
import { createDeferredGatewayHandler } from "./handlers/deferred";
import { NET_TERMS_PAYMENT_METHOD } from "@scalius/shared/payment-terms";
import { formatPageNumber, formatStoreDateTime, pageLanguage } from "@/lib/store-time-zone";
import { formatMoney, DEFAULT_CURRENCY } from "@/lib/currency";
import { formatBdMobile } from "@scalius/shared/phone-input";
import { formatDiscountLineLabel } from "@scalius/shared/checkout-language-format";
import {
  ENGLISH_CHECKOUT_LANGUAGE_DATA,
  formatCheckoutLanguageText,
  type CheckoutLanguageData,
} from "@scalius/shared/checkout-language";
import type { PaymentResult } from "./types";
import {
  clearCheckoutTransferSession,
  clearCheckoutAttemptSession,
  clearHostedPaymentRecoverySession,
  matchesCheckoutRecoverySession,
  readHostedPaymentRecoverySession,
  readCheckoutPaymentSelection,
  writeCheckoutPaymentSelection,
  writeHostedPaymentRecoverySession,
  readReviewedCheckoutQuote,
  type HostedPaymentRecoverySession,
} from "./session-state";
import { checkoutAttemptRecoveryHref } from "./attempt-recovery";
import { inspectCheckoutRecovery } from "./recovery-status";
import {
  isDepositPaymentRequired,
  resolveCheckoutPaymentRequest,
} from "./payment-mode";
import type { CartRuleError, CartValidationIssue } from "../api/orders";
import { trackStorefrontAddPaymentInfoOnce } from "../analytics";
import { writeCartRepairState } from "../cart/repair-state";
import { getCheckoutStatusErrorMessage } from "./error-messages";
import {
  fetchAuthoritativeTaxQuote,
  TaxQuoteCartChangedError,
  TaxQuoteCartRulesError,
  TaxQuoteUnavailableError,
} from "./tax-quote-client";
import { discountLineKey, type CheckoutTaxQuote } from "./tax-quote-contract";
import {
  hideCheckoutLoadingOverlay,
  showCheckoutLoadingOverlay,
} from "./loading-overlay";
import { normalizeCheckoutRedirectUrl } from "./redirect-url";
import {
  getGatewayPresentation,
  isAppGatewayId,
  SSLCOMMERZ_GATEWAY_ID,
  sslcommerzPresentation,
  type GatewayPresentation,
} from "./gateway-presentation";
import { isGatewayEligibleForPaymentAmount } from "./gateway-amount-eligibility";
import { readLastPlacedOrderId, rememberSubmittedCart } from "./receipt-finalization";
import { cashOnDeliveryDescription, cashOnDeliveryLabel, type CheckoutDeliveryMode } from "./delivery-mode";
import { cartLinePropertyText } from "../cart/line-properties-view";
import { quoteAmountDue } from "./tax-quote-contract";
import { GIFT_CARD_PAYMENT_METHOD, giftCardHandler } from "./handlers/gift-card";
import {
  addStoredGiftCard,
  clearStoredGiftCards,
  giftCardCheckoutCopy,
  giftCardChipLabel,
  giftCardQuoteRefusal,
  giftCardRequestFields,
  readStoredGiftCards,
  removeStoredGiftCards,
  requestGiftCardApply,
  writeStoredGiftCards,
  MAX_GIFT_CARDS_PER_ORDER,
  type GiftCardCheckoutCopy,
  type StoredGiftCard,
} from "./gift-cards";
import { pagePath } from "@/lib/presence-url";
import { checkoutLineGroups, showsOrderLineGroupHeadings } from "../order-line-groups";

// COD, the card flow and a fully gift-card-paid order have their own handlers;
// every hosted gateway shares one, and so does every deferred (pay later) one.
registerGateway(codHandler);
registerGateway(stripeHandler);
registerGateway(giftCardHandler);

function isHostedMethod(methodId: string): boolean {
  return gateways.some((gateway) => gateway.id === methodId && gateway.flow === "hosted");
}

function providerLabelFor(methodId: string): string {
  const gateway = gateways.find((candidate) => candidate.id === methodId);
  const name = typeof gateway?.name === "string" ? gateway.name : methodId;
  return getGatewayPresentation(methodId, name).providerLabel ?? name;
}

function isDeferredMethod(methodId: string): boolean {
  return gateways.some((gateway) => gateway.id === methodId && gateway.flow === "deferred");
}

function handlerFor(methodId: string) {
  const existing = getGateway(methodId);
  if (existing) return existing;
  const handler = isHostedMethod(methodId)
    ? createHostedGatewayHandler(methodId, providerLabelFor(methodId))
    : isDeferredMethod(methodId)
    ? createDeferredGatewayHandler(methodId, providerLabelFor(methodId))
    : null;
  if (!handler) return undefined;
  registerGateway(handler);
  return handler;
}

/**
 * Pay later: "Net 30: pay by 19 November 2026", the date counted from today
 * in the store's time zone and the page's language. The order keeps the date
 * it is placed with (the receipt shows it).
 */
function deferredPresentation(
  gateway: CheckoutConfig["gateways"][number],
  presentation: GatewayPresentation,
): GatewayPresentation {
  const days = typeof gateway.dueInDays === "number" && gateway.dueInDays > 0 ? gateway.dueInDays : null;
  const language = pageLanguage();
  const description = days === null ? presentation.description : formatCheckoutLanguageText(checkoutCopy.invoicePaymentDescriptionText, {
    days: formatPageNumber(days, language),
    date: formatStoreDateTime(Date.now() + days * 86_400_000, language, { dateStyle: "long" }),
  });
  return {
    ...presentation,
    ...(gateway.id === NET_TERMS_PAYMENT_METHOD ? { buyerLabel: checkoutCopy.invoicePaymentText } : {}),
    description,
    markSrc: presentation.markSrc ?? "/payment-marks/invoice.svg",
    markKind: presentation.markSrc ? presentation.markKind : "icon",
    hosted: false,
  };
}

// ── State ────────────────────────────────────────────────────────────────────

let selectedMethod: string | null = null;
let checkoutData: Record<string, unknown> | null = null;
let checkoutConfig: CheckoutConfig | null = null;
let gateways: CheckoutConfig["gateways"] = [];
let authoritativeTaxQuote: CheckoutTaxQuote | null = null;
let isProcessing = false;
let selectionVersion = 0;
let retrySelection: {
  methodId: string;
  gateway: CheckoutConfig["gateways"][number];
} | null = null;
let samePageStripeRetry: {
  orderId: string;
  paymentRequest: ReturnType<typeof resolveCheckoutPaymentRequest>;
} | null = null;
let initVersion = 0;
let checkoutCopy: CheckoutLanguageData = { ...ENGLISH_CHECKOUT_LANGUAGE_DATA };
let giftCopy: GiftCardCheckoutCopy = giftCardCheckoutCopy();
/** Applied gift cards (apply handles, never codes), in the order the buyer added them. */
let appliedGiftCards: StoredGiftCard[] = [];
let giftCardBusy = false;
/** Apply was pressed before the total was ready. */
let giftCardApplyQueued = false;

// ── Helpers ──────────────────────────────────────────────────────────────────

function showError(msg: string): void {
  const el = document.getElementById("errorMsg");
  if (!el) return;
  el.textContent = msg;
  el.classList.remove("hidden");
  el.scrollIntoView?.({ behavior: "smooth", block: "center" });
}

function hideError(): void {
  const el = document.getElementById("errorMsg");
  el?.classList.add("hidden");
}

function getPaymentResultErrorMessage(result: PaymentResult): string {
  return getCheckoutStatusErrorMessage(
    result.status,
    result.error || checkoutCopy.paymentFailedText,
    checkoutCopy,
  );
}

function setPayButton(text: string, disabled = false): void {
  const btn = document.getElementById("payButton") as HTMLButtonElement | null;
  const span = document.getElementById("payButtonText");
  if (btn) btn.disabled = disabled || isProcessing;
  if (span) span.textContent = text;
}

function setPaymentControlsDisabled(disabled: boolean): void {
  document
    .querySelectorAll<HTMLButtonElement>(".payment-method-control")
    .forEach((control) => {
      control.disabled = disabled;
    });
}

function showReturnToCartAction(): void {
  const action = document.getElementById("checkoutRecoveryAction") as HTMLAnchorElement | null;
  if (action) {
    action.href = pagePath("/cart");
    action.textContent = checkoutCopy.returnToCartText;
    action.hidden = false;
  }
}

function hideReturnToCartAction(): void {
  const action = document.getElementById("checkoutRecoveryAction") as HTMLAnchorElement | null;
  if (action) action.hidden = true;
}

function parkPaymentControls(): void {
  document.getElementById("stripeSection")?.classList.add("hidden");
  resetStripePaymentElement();
  const parking = document.getElementById("paymentActionParking");
  for (const id of ["testModeNotice", "stripeSection", "paymentActionHost"]) {
    const element = document.getElementById(id);
    element?.classList.add("hidden");
    if (element && parking && element.parentElement !== parking) {
      parking.appendChild(element);
    }
  }
}

function clearCheckoutPresentation(): void {
  parkPaymentControls();
  const paymentMethods = document.getElementById("paymentMethods");
  paymentMethods?.replaceChildren();
  paymentMethods?.setAttribute("aria-busy", "false");
  document.getElementById("summaryDetails")?.replaceChildren();
  document.getElementById("orderSummary")?.classList.add("hidden");
  document.getElementById("giftCardSection")?.classList.add("hidden");
  setPaymentControlsDisabled(true);
}

function checkoutRecoveryHref(orderId: string, gateway: string): string {
  const params = new URLSearchParams({ orderId, payment: gateway });
  return pagePath(`/order-success?${params.toString()}`);
}

function showExistingCheckout(href: string | null): void {
  checkoutData = null;
  clearCheckoutPresentation();
  showError(checkoutCopy.checkoutAttemptConflictText);
  showReturnToCartAction();
  const action = document.getElementById("checkoutRecoveryAction") as HTMLAnchorElement | null;
  if (action && href) {
    action.href = href;
    action.textContent = checkoutCopy.reviewExistingCheckoutText;
  }
}

function endExpiredCheckout(): void {
  const checkoutId = checkoutData?.checkoutRequestId ?? checkoutData?.checkoutId;
  const recovery = readHostedPaymentRecoverySession();
  if (recovery?.checkoutId && recovery.checkoutId === checkoutId) clearHostedPaymentRecoverySession();
  clearCheckoutAttemptSession({ preserveFormDraft: true });
  checkoutData = null;
  clearCheckoutPresentation();
  showError(checkoutCopy.checkoutAttemptExpiredText);
  showReturnToCartAction();
}

/** Never send a new order while a previous commit still needs recovery. */
async function recoverExistingCheckout(recovery: HostedPaymentRecoverySession): Promise<boolean> {
  const checkoutId = checkoutData?.checkoutRequestId ?? checkoutData?.checkoutId;
  if (!recovery.checkoutId || recovery.checkoutId !== checkoutId) return false;
  const version = initVersion;
  const status = await inspectCheckoutRecovery(recovery);
  if (version !== initVersion) return true;
  const current = readHostedPaymentRecoverySession();
  if (JSON.stringify(current) !== JSON.stringify(recovery)) {
    if (current?.checkoutId === checkoutId) {
      showExistingCheckout(current.href);
      return true;
    }
    return false;
  }
  if (status === "expired") {
    clearHostedPaymentRecoverySession();
    const checkoutId = checkoutData?.checkoutRequestId ?? checkoutData?.checkoutId;
    if (checkoutId === recovery.checkoutId) {
      endExpiredCheckout();
      return true;
    }
    return false;
  }
  if (status === "active" && matchesCheckoutRecoverySession(recovery, checkoutData?.cartItems)) {
    window.location.replace(recovery.href);
  } else {
    showExistingCheckout(recovery.href);
  }
  return true;
}

function applySelectedMethodStyles(methodId: string | null): void {
  document.querySelectorAll(".payment-method-card").forEach((card) => {
    const el = card as HTMLElement;
    const isSelected = el.dataset.method === methodId;
    const control = el.querySelector<HTMLButtonElement>(".payment-method-control");
    const details = el.querySelector<HTMLElement>(".payment-method-details");
    if (control) {
      control.setAttribute("aria-checked", String(isSelected));
      if (methodId !== null) control.tabIndex = isSelected ? 0 : -1;
    }
    el.classList.toggle("border-primary", isSelected);
    el.classList.toggle("border-border", !isSelected);
    el.classList.toggle("shadow-sm", isSelected);
    el.querySelector(".check-dot")?.classList.toggle("hidden", !isSelected);
    details?.classList.toggle("hidden", !isSelected);
  });
}

function handlePaymentMethodKeyDown(event: KeyboardEvent): void {
  const keys = ["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"];
  if (!keys.includes(event.key)) return;

  const cards = Array.from(
    document.querySelectorAll<HTMLButtonElement>(".payment-method-control"),
  );
  const current = event.currentTarget as HTMLButtonElement;
  const currentIndex = cards.indexOf(current);
  if (currentIndex === -1 || cards.length === 0) return;

  event.preventDefault();
  let nextIndex: number;
  if (event.key === "Home") nextIndex = 0;
  else if (event.key === "End") nextIndex = cards.length - 1;
  else if (event.key === "ArrowDown" || event.key === "ArrowRight") {
    nextIndex = (currentIndex + 1) % cards.length;
  } else {
    nextIndex = (currentIndex - 1 + cards.length) % cards.length;
  }

  const next = cards[nextIndex];
  next?.focus();
  next?.click();
}

function appendProviderIdentity(
  parent: HTMLElement,
  presentation: GatewayPresentation,
): void {
  // One badge size for every method (Shopify's payment rows): a brand's
  // wordmark fills it, a plain icon sits in its middle.
  if (!presentation.markSrc) return;
  const identity = document.createElement("span");
  identity.className =
    "flex h-8 w-16 shrink-0 items-center justify-center rounded-md border border-border bg-white px-1.5";
  identity.setAttribute("aria-hidden", "true");
  const wordmark = presentation.markKind === "wordmark";
  const light = document.createElement("img");
  light.src = presentation.markSrc;
  light.alt = "";
  light.width = wordmark ? 52 : 20;
  light.height = 20;
  light.className = wordmark ? "h-5 w-full object-contain" : "h-5 w-5 object-contain";
  if (presentation.darkMarkSrc) light.classList.add("dark:hidden");
  identity.appendChild(light);
  if (presentation.darkMarkSrc) {
    const dark = document.createElement("img");
    dark.src = presentation.darkMarkSrc;
    dark.alt = "";
    dark.width = 20;
    dark.height = 20;
    dark.className = "hidden h-5 w-5 object-contain dark:block";
    identity.appendChild(dark);
  }
  parent.appendChild(identity);
}

function appendPaymentMethodContent(
  control: HTMLElement,
  presentation: GatewayPresentation,
  label: string,
  showRadio: boolean,
): void {
  const copy = document.createElement("div");
  copy.className = "min-w-0 flex-1";
  appendTextElement(copy, "p", "text-sm font-semibold text-foreground", label);
  if (presentation.description) {
    appendTextElement(
      copy,
      "p",
      "mt-0.5 text-xs leading-4 text-muted-foreground",
      presentation.description,
    );
  }
  control.appendChild(copy);

  appendProviderIdentity(control, presentation);

  if (showRadio) {
    const check = document.createElement("span");
    check.className =
      "method-check flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 border-input";
    check.setAttribute("aria-hidden", "true");
    const dot = document.createElement("span");
    dot.className = "check-dot hidden h-2.5 w-2.5 rounded-full bg-primary";
    check.appendChild(dot);
    control.appendChild(check);
  }

  control.setAttribute(
    "aria-label",
    [label, presentation.description, presentation.providerLabel]
      .filter(Boolean)
      .join(". "),
  );
}

function localizedGatewayPresentation(
  gatewayId: string,
  presentation: GatewayPresentation,
): GatewayPresentation {
  switch (gatewayId) {
    case "stripe":
      return {
        ...presentation,
        buyerLabel: checkoutCopy.creditDebitCardText,
        description: checkoutCopy.paySecurelyByCardText,
      };
    case "sslcommerz":
    case SSLCOMMERZ_GATEWAY_ID:
      return sslcommerzPresentation(presentation, checkoutCopy);
    case "cod": {
      // Gift cards paid part: cash on delivery collects only what is left.
      const due = authoritativeTaxQuote && hasGiftCardTender(authoritativeTaxQuote)
        ? quoteAmountDue(authoritativeTaxQuote).amountDue
        : null;
      return {
        ...presentation,
        // At the door, at the pickup counter, or when the service is done.
        buyerLabel: cashOnDeliveryLabel(quoteDeliveryMode(authoritativeTaxQuote), checkoutCopy),
        description: due !== null && authoritativeTaxQuote
          ? formatCheckoutLanguageText(giftCopy.giftCardPayOnDeliveryText, {
              amount: currencyFmt(due, authoritativeTaxQuote),
            })
          : cashOnDeliveryDescription(quoteDeliveryMode(authoritativeTaxQuote), checkoutCopy),
      };
    }
    case GIFT_CARD_PAYMENT_METHOD:
      return {
        ...presentation,
        buyerLabel: giftCopy.paidWithGiftCardText,
        description: giftCopy.paidWithGiftCardDescriptionText,
        hosted: false,
      };
    default:
      return presentation;
  }
}

function currencyFmt(amount: number | string, quote: CheckoutTaxQuote): string {
  return formatMoney(amount, { code: quote.currencyCode });
}

/** Gift cards pay part or all of this quote. */
function hasGiftCardTender(quote: CheckoutTaxQuote): boolean {
  return (quote.giftCardTenders?.length ?? 0) > 0;
}

/**
 * What the buyer pays now and how. With gift cards there is no deposit plan
 * (the API refuses the combination): the remainder is one balance payment.
 */
function checkoutPaymentRequestFor(
  config: CheckoutConfig,
  quote: CheckoutTaxQuote,
): { request: ReturnType<typeof resolveCheckoutPaymentRequest>; payableAmount: number } {
  if (hasGiftCardTender(quote)) {
    return { request: { paymentType: "balance" }, payableAmount: quoteAmountDue(quote).amountDue };
  }
  const request = resolveCheckoutPaymentRequest(config, quote.totalAmount);
  return {
    request,
    payableAmount: request.paymentType === "deposit" ? request.depositAmount : quote.totalAmount,
  };
}

/** The path the quote priced: no rate means nothing physical to deliver. */
function quoteDeliveryMode(quote: CheckoutTaxQuote | null): CheckoutDeliveryMode {
  if (!quote) return "delivery";
  if (!quote.shippingMethod) return "none";
  return quote.deliveryMethodKind === "pickup" ? "pickup" : "delivery";
}

function appendTextElement(
  parent: HTMLElement,
  tagName: keyof HTMLElementTagNameMap,
  className: string,
  text: string,
): HTMLElement {
  const element = document.createElement(tagName);
  element.className = className;
  element.textContent = text;
  parent.appendChild(element);
  return element;
}

function appendSummaryRow(
  parent: HTMLElement,
  label: string,
  value: string,
  className = "flex justify-between",
  /** The original amount, struck through before the value (a waived delivery fee). */
  struck?: string,
): HTMLElement {
  const row = document.createElement("div");
  row.className = className;
  appendTextElement(row, "span", "", label);
  const valueElement = appendTextElement(row, "span", "", value);
  if (struck) {
    const original = document.createElement("s");
    original.className = "me-1.5 text-muted-foreground";
    original.textContent = struck;
    valueElement.prepend(original);
  }
  parent.appendChild(row);
  return row;
}

function displayString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function appendOrderItems(
  parent: HTMLElement,
  quote: CheckoutTaxQuote,
): void {
  // The receipt's groups: a mixed order says which lines ship and which
  // arrive digitally ("Delivery", "Digital items"); one shipped group reads as before.
  const groups = checkoutLineGroups(quote.items, checkoutCopy);
  const headed = showsOrderLineGroupHeadings(groups);
  const section = document.createElement("div");
  section.className = "space-y-3 border-b border-border pb-3";
  for (const group of groups) {
    if (headed) appendTextElement(section, "p", "text-xs font-semibold text-muted-foreground", group.heading);
    const list = document.createElement("ul");
    list.className = "space-y-3";
    appendOrderItemRows(list, group.items, quote);
    section.appendChild(list);
  }
  parent.appendChild(section);
}

function appendOrderItemRows(
  list: HTMLElement,
  items: readonly CheckoutTaxQuote["items"][number][],
  quote: CheckoutTaxQuote,
): void {
  for (const item of items) {
    const row = document.createElement("li");
    row.className = "flex items-start justify-between gap-3";

    const itemCopy = document.createElement("div");
    itemCopy.className = "min-w-0";
    appendTextElement(
      itemCopy,
      "p",
      "font-medium leading-5 text-foreground",
      item.productName,
    );
    appendTextElement(
      itemCopy,
      "p",
      "text-xs leading-5 text-muted-foreground",
      [
        item.variantLabel,
        formatCheckoutLanguageText(checkoutCopy.quantityShortText, {
          quantity: item.quantity,
        }),
      ].filter(Boolean).join(" · "),
    );
    // How the line is bought, when an app's option ("Subscribe and save").
    if (item.purchaseOption) {
      appendTextElement(itemCopy, "p", "break-words text-xs font-medium leading-5 text-foreground", item.purchaseOption.title);
    }
    // Buyer inputs as the order will keep them: "Engraving: Anika (+৳200)",
    // then the apps' add-ons: "Add-on: Gift wrap (+৳50)".
    for (const property of [...item.properties, ...(item.adjustments ?? [])]) {
      appendTextElement(
        itemCopy,
        "p",
        "break-words text-xs leading-5 text-muted-foreground",
        cartLinePropertyText(property, checkoutCopy.customizationSurchargeText, quote.currencyCode),
      );
    }
    row.appendChild(itemCopy);

    appendTextElement(
      row,
      "span",
      "shrink-0 font-medium tabular-nums text-foreground",
      currencyFmt(item.unitPrice * item.quantity, quote),
    );
    list.appendChild(row);
  }
}

/** One review row (Contact / Ship to / Delivery) with a way back to change it. */
function appendReviewRow(parent: HTMLElement, label: string, lines: string[]): void {
  const values = lines.filter(Boolean);
  if (values.length === 0) return;
  const row = document.createElement("div");
  row.className = "flex items-start justify-between gap-3 py-2";
  const body = document.createElement("div");
  body.className = "min-w-0";
  appendTextElement(body, "p", "text-sm text-muted-foreground", label);
  for (const value of values) appendTextElement(body, "p", "break-words text-sm text-foreground", value);
  row.appendChild(body);
  const change = document.createElement("a");
  change.href = pagePath("/cart");
  change.className = "shrink-0 text-sm font-medium text-foreground underline underline-offset-2 hover:text-primary";
  change.textContent = checkoutCopy.changeText;
  change.setAttribute("aria-label", `${checkoutCopy.changeText}: ${label}`);
  row.appendChild(change);
  parent.appendChild(row);
}

/** Contact, ship-to and delivery, each with "Change", like Shopify's review block. */
function appendCheckoutReview(
  parent: HTMLElement,
  data: Record<string, unknown>,
  quote: CheckoutTaxQuote,
): void {
  const review = document.createElement("div");
  review.className = "divide-y divide-border border-t border-border pt-1";
  const phone = displayString(data.customerPhone);
  appendReviewRow(review, checkoutCopy.contactReviewText, [
    displayString(data.customerName) ?? "",
    phone ? formatBdMobile(phone) : "",
    displayString(data.customerEmail) ?? "",
  ]);
  const mode = quoteDeliveryMode(quote);
  const method = quote.shippingMethod;
  if (mode === "delivery") {
    const location = [...new Set([
      displayString(data.areaName),
      displayString(data.zoneName),
      displayString(data.cityName),
    ].filter((value): value is string => Boolean(value)))].join(", ");
    appendReviewRow(review, checkoutCopy.shipToReviewText, [
      displayString(data.shippingAddress) ?? "",
      location,
    ]);
  } else if (mode === "pickup") {
    // Where and when to collect, from the quote (the store's own words).
    appendReviewRow(review, checkoutCopy.pickupReviewText, [
      quote.pickup?.address ?? "",
      quote.pickup?.hours
        ? formatCheckoutLanguageText(checkoutCopy.pickupHoursText, { hours: quote.pickup.hours })
        : "",
    ]);
  } else {
    appendReviewRow(review, checkoutCopy.deliveryReviewText, [checkoutCopy.orderNoDeliveryText]);
  }
  if (method) {
    appendReviewRow(review, mode === "pickup" ? checkoutCopy.deliveryModePickupText : checkoutCopy.deliveryReviewText, [
      method.name,
      method.description ?? "",
      method.feeWaived
        ? formatCheckoutLanguageText(checkoutCopy.waivedShippingFeeText, {
            fee: currencyFmt(method.baseAmountMinor / (10 ** quote.decimalPlaces), quote),
          })
        : "",
    ]);
  }
  if (review.childElementCount > 0) parent.appendChild(review);
}

type CheckoutCartFreshnessResult = {
  valid: boolean;
  issues: CartValidationIssue[];
  /** A store app's rules that block the order; the cart says them in the app's words. */
  ruleErrors?: CartRuleError[];
  message: string;
};

function checkoutFreshnessMessage(
  issues: CartValidationIssue[],
): string {
  if (issues.length > 0) {
    return issues.length === 1
      ? checkoutCopy.oneCartItemChangedText
      : formatCheckoutLanguageText(checkoutCopy.cartItemsChangedText, {
          count: issues.length,
        });
  }
  return checkoutCopy.cartAvailabilityReviewText;
}

function redirectToCartForRepair(result: CheckoutCartFreshnessResult): void {
  // Session storage, never the URL: the messages and lines are buyer content.
  writeCartRepairState({
    source: "checkout",
    message: result.message,
    issues: result.issues,
    ...(result.ruleErrors?.length ? { ruleErrors: result.ruleErrors } : {}),
  });
  window.location.href = pagePath("/cart?checkoutIssues=1");
}

/**
 * A quote refused for the cart itself (a changed line, or a store app's rule)
 * is fixed on the cart page: true when the buyer is sent there.
 */
function redirectForCartRefusal(error: unknown): boolean {
  if (error instanceof TaxQuoteCartChangedError) {
    redirectToCartForRepair({
      valid: false,
      issues: error.issues,
      message: checkoutFreshnessMessage(error.issues),
    });
    return true;
  }
  if (error instanceof TaxQuoteCartRulesError) {
    redirectToCartForRepair({
      valid: false,
      issues: [],
      ruleErrors: error.ruleErrors,
      message: checkoutCopy.cartRulesBlockedText,
    });
    return true;
  }
  return false;
}

function readCheckoutAttemptId(data: Record<string, unknown>): string | undefined {
  const value = data.checkoutRequestId ?? data.checkoutId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function trackAddPaymentInfoForSelection(methodId: string): void {
  if (!checkoutData || !authoritativeTaxQuote) return;

  const contents = authoritativeTaxQuote.items.map((item) => ({
    id: item.variantId,
    quantity: item.quantity,
    item_price: item.unitPrice,
  }));
  const contentIds = contents.map((item) => item.id).filter(Boolean);

  trackStorefrontAddPaymentInfoOnce({
    checkoutId: readCheckoutAttemptId(checkoutData),
    paymentMethod: methodId,
    content_ids: contentIds,
    contents,
    currency: authoritativeTaxQuote.currencyCode,
    value: authoritativeTaxQuote.totalAmount,
  });
}

// ── Load checkout data ────────────────────────────────────────────────────────

function loadCheckoutData(): boolean {
  const fail = (message: string) => {
    clearCheckoutPresentation();
    showError(message);
    showReturnToCartAction();
    clearCheckoutTransferSession();
    return false;
  };

  let raw: string | null;
  let gwRaw: string | null;
  try {
    raw = sessionStorage.getItem("scalius_checkout_data");
    gwRaw = sessionStorage.getItem("scalius_checkout_gateways");
  } catch {
    return fail(checkoutCopy.checkoutDetailsUnreadableText);
  }

  if (!raw) {
    // Back or reload after the order: point to it instead of a dead end.
    const placedOrderId = readLastPlacedOrderId();
    if (placedOrderId) {
      clearCheckoutPresentation();
      showError(checkoutCopy.orderAlreadyPlacedText);
      const action = document.getElementById("checkoutRecoveryAction") as HTMLAnchorElement | null;
      if (action) {
        action.href = pagePath(`/order-success?${new URLSearchParams({ orderId: placedOrderId })}`);
        action.textContent = checkoutCopy.viewOrderText;
        action.hidden = false;
      }
      return false;
    }
    return fail(
      checkoutCopy.checkoutDetailsMissingText,
    );
  }

  try {
    checkoutData = JSON.parse(raw);
    const transferGateways = gwRaw ? JSON.parse(gwRaw) : checkoutConfig!.gateways;
    const freshGatewayMap = new Map(
      checkoutConfig!.gateways.map((gateway) => [gateway.id, gateway]),
    );
    gateways = Array.isArray(transferGateways)
      ? transferGateways
          .map((gateway) => {
            const id = typeof gateway?.id === "string" ? gateway.id : "";
            return freshGatewayMap.get(id);
          })
          .filter((gateway): gateway is CheckoutConfig["gateways"][number] => Boolean(gateway))
      : checkoutConfig!.gateways;
    if (gwRaw && gateways.length === 0) {
      sessionStorage.removeItem("scalius_checkout_gateways");
      gateways = checkoutConfig!.gateways;
    }
    return true;
  } catch {
    return fail(
      checkoutCopy.checkoutDetailsUnreadableText,
    );
  }
}

// ── Render order summary ──────────────────────────────────────────────────────

export function renderOrderSummaryDetails(
  details: HTMLElement,
  data: Record<string, unknown>,
  config: CheckoutConfig,
  quote: CheckoutTaxQuote,
): void {
  details.replaceChildren();
  appendOrderItems(details, quote);
  appendSummaryRow(details, checkoutCopy.subtotalText, currencyFmt(quote.subtotalAmount, quote));
  // Delivery savings show on the delivery line ("৳80 Free (CODE)"), never as a discount line.
  const deliveryDiscounts = quote.discounts.filter(({ shippingAmount }) => shippingAmount > 0);
  const deliveryCharged = Math.max(
    0,
    quote.shippingAmount - deliveryDiscounts.reduce((total, { shippingAmount }) => total + shippingAmount, 0),
  );
  // Nothing physical: no delivery line at all.
  if (quote.shippingMethod) {
    const deliveryFee = quote.shippingMethod.baseAmountMinor / 10 ** quote.decimalPlaces;
    appendSummaryRow(
      details,
      // A pickup order has no shipping: the row names the pickup.
      quoteDeliveryMode(quote) === "pickup" ? checkoutCopy.deliveryModePickupText : checkoutCopy.shippingText,
      [
        deliveryCharged === 0 ? checkoutCopy.freeText : currencyFmt(deliveryCharged, quote),
        deliveryDiscounts.length > 0 ? ` (${deliveryDiscounts.map(({ code, title }) => code ?? title).join(", ")})` : "",
      ].join(""),
      undefined,
      deliveryCharged < deliveryFee ? currencyFmt(deliveryFee, quote) : undefined,
    );
  }
  // One line per discount on the items, named as the buyer knows it (a store
  // app's discount too: it has no promotion, so its key is the app and position).
  quote.discounts.forEach((discount, position) => {
    if (discount.amount <= 0) return;
    const row = appendSummaryRow(
      details,
      formatDiscountLineLabel(checkoutCopy.discountText, discount),
      `-${currencyFmt(discount.amount, quote)}`,
      "flex justify-between gap-3 text-primary",
    );
    row.dataset.discountLine = discountLineKey(discount, position);
  });
  if (quote.taxMinor > 0) {
    appendSummaryRow(
      details,
      `${quote.displayLabel}${quote.pricesIncludeTax ? ` (${checkoutCopy.includedText})` : ""}`,
      currencyFmt(quote.taxAmount, quote),
    );
  }
  appendSummaryRow(
    details,
    checkoutCopy.totalText,
    currencyFmt(quote.totalAmount, quote),
    "flex justify-between font-bold text-foreground pt-2 border-t border-border mt-2 mb-2",
  );

  // Gift cards are payment, not a discount: they follow the total, then what is left.
  if (hasGiftCardTender(quote)) {
    for (const tender of quote.giftCardTenders ?? []) {
      appendSummaryRow(
        details,
        formatCheckoutLanguageText(giftCopy.giftCardLineText, { card: giftCardChipLabel(tender.last4) }),
        `-${currencyFmt(tender.applied, quote)}`,
        "flex justify-between gap-3 text-primary",
      );
    }
    appendSummaryRow(
      details,
      giftCopy.amountDueText,
      currencyFmt(quoteAmountDue(quote).amountDue, quote),
      "flex justify-between rounded-lg border border-primary/20 bg-primary/10 p-2 font-semibold text-primary-ink",
    );
  } else if (isDepositPaymentRequired(config, quote.totalAmount)) {
    const advance = config.partialPaymentAmount;
    const balance = quote.totalAmount - advance;
    appendSummaryRow(
      details,
      checkoutCopy.dueNowText,
      currencyFmt(advance, quote),
      "flex justify-between rounded-lg border border-primary/20 bg-primary/10 p-2 font-semibold text-primary-ink",
    );
    appendSummaryRow(
      details,
      checkoutCopy.dueOnDeliveryText,
      currencyFmt(balance, quote),
      "flex justify-between px-2 text-xs text-muted-foreground",
    );
  }

  appendCheckoutReview(details, data, quote);
}

/**
 * The summary of the page's quote. Before it arrives, the quote the cart
 * page showed draws it at once (`provisional`, marked busy); the page's own
 * quote then redraws it, and only that quote enables payment.
 */
function renderSummary(quote: CheckoutTaxQuote | null = authoritativeTaxQuote, provisional = false): void {
  if (!checkoutData || !checkoutConfig || !quote) return;
  const section = document.getElementById("orderSummary");
  const details = document.getElementById("summaryDetails");
  if (!section || !details) return;

  renderOrderSummaryDetails(details, checkoutData, checkoutConfig, quote);

  const mobileTotal = document.getElementById("orderSummaryToggleTotal");
  if (mobileTotal) {
    // With gift cards the collapsed summary shows what is left to pay.
    mobileTotal.textContent = currencyFmt(quoteAmountDue(quote).amountDue, quote);
  }

  section.setAttribute("aria-busy", String(provisional));
  section.classList.remove("hidden");
}

function installOrderSummaryToggle(): void {
  const toggle = document.getElementById("orderSummaryToggle") as HTMLButtonElement | null;
  const panel = document.getElementById("summaryPanel");
  const chevron = document.getElementById("orderSummaryChevron");
  if (!toggle || !panel || toggle.dataset.bound === "true") return;
  toggle.dataset.bound = "true";
  toggle.addEventListener("click", () => {
    const expanded = toggle.getAttribute("aria-expanded") === "true";
    toggle.setAttribute("aria-expanded", String(!expanded));
    panel.classList.toggle("hidden", expanded);
    chevron?.classList.toggle("rotate-180", !expanded);
  });
}

// ── Render payment method cards ───────────────────────────────────────────────

function eligibleCheckoutGateways(): CheckoutConfig["gateways"] {
  if (!checkoutConfig || !authoritativeTaxQuote) return [];
  const currentConfig = checkoutConfig;
  const currentQuote = authoritativeTaxQuote;
  const { payableAmount } = checkoutPaymentRequestFor(currentConfig, currentQuote);
  // The server says which methods this cart may use (no cash on delivery
  // when nothing is shipped, collected or performed).
  const allowed = currentQuote.allowedPaymentMethods;
  // Gift cards cover everything: the only method is placing the order.
  if (hasGiftCardTender(currentQuote) && quoteAmountDue(currentQuote).amountDueMinor === 0) {
    return allowed.includes(GIFT_CARD_PAYMENT_METHOD)
      ? [{ id: GIFT_CARD_PAYMENT_METHOD, flow: "cod", name: giftCopy.paidWithGiftCardText }]
      : [];
  }
  const eligible = gateways.filter(
    (gateway) => (
      gateway.id !== GIFT_CARD_PAYMENT_METHOD
      && !(currentConfig.partialPaymentEnabled && gateway.id === "cod")
      && allowed.includes(gateway.id)
      && isGatewayEligibleForPaymentAmount(
        gateway,
        payableAmount,
        currentQuote.currencyCode,
      )
    ),
  );
  // A store app changed the methods for this order: only the ones it lists,
  // in its order (never one this page would not offer).
  const quoted = currentQuote.paymentMethods;
  if (!quoted) return eligible;
  const byId = new Map(eligible.map((gateway) => [gateway.id, gateway]));
  return quoted.flatMap(({ id }) => {
    const gateway = byId.get(id);
    return gateway ? [gateway] : [];
  });
}

/**
 * The name a store app gave a method on this quote, when it differs from the
 * store's own (the same name keeps the page's localized wording).
 */
function quotedPaymentMethodName(gateway: CheckoutConfig["gateways"][number]): string | null {
  const quoted = authoritativeTaxQuote?.paymentMethods?.find(({ id }) => id === gateway.id);
  if (!quoted) return null;
  const ownName = typeof gateway.name === "string" ? gateway.name.trim() : "";
  return quoted.name !== ownName ? quoted.name : null;
}

function paymentActionLabel(methodId: string): string {
  if (!checkoutConfig || !authoritativeTaxQuote) return checkoutCopy.continueText;
  if (methodId === "cod" || methodId === GIFT_CARD_PAYMENT_METHOD || isDeferredMethod(methodId)) return checkoutCopy.placeOrderText;
  if (isHostedMethod(methodId)) {
    return formatCheckoutLanguageText(checkoutCopy.continueToProviderText, {
      provider: providerLabelFor(methodId),
    });
  }

  // The card charges the amount due (after gift cards), never the full total.
  const { request: paymentRequest, payableAmount } = checkoutPaymentRequestFor(
    checkoutConfig,
    authoritativeTaxQuote,
  );
  const formatted = currencyFmt(payableAmount, authoritativeTaxQuote);
  return paymentRequest.paymentType === "deposit"
    ? formatCheckoutLanguageText(checkoutCopy.payAmountNowText, { amount: formatted })
    : formatCheckoutLanguageText(checkoutCopy.payAmountText, { amount: formatted });
}

/**
 * An app's wallet (bKash, Nagad, …) opens the provider's own page: the buyer
 * is told they are leaving the store to pay, and, when the page is slow to
 * open on a phone network, that it is still on its way (so they don't pay
 * twice). Built-in gateways keep their own copy.
 */
function appRedirectOverlay(methodId: string) {
  const provider = { provider: providerLabelFor(methodId) };
  return {
    title: formatCheckoutLanguageText(checkoutCopy.openingProviderTitle, provider),
    message: formatCheckoutLanguageText(checkoutCopy.leavingToPayMessage, provider),
    slowMessage: formatCheckoutLanguageText(checkoutCopy.redirectSlowMessage, provider),
  };
}

function hostedRedirectMessage(methodId: string): string | null {
  return isHostedMethod(methodId)
    ? formatCheckoutLanguageText(checkoutCopy.providerRedirectText, { provider: providerLabelFor(methodId) })
    : null;
}

async function renderGateways(): Promise<void> {
  if (!checkoutConfig || !checkoutData || !authoritativeTaxQuote) return;
  const container = document.getElementById("paymentMethods");
  if (!container) return;
  parkPaymentControls();
  const stripeSection = document.getElementById("stripeSection");
  container.innerHTML = "";
  const eligibleGateways = eligibleCheckoutGateways();
  const singleMethod = eligibleGateways.length === 1;
  container.setAttribute("role", singleMethod ? "group" : "radiogroup");
  container.setAttribute(
    "aria-label",
    singleMethod ? checkoutCopy.paymentMethodText : checkoutCopy.paymentMethodsText,
  );

  if (checkoutConfig.unavailable || eligibleGateways.length === 0) {
    container.setAttribute("aria-busy", "false");
    showError(
      checkoutConfig.unavailableMessage ||
        checkoutCopy.noPaymentMethodsText,
    );
    setPayButton(checkoutCopy.checkoutUnavailableText, true);
    return;
  }

  eligibleGateways.forEach((gw, index) => {
    const handler = handlerFor(gw.id);
    const fallbackLabel =
      (gw as { name?: string }).name || handler?.meta.label || gw.id;
    const known = getGatewayPresentation(gw.id, fallbackLabel);
    const localized = gw.flow === "deferred"
      ? deferredPresentation(gw, known)
      : localizedGatewayPresentation(gw.id, known);
    const quotedName = quotedPaymentMethodName(gw);
    const presentation = quotedName ? { ...localized, buyerLabel: quotedName } : localized;
    const card = document.createElement("div");
    card.className =
      "payment-method-card overflow-hidden rounded-xl border border-border bg-card transition-colors";
    card.dataset.method = gw.id;

    const control = singleMethod
      ? document.createElement("div")
      : document.createElement("button");
    control.className = singleMethod
      ? "flex min-h-16 w-full items-center gap-3 px-4 py-3 text-start"
      : "payment-method-control flex min-h-16 w-full appearance-none items-center gap-3 px-4 py-3 text-start transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-wait";
    if (control instanceof HTMLButtonElement) {
      control.type = "button";
      control.id = `payment-method-${gw.id}`;
      control.setAttribute("role", "radio");
      control.setAttribute("aria-checked", "false");
      // A radio may not carry aria-expanded; aria-controls names the revealed details.
      control.setAttribute("aria-controls", `payment-details-${gw.id}`);
      control.tabIndex = index === 0 ? 0 : -1;
      control.addEventListener("click", () => void selectMethod(gw.id, gw));
      control.addEventListener("keydown", handlePaymentMethodKeyDown);
    }
    appendPaymentMethodContent(
      control,
      presentation,
      presentation.buyerLabel,
      !singleMethod,
    );
    card.appendChild(control);

    const details = document.createElement("div");
    details.id = `payment-details-${gw.id}`;
    details.className =
      "payment-method-details hidden space-y-3 border-t border-border px-4 py-4";
    if (!singleMethod) {
      details.setAttribute("aria-labelledby", `payment-method-${gw.id}`);
    }
    if (gw.id === "stripe" && stripeSection) details.appendChild(stripeSection);
    card.appendChild(details);
    container.appendChild(card);
  });

  container.setAttribute("aria-busy", "false");
  const restoredMethod = readCheckoutPaymentSelection();
  const initialGateway =
    eligibleGateways.find((gateway) => gateway.id === restoredMethod) ??
    eligibleGateways.find(
      (gateway) => gateway.id === checkoutConfig?.activeDefaultMethod,
    ) ?? eligibleGateways[0];
  if (initialGateway) await selectMethod(initialGateway.id, initialGateway);
}

// ── Gateway selection ─────────────────────────────────────────────────────────

async function selectMethod(
  methodId: string,
  gw: CheckoutConfig["gateways"][number],
): Promise<void> {
  if (isProcessing) return;
  if (methodId !== "stripe") samePageStripeRetry = null;
  const selectionId = ++selectionVersion;
  retrySelection = null;
  selectedMethod = null;
  applySelectedMethodStyles(methodId);
  setPayButton(checkoutCopy.preparingPaymentText, true);
  hideError();
  const handler = handlerFor(methodId);
  const stripeSection = document.getElementById("stripeSection");
  const actionHost = document.getElementById("paymentActionHost");
  const details = document.querySelector<HTMLElement>(
    `.payment-method-card[data-method="${CSS.escape(methodId)}"] .payment-method-details`,
  );
  const testNotice = document.getElementById("testModeNotice");
  const redirectNote = document.getElementById("hostedRedirectNote");
  if (!handler || !details) {
    showError(checkoutCopy.paymentMethodUnavailableMessage);
    setPayButton(checkoutCopy.paymentMethodUnavailableText, true);
    return;
  }

  // Courier rates may charge differently for cash collection. Review that
  // quote before enabling the selected payment method.
  const courierCod = methodId === "cod" || Boolean(checkoutConfig && authoritativeTaxQuote
    && checkoutPaymentRequestFor(checkoutConfig, authoritativeTaxQuote).request.paymentType === "deposit");
  if (checkoutData && authoritativeTaxQuote?.shippingRateToken && (checkoutData.cod === true) !== courierCod) {
    try {
      const quote = await fetchAuthoritativeTaxQuote({ ...checkoutData, cod: courierCod, shippingRateToken: undefined });
      if (selectionId !== selectionVersion) return;
      checkoutData = { ...checkoutData, cod: courierCod };
      adoptQuote(quote);
      renderSummary(quote);
      if (!quote.allowedPaymentMethods.includes(methodId)) {
        showError(checkoutCopy.paymentMethodUnavailableMessage);
        setPayButton(checkoutCopy.paymentMethodUnavailableText, true);
        return;
      }
    } catch {
      if (selectionId !== selectionVersion) return;
      retrySelection = { methodId, gateway: gw };
      showError(checkoutCopy.taxVerificationFailedText);
      setPayButton(checkoutCopy.retryPaymentFormText, false);
      return;
    }
  }

  if (testNotice && testNotice.parentElement !== details) details.prepend(testNotice);
  if (actionHost) {
    if (actionHost.parentElement !== details) details.appendChild(actionHost);
    actionHost.classList.remove("hidden");
  }
  testNotice?.classList.toggle(
    "hidden",
    methodId === "cod" || gw.flow === "deferred" || gw.testMode !== true,
  );
  const redirectMessage = hostedRedirectMessage(methodId);
  if (redirectNote) {
    redirectNote.textContent = redirectMessage ?? "";
    redirectNote.classList.toggle("hidden", !redirectMessage);
  }

  if (methodId === "stripe") {
    stripeSection?.classList.remove("hidden");
  } else {
    stripeSection?.classList.add("hidden");
  }

  // Delegate to handler's onSelect if present
  if (handler?.onSelect) {
    try {
      // Pass publishable key via container dataset for Stripe
      const stripeContainer = document.getElementById("stripeSection");
      if (stripeContainer && gw.publishableKey) {
        stripeContainer.dataset.publishableKey = gw.publishableKey as string;
      }
      await handler.onSelect(stripeContainer || document.body);
      if (selectionId !== selectionVersion) return;
    } catch (err: unknown) {
      if (selectionId !== selectionVersion) return;
      showError(err instanceof Error ? err.message : String(err));
      selectedMethod = null;
      retrySelection = { methodId, gateway: gw };
      setPayButton(checkoutCopy.retryPaymentFormText, false);
      return;
    }
  }

  if (selectionId !== selectionVersion) return;
  selectedMethod = methodId;
  writeCheckoutPaymentSelection(methodId);
  applySelectedMethodStyles(methodId);

  setPayButton(
    paymentActionLabel(methodId),
    handler.isReady ? !handler.isReady() : false,
  );
}

// ── Process payment ───────────────────────────────────────────────────────────

async function processPayment(): Promise<void> {
  if (
    !selectedMethod ||
    isProcessing ||
    !checkoutData ||
    !checkoutConfig ||
    !authoritativeTaxQuote
  ) return;

  for (const control of document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("[data-buyer-attribute]")) {
    if (!control.reportValidity()) return;
  }
  const processingMethod = selectedMethod;
  const existingRecovery = readHostedPaymentRecoverySession();
  const recoveryMatches = matchesCheckoutRecoverySession(
    existingRecovery,
    checkoutData.cartItems,
  );
  const stripeRetry =
    processingMethod === "stripe" &&
    recoveryMatches &&
    existingRecovery?.gateway === "stripe" &&
    samePageStripeRetry?.orderId === existingRecovery.orderId
      ? samePageStripeRetry
      : null;
  if (existingRecovery && !stripeRetry) {
    isProcessing = true;
    const recovered = await recoverExistingCheckout(existingRecovery);
    isProcessing = false;
    if (recovered) return;
  }
  if (giftCardBusy) return;
  const submittedCheckoutData: Record<string, unknown> = { ...checkoutData, attributes: readBuyerAttributes() };
  const submitInitVersion = initVersion;
  isProcessing = true;
  setGiftCardControlsDisabled(true);
  setPaymentControlsDisabled(true);
  hideError();
  setPayButton(checkoutCopy.processingText, true);
  trackAddPaymentInfoForSelection(processingMethod);

  showCheckoutLoadingOverlay(
    processingMethod === "cod" || processingMethod === GIFT_CARD_PAYMENT_METHOD
      ? {
          title: checkoutCopy.placingOrderTitle,
          message: checkoutCopy.placingOrderMessage,
        }
      : isAppGatewayId(processingMethod)
        ? appRedirectOverlay(processingMethod)
        : {
            title: checkoutCopy.openingSecurePaymentTitle,
            message: checkoutCopy.openingSecurePaymentMessage,
          },
  );

  const handler = handlerFor(processingMethod);
  if (!handler) {
    hideCheckoutLoadingOverlay();
    showError(checkoutCopy.unknownPaymentMethodText);
    isProcessing = false;
    setPaymentControlsDisabled(false);
    setPayButton(checkoutCopy.paymentMethodUnavailableText, true);
    return;
  }

  let navigationCommitted = false;
  try {
    const totalAmount = authoritativeTaxQuote.totalAmount;
    const { request: paymentRequest, payableAmount: advanceAmount } = checkoutPaymentRequestFor(
      checkoutConfig,
      authoritativeTaxQuote,
    );
    const giftCardsPaidPart = hasGiftCardTender(authoritativeTaxQuote);

    const ctx: PaymentContext = {
      checkoutData: submittedCheckoutData,
      config: checkoutConfig,
      orderId: stripeRetry?.orderId ?? "",
      totalAmount,
      advanceAmount,
      // Gift cards paid part: the gateway collects the balance, never a deposit.
      paymentType: stripeRetry?.paymentRequest.paymentType ?? (giftCardsPaidPart ? "balance" : undefined),
      depositAmount: stripeRetry?.paymentRequest.paymentType === "deposit"
        ? stripeRetry.paymentRequest.depositAmount
        : undefined,
      replaceExistingAttempt: stripeRetry ? false : undefined,
      currencySymbol: (window as unknown as Record<string, string>).__CURRENCY_SYMBOL__ || DEFAULT_CURRENCY.symbol,
      onOrderCreated: (orderId, gateway) => {
        if (submitInitVersion !== initVersion) return;
        if (typeof submittedCheckoutData.cartItems === "string") rememberSubmittedCart(submittedCheckoutData.cartItems);
        // The order holds the cards now; their handles are spent.
        if (giftCardsPaidPart) forgetAppliedGiftCards();
        if (gateway === "stripe") samePageStripeRetry = { orderId, paymentRequest };
        writeHostedPaymentRecoverySession(
          checkoutRecoveryHref(orderId, gateway),
          submittedCheckoutData,
          gateway,
        );
      },
    };

    // Each provider request has its own bounded network deadline. Do not race
    // the complete flow against a UI-only timer: an abandoned promise can
    // still create an order after the controls have been re-enabled.
    const result = await handler.processPayment(ctx);
    if (submitInitVersion !== initVersion) return;

    if (result.success && result.redirectUrl) {
      const redirectUrl = normalizeCheckoutRedirectUrl(
        result.redirectUrl,
        window.location.origin,
      );
      if (!redirectUrl) {
        throw new Error(checkoutCopy.unsafeRedirectText);
      }
      writeHostedPaymentRecoverySession(
        result.hostedPaymentRecoveryUrl ?? redirectUrl,
        submittedCheckoutData,
        processingMethod,
      );
      // An order placed here (cash, gift cards, an invoice): its lines leave the
      // cart now, so back or reload never shows the cart just ordered (buyer QA m9).
      // A gateway's page still has the payment to take: the receipt settles that cart.
      const target = new URL(redirectUrl, window.location.origin);
      if (target.pathname.endsWith("/order-success") && !target.searchParams.has("payment") && typeof submittedCheckoutData.cartItems === "string") {
        try {
          removeOrderedLines(JSON.parse(submittedCheckoutData.cartItems) as Record<string, { variantId?: unknown; quantity?: unknown }>);
        } catch {
          // A malformed snapshot leaves the cart to the receipt.
        }
      }
      navigationCommitted = true;
      window.location.replace(redirectUrl);
      return;
    }

    if (!result.success) {
      if (result.errorCode === "checkout_attempt_expired") {
        hideCheckoutLoadingOverlay();
        endExpiredCheckout();
        return;
      }
      if (result.errorCode === "checkout_attempt_conflict") {
        hideCheckoutLoadingOverlay();
        // Do not associate the changed cart with the old order or overwrite its
        // submitted snapshot. The receipt requires its own cookie or account.
        const href = checkoutAttemptRecoveryHref(result.details);
        if (href) {
          const reference = result.details as { paymentMethod?: string | null };
          writeHostedPaymentRecoverySession(href, {
            checkoutId: submittedCheckoutData.checkoutRequestId ?? submittedCheckoutData.checkoutId,
          }, reference.paymentMethod ?? processingMethod);
        }
        showExistingCheckout(href);
        return;
      }
      if (result.cartIssues && result.cartIssues.length > 0) {
        hideCheckoutLoadingOverlay({ restoreFocus: false });
        redirectToCartForRepair({
          valid: false,
          issues: result.cartIssues,
          message: result.error || checkoutFreshnessMessage(result.cartIssues),
        });
        return;
      }
      if (result.refusal?.reason === "cart_rules") {
        hideCheckoutLoadingOverlay({ restoreFocus: false });
        redirectToCartForRepair({
          valid: false,
          issues: [],
          ruleErrors: result.refusal.ruleErrors,
          message: checkoutCopy.cartRulesBlockedText,
        });
        return;
      }
      if (result.refusal?.reason === "payment_method_unavailable") {
        // A store app hid this method for the order: the current quote lists
        // the methods left, and the page selects one of them.
        hideCheckoutLoadingOverlay();
        let refreshed: Awaited<ReturnType<typeof fetchQuoteForCheckout>>;
        try {
          refreshed = await fetchQuoteForCheckout();
        } catch (error) {
          if (redirectForCartRefusal(error)) return;
          showReturnToCartAction();
          throw error;
        }
        adoptQuote(refreshed.quote);
        showGiftCardMessage(refreshed.notice);
        renderSummary();
        isProcessing = false;
        await renderGateways();
        showError(checkoutCopy.paymentMethodUnavailableMessage);
        return;
      }

      if (result.errorCode === "storefront_checkout_quote_conflict") {
        hideCheckoutLoadingOverlay();
        let refreshed: Awaited<ReturnType<typeof fetchQuoteForCheckout>>;
        try {
          refreshed = await fetchQuoteForCheckout();
        } catch (error) {
          if (redirectForCartRefusal(error)) return;
          showReturnToCartAction();
          throw error;
        }
        adoptQuote(refreshed.quote);
        showGiftCardMessage(refreshed.notice);
        renderSummary();
        isProcessing = false;
        await renderGateways();
        showError(checkoutCopy.totalChangedReviewText);
        return;
      }
      if (result.errorCode === "gift_card_changed") {
        // A card's balance, status or expiry moved since the quote: price it again.
        hideCheckoutLoadingOverlay();
        isProcessing = false;
        const requoted = await requoteForGiftCards();
        if (requoted) showError(giftCopy.giftCardChangedText);
        return;
      }
      if (result.errorCode === "validation_error") showReturnToCartAction();
      throw new Error(getPaymentResultErrorMessage(result));
    }
  } catch (err: unknown) {
    if (submitInitVersion !== initVersion) return;
    hideCheckoutLoadingOverlay();
    showError(err instanceof Error ? err.message : checkoutCopy.genericErrorText);
    isProcessing = false;
    setPaymentControlsDisabled(false);
    setPayButton(
      paymentActionLabel(processingMethod),
      handler.isReady ? !handler.isReady() : false,
    );
  } finally {
    if (!navigationCommitted && submitInitVersion === initVersion) {
      isProcessing = false;
      setPaymentControlsDisabled(!checkoutData);
      setGiftCardControlsDisabled(!checkoutData);
    }
  }
}

// ── Gift cards (tender) ───────────────────────────────────────────────────────
//
// The code goes to the same-origin proxy once (POST body); from then on the
// page holds only the apply handle, in sessionStorage. Every quote and the
// order carry the handles; the quote says what each card pays.

/** The applied handles ride along with every quote and the order. */
function syncGiftCardsIntoCheckoutData(): void {
  if (!checkoutData) return;
  const next: Record<string, unknown> = { ...checkoutData };
  const { giftCards } = giftCardRequestFields(appliedGiftCards);
  if (giftCards) next.giftCards = giftCards;
  else {
    delete next.giftCards;
    delete next.expectedAmountDueMinor;
  }
  checkoutData = next;
}

function forgetAppliedGiftCards(): void {
  appliedGiftCards = [];
  clearStoredGiftCards();
  syncGiftCardsIntoCheckoutData();
}

function setGiftCardControlsDisabled(disabled: boolean): void {
  const busy = disabled || giftCardBusy || isProcessing;
  const input = document.getElementById("giftCardCode") as HTMLInputElement | null;
  const button = document.getElementById("giftCardApply") as HTMLButtonElement | null;
  if (input) input.disabled = busy;
  if (button) button.disabled = busy;
  document
    .querySelectorAll<HTMLButtonElement>("[data-gift-card-remove]")
    .forEach((remove) => {
      remove.disabled = busy;
    });
}

function showGiftCardMessage(text: string | null, tone: "error" | "status" = "error"): void {
  const message = document.getElementById("giftCardMessage");
  if (!message) return;
  message.textContent = text ?? "";
  message.classList.toggle("hidden", !text);
  message.classList.toggle("text-destructive", tone === "error");
  message.classList.toggle("text-muted-foreground", tone === "status");
}

function renderGiftCardChips(): void {
  const list = document.getElementById("giftCardChips");
  if (!list) return;
  list.replaceChildren();
  const quote = authoritativeTaxQuote;
  const tenders = new Map((quote?.giftCardTenders ?? []).map((tender) => [tender.handle, tender]));
  for (const card of appliedGiftCards) {
    const chip = document.createElement("li");
    chip.className =
      "inline-flex min-h-9 items-center gap-1 rounded-full border border-border bg-muted/50 py-0.5 ps-3 pe-0.5 text-sm";
    const label = giftCardChipLabel(card.last4);
    const tender = tenders.get(card.handle);
    appendTextElement(
      chip,
      "span",
      "font-medium tabular-nums text-foreground",
      tender && quote ? `${label} −${currencyFmt(tender.applied, quote)}` : label,
    );
    const remove = document.createElement("button");
    remove.type = "button";
    remove.dataset.giftCardRemove = "true";
    remove.className =
      "inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
    remove.setAttribute(
      "aria-label",
      formatCheckoutLanguageText(giftCopy.giftCardRemoveText, { card: label }),
    );
    remove.textContent = "×";
    remove.addEventListener("click", () => void removeGiftCard(card.handle));
    chip.appendChild(remove);
    list.appendChild(chip);
  }
  setGiftCardControlsDisabled(false);
}

/** One quote with the current handles. */
function quoteWithGiftCards(): Promise<CheckoutTaxQuote> {
  syncGiftCardsIntoCheckoutData();
  checkoutData!.attributes = readBuyerAttributes();
  return fetchAuthoritativeTaxQuote(checkoutData!);
}

/**
 * The authoritative quote for the page. A card the quote refused leaves the
 * list and the page quotes once more without it, so the fingerprint the order
 * carries matches the handles it sends. When gift cards cannot be priced at
 * all, checkout goes on without them rather than dead-ending.
 */
async function fetchQuoteForCheckout(): Promise<{ quote: CheckoutTaxQuote; notice: string | null }> {
  let quote: CheckoutTaxQuote;
  try {
    quote = await quoteWithGiftCards();
  } catch (error) {
    if (appliedGiftCards.length === 0 || !(error instanceof TaxQuoteUnavailableError)) throw error;
    forgetAppliedGiftCards();
    return { quote: await quoteWithGiftCards(), notice: giftCopy.giftCardUnavailableText };
  }
  const refusal = giftCardQuoteRefusal(appliedGiftCards, quote.giftCardIssues, giftCopy);
  if (refusal.dropped.length > 0) {
    appliedGiftCards = refusal.remaining;
    writeStoredGiftCards(appliedGiftCards);
    quote = await quoteWithGiftCards();
  }
  return { quote, notice: refusal.message };
}

/** Makes a quote the page's truth: the order carries its fingerprint and amount due. */
function adoptQuote(quote: CheckoutTaxQuote): void {
  authoritativeTaxQuote = quote;
  renderBuyerUi(quote.buyerUi, { onChange: async () => {
    if (!checkoutData || isProcessing) return;
    hydrateCartFromStorage();
    const cart = cartStore.get();
    checkoutData = {
      ...checkoutData,
      ...(Object.keys(cart.items).length > 0 ? {
        cartItems: JSON.stringify(cart.items), discountCodes: cart.discountCodes,
      } : {}),
      attributes: readBuyerAttributes(),
    };
    await requoteForGiftCards();
  } });
  const next: Record<string, unknown> = {
    ...checkoutData!,
    expectedQuoteFingerprint: quote.quoteFingerprint,
    shippingRateToken: quote.shippingRateToken ?? null,
  };
  if (appliedGiftCards.length > 0) next.expectedAmountDueMinor = quoteAmountDue(quote).amountDueMinor;
  else delete next.expectedAmountDueMinor;
  checkoutData = next;
  document.getElementById("giftCardSection")?.classList.remove("hidden");
  renderGiftCardChips();
}

let requoteSequence = 0;

/** Prices the order again after the cards or app fields changed. */
async function requoteForGiftCards(): Promise<boolean> {
  if (!checkoutData) return false;
  const currentInitVersion = initVersion;
  const sequence = ++requoteSequence;
  setPaymentControlsDisabled(true);
  setPayButton(checkoutCopy.preparingPaymentText, true);
  let result: Awaited<ReturnType<typeof fetchQuoteForCheckout>>;
  try {
    result = await fetchQuoteForCheckout();
  } catch (error) {
    if (currentInitVersion !== initVersion || sequence !== requoteSequence) return false;
    if (redirectForCartRefusal(error)) return false;
    showReturnToCartAction();
    showError(error instanceof Error ? error.message : checkoutCopy.totalVerificationFailedText);
    setPayButton(checkoutCopy.totalUnavailableText, true);
    renderGiftCardChips();
    return false;
  }
  if (currentInitVersion !== initVersion || sequence !== requoteSequence) return false;
  adoptQuote(result.quote);
  showGiftCardMessage(result.notice);
  renderSummary();
  await renderGateways();
  return true;
}

async function removeGiftCard(handle: string): Promise<void> {
  if (giftCardBusy || isProcessing) return;
  const removed = appliedGiftCards.find((card) => card.handle === handle);
  if (!removed) return;
  giftCardBusy = true;
  setGiftCardControlsDisabled(true);
  appliedGiftCards = removeStoredGiftCards(appliedGiftCards, [handle]);
  try {
    hideError();
    const requoted = await requoteForGiftCards();
    if (requoted) {
      showGiftCardMessage(
        formatCheckoutLanguageText(giftCopy.giftCardRemovedText, { card: giftCardChipLabel(removed.last4) }),
        "status",
      );
    }
  } finally {
    giftCardBusy = false;
    setGiftCardControlsDisabled(false);
    document.getElementById("giftCardCode")?.focus();
  }
}

const GIFT_CARD_FAILURE_COPY = {
  invalid: "giftCardEnterCodeText",
  unusable: "giftCardUnusableText",
  rate_limited: "giftCardRateLimitedText",
  unavailable: "giftCardUnavailableText",
} as const satisfies Record<string, keyof GiftCardCheckoutCopy>;

async function applyGiftCardFromForm(event?: SubmitEvent): Promise<void> {
  // The code never becomes a navigation: the form's own POST is the no-script path.
  event?.preventDefault();
  if (giftCardBusy || isProcessing) return;
  const input = document.getElementById("giftCardCode") as HTMLInputElement | null;
  const button = document.getElementById("giftCardApply") as HTMLButtonElement | null;
  if (!checkoutData || !authoritativeTaxQuote) {
    // Pressed while the total is still loading: applied as soon as it is
    // ready (`applyQueuedGiftCard`), never dropped (buyer QA M4).
    giftCardApplyQueued = true;
    if (button) button.textContent = giftCopy.giftCardApplyingText;
    return;
  }
  if (!input) return;
  if (appliedGiftCards.length >= MAX_GIFT_CARDS_PER_ORDER) {
    showGiftCardMessage(giftCopy.giftCardLimitText);
    return;
  }

  giftCardBusy = true;
  setGiftCardControlsDisabled(true);
  if (button) button.textContent = giftCopy.giftCardApplyingText;
  showGiftCardMessage(null);
  try {
    const outcome = await requestGiftCardApply(input.value);
    if (!outcome.ok) {
      showGiftCardMessage(giftCopy[GIFT_CARD_FAILURE_COPY[outcome.reason]]);
      input.setAttribute("aria-invalid", "true");
      return;
    }
    input.value = "";
    input.removeAttribute("aria-invalid");
    const added = addStoredGiftCard(appliedGiftCards, outcome.card);
    if (!added.ok) {
      showGiftCardMessage(giftCopy.giftCardLimitText);
      return;
    }
    appliedGiftCards = added.cards;
    hideError();
    const requoted = await requoteForGiftCards();
    if (requoted && appliedGiftCards.some(({ handle }) => handle === outcome.card.handle)) {
      showGiftCardMessage(
        formatCheckoutLanguageText(giftCopy.giftCardAppliedText, { card: giftCardChipLabel(outcome.card.last4) }),
        "status",
      );
    }
  } finally {
    giftCardBusy = false;
    if (button) button.textContent = giftCopy.giftCardApplyText;
    setGiftCardControlsDisabled(false);
  }
}

function installGiftCardForm(): void {
  const form = document.getElementById("giftCardForm") as HTMLFormElement | null;
  if (!form || form.dataset.bound === "true") return;
  form.dataset.bound = "true";
  form.addEventListener("submit", (event) => void applyGiftCardFromForm(event as SubmitEvent));
}

/** Apply pressed before the total was ready (or before this script loaded): apply it now. */
function applyQueuedGiftCard(ready: boolean): void {
  const form = document.getElementById("giftCardForm") as HTMLFormElement | null;
  const queued = giftCardApplyQueued || form?.dataset.pending === "true";
  giftCardApplyQueued = false;
  if (form) delete form.dataset.pending;
  if (!queued) return;
  if (ready) {
    void applyGiftCardFromForm();
    return;
  }
  // No total to apply it to: the page says why; the code stays in the field.
  const button = document.getElementById("giftCardApply");
  if (button) button.textContent = giftCopy.giftCardApplyText;
}

// ── Init ──────────────────────────────────────────────────────────────────────

export async function initCheckoutPage(): Promise<void> {
  const currentInitVersion = ++initVersion;
  selectedMethod = null;
  checkoutData = null;
  gateways = [];
  authoritativeTaxQuote = null;
  isProcessing = false;
  retrySelection = null;
  samePageStripeRetry = null;
  selectionVersion += 1;
  checkoutConfig = (window as unknown as Record<string, CheckoutConfig>).__CHECKOUT_CONFIG__;
  const activeLanguage = window.__CHECKOUT_LANGUAGE__ as
    | { languageData?: Partial<CheckoutLanguageData> }
    | undefined;
  checkoutCopy = {
    ...ENGLISH_CHECKOUT_LANGUAGE_DATA,
    ...(activeLanguage?.languageData ?? {}),
  };
  giftCopy = giftCardCheckoutCopy(activeLanguage?.languageData);
  appliedGiftCards = readStoredGiftCards();
  giftCardBusy = false;
  if (!checkoutConfig) return;

  hideReturnToCartAction();
  installOrderSummaryToggle();
  installGiftCardForm();

  if (!loadCheckoutData()) return;

  const existingRecovery = readHostedPaymentRecoverySession();
  if (existingRecovery && await recoverExistingCheckout(existingRecovery)) return;
  // The summary the buyer just reviewed, at once; the page's quote follows.
  renderSummary(readReviewedCheckoutQuote(checkoutData!.expectedQuoteFingerprint), true);

  try {
    const { quote, notice } = await fetchQuoteForCheckout();
    if (currentInitVersion !== initVersion) return;
    adoptQuote(quote);
    showGiftCardMessage(notice);
  } catch (error) {
    if (redirectForCartRefusal(error)) return;
    applyQueuedGiftCard(false);
    clearCheckoutPresentation();
    showReturnToCartAction();
    showError(
      error instanceof Error
        ? error.message
        : checkoutCopy.totalVerificationFailedText,
    );
    setPayButton(checkoutCopy.totalUnavailableText, true);
    return;
  }

  renderSummary();
  await renderGateways();
  if (currentInitVersion !== initVersion) return;
  applyQueuedGiftCard(true);

  const payBtn = document.getElementById("payButton");
  if (payBtn && payBtn.dataset.checkoutBound !== "true") {
    payBtn.dataset.checkoutBound = "true";
    payBtn.addEventListener("click", () => {
      if (retrySelection) {
        const { methodId, gateway } = retrySelection;
        void selectMethod(methodId, gateway);
        return;
      }
      void processPayment();
    });
  }
}

export async function resumeCheckoutPageFromHistory(): Promise<void> {
  hideCheckoutLoadingOverlay({ restoreFocus: false });
  isProcessing = false;
  retrySelection = null;
  selectionVersion += 1;
  setPaymentControlsDisabled(false);
  resetStripePaymentElement();
  await initCheckoutPage();
}
