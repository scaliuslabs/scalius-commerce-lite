import type { CheckoutConfig, PaymentContext } from "./types";
import { registerGateway, getGateway } from "./registry";
import { codHandler } from "./handlers/cod";
import { resetStripePaymentElement, stripeHandler } from "./handlers/stripe";
import { sslcommerzHandler } from "./handlers/sslcommerz";
import { polarHandler } from "./handlers/polar";
import { formatPrice, DEFAULT_CURRENCY } from "@scalius/shared/currency";
import {
  ENGLISH_CHECKOUT_LANGUAGE_DATA,
  formatCheckoutLanguageText,
  type CheckoutLanguageData,
} from "@scalius/shared/checkout-language";
import type { PaymentResult } from "./types";
import {
  clearCheckoutTransferSession,
  matchesCheckoutRecoverySession,
  readHostedPaymentRecoverySession,
  readCheckoutPaymentSelection,
  writeCheckoutPaymentSelection,
  writeHostedPaymentRecoverySession,
} from "./session-state";
import {
  isDepositPaymentRequired,
  resolveCheckoutPaymentRequest,
} from "./payment-mode";
import type { CartValidationIssue } from "../api/orders";
import { trackStorefrontAddPaymentInfoOnce } from "../analytics";
import { writeCartRepairState } from "../cart/repair-state";
import { getCheckoutStatusErrorMessage } from "./error-messages";
import {
  fetchAuthoritativeTaxQuote,
  TaxQuoteCartChangedError,
} from "./tax-quote-client";
import type { CheckoutTaxQuote } from "./tax-quote-contract";
import { isGatewayTestMode } from "./gateway-environment";
import {
  hideCheckoutLoadingOverlay,
  showCheckoutLoadingOverlay,
} from "./loading-overlay";
import { normalizeCheckoutRedirectUrl } from "./redirect-url";
import {
  getGatewayPresentation,
  type GatewayPresentation,
} from "./gateway-presentation";
import { isGatewayEligibleForPaymentAmount } from "./gateway-amount-eligibility";

// Register all built-in gateway handlers
registerGateway(codHandler);
registerGateway(stripeHandler);
registerGateway(sslcommerzHandler);
registerGateway(polarHandler);

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
let initVersion = 0;
let checkoutCopy: CheckoutLanguageData = { ...ENGLISH_CHECKOUT_LANGUAGE_DATA };

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

export function getPaymentResultRecovery(result: PaymentResult): {
  message: string;
  buttonText: string;
} | null {
  if (result.errorCode !== "CUSTOMER_SESSION_STALE") return null;

  return {
    message: checkoutCopy.sessionExpiredText,
    buttonText: checkoutCopy.continueAsGuestText,
  };
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

function setReturnToCartButton(): void {
  const btn = document.getElementById("payButton") as HTMLButtonElement | null;
  const span = document.getElementById("payButtonText");
  if (!btn) return;
  btn.disabled = false;
  btn.onclick = () => {
    window.location.href = "/cart";
  };
  if (span) span.textContent = checkoutCopy.returnToCartText;
}

function clearCheckoutPresentation(): void {
  resetStripePaymentElement();
  document.getElementById("paymentMethods")?.replaceChildren();
  document.getElementById("summaryDetails")?.replaceChildren();
  document.getElementById("orderSummary")?.classList.add("hidden");
  document.getElementById("stripeSection")?.classList.add("hidden");
  setPaymentControlsDisabled(true);
}

function checkoutRecoveryHref(orderId: string, gateway: string): string {
  const params = new URLSearchParams({ orderId, payment: gateway });
  return `/order-success?${params.toString()}`;
}

function applySelectedMethodStyles(methodId: string | null): void {
  document.querySelectorAll(".payment-method-card").forEach((card) => {
    const el = card as HTMLElement;
    const isSelected = el.dataset.method === methodId;
    const control = el.querySelector<HTMLButtonElement>(".payment-method-control");
    const details = el.querySelector<HTMLElement>(".payment-method-details");
    if (control) {
      control.setAttribute("aria-checked", String(isSelected));
      control.setAttribute("aria-expanded", String(isSelected));
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
  gatewayId: string,
): void {
  const identity = document.createElement("span");
  identity.className =
    "flex h-8 min-w-12 shrink-0 items-center justify-center gap-1.5 rounded-md border border-border bg-background px-2";
  identity.setAttribute("aria-hidden", "true");

  if (presentation.markSrc) {
    const light = document.createElement("img");
    light.src = presentation.markSrc;
    light.alt = "";
    light.width = presentation.markKind === "wordmark" ? 72 : 20;
    light.height = 24;
    light.className = presentation.markKind === "wordmark"
      ? "h-4 max-w-18 object-contain"
      : "h-5 w-5 object-contain";
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
    if (presentation.markKind === "icon" && presentation.providerLabel) {
      appendTextElement(
        identity,
        "span",
        "text-[11px] font-semibold text-foreground",
        presentation.providerLabel,
      );
    }
  } else {
    appendTextElement(
      identity,
      "span",
      "text-[11px] font-bold uppercase tracking-wide text-foreground",
      gatewayId === "cod" ? "COD" : gatewayId.slice(0, 8),
    );
  }
  parent.appendChild(identity);
}

function appendPaymentMethodContent(
  control: HTMLElement,
  presentation: GatewayPresentation,
  gatewayId: string,
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

  appendProviderIdentity(
    control,
    presentation,
    gatewayId,
  );

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
      return {
        ...presentation,
        buyerLabel: checkoutCopy.onlinePaymentText,
        description: checkoutCopy.onlinePaymentDescriptionText,
      };
    case "polar":
      return {
        ...presentation,
        buyerLabel: checkoutCopy.cardOrWalletText,
        description: formatCheckoutLanguageText(
          checkoutCopy.completeWithProviderText,
          { provider: presentation.providerLabel ?? "Polar" },
        ),
      };
    case "cod":
      return {
        ...presentation,
        buyerLabel: checkoutCopy.cashOnDeliveryText,
        description: checkoutCopy.payOnDeliveryText,
      };
    default:
      return presentation;
  }
}

function currencyFmt(amount: number | string, quote: CheckoutTaxQuote): string {
  const currentCode = window.__CURRENCY_CODE__;
  const symbol = currentCode === quote.currencyCode
    ? window.__CURRENCY_SYMBOL__
    : `${quote.currencyCode} `;
  return formatPrice(amount, {
    code: quote.currencyCode,
    precision: quote.decimalPlaces,
    ...(symbol ? { symbol } : {}),
  });
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
): void {
  const row = document.createElement("div");
  row.className = className;
  appendTextElement(row, "span", "", label);
  appendTextElement(row, "span", "", value);
  parent.appendChild(row);
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
  const list = document.createElement("ul");
  list.className = "space-y-3 border-b border-border pb-3";

  for (const item of quote.items) {
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
    row.appendChild(itemCopy);

    appendTextElement(
      row,
      "span",
      "shrink-0 font-medium tabular-nums text-foreground",
      currencyFmt(item.unitPrice * item.quantity, quote),
    );
    list.appendChild(row);
  }

  parent.appendChild(list);
}

function appendDeliverySummary(
  parent: HTMLElement,
  data: Record<string, unknown>,
): void {
  const delivery = document.createElement("div");
  delivery.className = "border-t border-border pt-3 text-xs leading-5 text-muted-foreground";

  const methodName = displayString(data.shippingMethodName);
  if (methodName) {
    appendTextElement(
      delivery,
      "p",
      "font-semibold text-foreground",
      methodName,
    );
  }

  const recipient = [
    displayString(data.customerName),
    displayString(data.customerPhone),
  ].filter((value): value is string => Boolean(value)).join(" · ");
  if (recipient) appendTextElement(delivery, "p", "", recipient);

  const address = displayString(data.shippingAddress);
  if (address) appendTextElement(delivery, "p", "", address);

  const location = [
    displayString(data.areaName),
    displayString(data.zoneName),
    displayString(data.cityName),
  ].filter((value): value is string => Boolean(value));
  const uniqueLocation = [...new Set(location)].join(", ");
  if (uniqueLocation) appendTextElement(delivery, "p", "", uniqueLocation);

  if (delivery.childElementCount > 0) parent.appendChild(delivery);
}

type CheckoutCartFreshnessResult = {
  valid: boolean;
  issues: CartValidationIssue[];
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
  writeCartRepairState({
    source: "checkout",
    message: result.message,
    issues: result.issues,
  });
  window.location.href = "/cart?checkoutIssues=1";
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
    setReturnToCartButton();
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
  appendSummaryRow(
    details,
    checkoutCopy.shippingText,
    quote.shippingMinor === 0
      ? checkoutCopy.freeText
      : currencyFmt(quote.shippingAmount, quote),
  );
  if (quote.discountMinor > 0) {
    appendSummaryRow(
      details,
      checkoutCopy.discountText,
      `-${currencyFmt(quote.discountAmount, quote)}`,
      "flex justify-between text-primary",
    );
  }
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

  if (isDepositPaymentRequired(config, quote.totalAmount)) {
    const advance = config.partialPaymentAmount;
    const balance = quote.totalAmount - advance;
    appendSummaryRow(
      details,
      checkoutCopy.dueNowText,
      currencyFmt(advance, quote),
      "flex justify-between rounded-lg border border-primary/20 bg-primary/10 p-2 font-semibold text-primary",
    );
    appendSummaryRow(
      details,
      checkoutCopy.dueOnDeliveryText,
      currencyFmt(balance, quote),
      "flex justify-between px-2 text-xs text-muted-foreground",
    );
  }

  appendDeliverySummary(details, data);
}

function renderSummary(): void {
  if (!checkoutData || !checkoutConfig || !authoritativeTaxQuote) return;
  const section = document.getElementById("orderSummary");
  const details = document.getElementById("summaryDetails");
  if (!section || !details) return;

  renderOrderSummaryDetails(
    details,
    checkoutData,
    checkoutConfig,
    authoritativeTaxQuote,
  );

  const mobileTotal = document.getElementById("orderSummaryToggleTotal");
  if (mobileTotal) {
    mobileTotal.textContent = currencyFmt(
      authoritativeTaxQuote.totalAmount,
      authoritativeTaxQuote,
    );
  }

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
  const paymentRequest = resolveCheckoutPaymentRequest(
    currentConfig,
    currentQuote.totalAmount,
  );
  const payableAmount = paymentRequest.paymentType === "deposit"
    ? paymentRequest.depositAmount
    : currentQuote.totalAmount;
  return gateways.filter(
    (gateway) => (
      !(currentConfig.partialPaymentEnabled && gateway.id === "cod")
      && isGatewayEligibleForPaymentAmount(
        gateway,
        payableAmount,
        currentQuote.currencyCode,
      )
    ),
  );
}

function paymentActionLabel(methodId: string): string {
  if (!checkoutConfig || !authoritativeTaxQuote) return checkoutCopy.continueText;
  if (methodId === "cod") return checkoutCopy.placeOrderText;
  if (methodId === "sslcommerz" || methodId === "polar") {
    return formatCheckoutLanguageText(checkoutCopy.continueToProviderText, {
      provider: methodId === "sslcommerz" ? "SSLCommerz" : "Polar",
    });
  }

  const paymentRequest = resolveCheckoutPaymentRequest(
    checkoutConfig,
    authoritativeTaxQuote.totalAmount,
  );
  const amount = paymentRequest.paymentType === "deposit"
    ? paymentRequest.depositAmount
    : authoritativeTaxQuote.totalAmount;
  const formatted = currencyFmt(amount, authoritativeTaxQuote);
  return paymentRequest.paymentType === "deposit"
    ? formatCheckoutLanguageText(checkoutCopy.payAmountNowText, { amount: formatted })
    : formatCheckoutLanguageText(checkoutCopy.payAmountText, { amount: formatted });
}

function hostedRedirectMessage(methodId: string): string | null {
  const provider = methodId === "sslcommerz"
    ? "SSLCommerz"
    : methodId === "polar"
      ? "Polar"
      : null;
  return provider
    ? formatCheckoutLanguageText(checkoutCopy.providerRedirectText, { provider })
    : null;
}

function renderGateways(): void {
  if (!checkoutConfig || !checkoutData || !authoritativeTaxQuote) return;
  const container = document.getElementById("paymentMethods");
  if (!container) return;
  const actionHost = document.getElementById("paymentActionHost");
  const actionParking = document.getElementById("paymentActionParking");
  if (actionHost && actionParking && actionHost.parentElement !== actionParking) {
    actionHost.classList.add("hidden");
    actionParking.appendChild(actionHost);
  }
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
    const handler = getGateway(gw.id);
    const fallbackLabel =
      (gw as { name?: string }).name || handler?.meta.label || gw.id;
    const presentation = localizedGatewayPresentation(
      gw.id,
      getGatewayPresentation(gw.id, fallbackLabel),
    );
    const card = document.createElement("div");
    card.className =
      "payment-method-card overflow-hidden rounded-xl border border-border bg-card transition-colors";
    card.dataset.method = gw.id;

    const control = singleMethod
      ? document.createElement("div")
      : document.createElement("button");
    control.className = singleMethod
      ? "flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left"
      : "payment-method-control flex min-h-16 w-full appearance-none items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-wait";
    if (control instanceof HTMLButtonElement) {
      control.type = "button";
      control.id = `payment-method-${gw.id}`;
      control.setAttribute("role", "radio");
      control.setAttribute("aria-checked", "false");
      control.setAttribute("aria-expanded", "false");
      control.setAttribute("aria-controls", `payment-details-${gw.id}`);
      control.tabIndex = index === 0 ? 0 : -1;
      control.addEventListener("click", () => void selectMethod(gw.id, gw));
      control.addEventListener("keydown", handlePaymentMethodKeyDown);
    }
    appendPaymentMethodContent(
      control,
      presentation,
      gw.id,
      presentation.buyerLabel,
      !singleMethod,
    );
    card.appendChild(control);

    const details = document.createElement("div");
    details.id = `payment-details-${gw.id}`;
    details.className =
      "payment-method-details hidden border-t border-border px-4 py-4";
    if (!singleMethod) {
      details.setAttribute("aria-labelledby", `payment-method-${gw.id}`);
    }
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
  if (initialGateway) void selectMethod(initialGateway.id, initialGateway);
}

// ── Gateway selection ─────────────────────────────────────────────────────────

async function selectMethod(
  methodId: string,
  gw: CheckoutConfig["gateways"][number],
): Promise<void> {
  if (isProcessing) return;
  const selectionId = ++selectionVersion;
  retrySelection = null;
  selectedMethod = null;
  applySelectedMethodStyles(methodId);
  setPayButton(checkoutCopy.preparingPaymentText, true);
  hideError();
  const handler = getGateway(methodId);
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

  if (actionHost) {
    details.appendChild(actionHost);
    actionHost.classList.remove("hidden");
  }
  testNotice?.classList.toggle(
    "hidden",
    methodId === "cod" || !isGatewayTestMode(gw),
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

  const existingRecovery = readHostedPaymentRecoverySession();
  if (matchesCheckoutRecoverySession(existingRecovery, checkoutData.cartItems)) {
    window.location.replace(existingRecovery!.href);
    return;
  }
  const processingMethod = selectedMethod;
  isProcessing = true;
  setPaymentControlsDisabled(true);
  hideError();
  setPayButton(checkoutCopy.processingText, true);
  trackAddPaymentInfoForSelection(processingMethod);

  showCheckoutLoadingOverlay(
    processingMethod === "cod"
      ? {
          title: checkoutCopy.placingOrderTitle,
          message: checkoutCopy.placingOrderMessage,
        }
      : {
          title: checkoutCopy.openingSecurePaymentTitle,
          message: checkoutCopy.openingSecurePaymentMessage,
        },
  );

  const handler = getGateway(processingMethod);
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
    const paymentRequest = resolveCheckoutPaymentRequest(
      checkoutConfig,
      totalAmount,
    );
    const advanceAmount = paymentRequest.paymentType === "deposit"
      ? paymentRequest.depositAmount
      : totalAmount;

    const ctx: PaymentContext = {
      checkoutData,
      config: checkoutConfig,
      orderId: "", // Will be set by each handler's createOrder call
      totalAmount,
      advanceAmount,
      currencySymbol: (window as unknown as Record<string, string>).__CURRENCY_SYMBOL__ || DEFAULT_CURRENCY.symbol,
      onOrderCreated: (orderId, gateway) => {
        writeHostedPaymentRecoverySession(
          checkoutRecoveryHref(orderId, gateway),
          checkoutData ?? undefined,
          gateway,
        );
      },
    };

    // Each provider request has its own bounded network deadline. Do not race
    // the complete flow against a UI-only timer: an abandoned promise can
    // still create an order after the controls have been re-enabled.
    const result = await handler.processPayment(ctx);

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
        checkoutData,
        processingMethod,
      );
      navigationCommitted = true;
      window.location.replace(redirectUrl);
      return;
    }

    if (!result.success) {
      if (result.cartIssues && result.cartIssues.length > 0) {
        hideCheckoutLoadingOverlay({ restoreFocus: false });
        redirectToCartForRepair({
          valid: false,
          issues: result.cartIssues,
          message: result.error || checkoutFreshnessMessage(result.cartIssues),
        });
        return;
      }

      const recovery = getPaymentResultRecovery(result);
      if (recovery) {
        hideCheckoutLoadingOverlay();
        isProcessing = false;
        setPaymentControlsDisabled(false);
        showError(recovery.message);
        setPayButton(recovery.buttonText, false);
        return;
      }
      throw new Error(getPaymentResultErrorMessage(result));
    }
  } catch (err: unknown) {
    hideCheckoutLoadingOverlay();
    showError(err instanceof Error ? err.message : checkoutCopy.genericErrorText);
    isProcessing = false;
    setPaymentControlsDisabled(false);
    setPayButton(
      paymentActionLabel(processingMethod),
      handler.isReady ? !handler.isReady() : false,
    );
  } finally {
    if (!navigationCommitted) {
      isProcessing = false;
      setPaymentControlsDisabled(false);
    }
  }
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
  selectionVersion += 1;
  checkoutConfig = (window as unknown as Record<string, CheckoutConfig>).__CHECKOUT_CONFIG__;
  const activeLanguage = window.__CHECKOUT_LANGUAGE__ as
    | { languageData?: Partial<CheckoutLanguageData> }
    | undefined;
  checkoutCopy = {
    ...ENGLISH_CHECKOUT_LANGUAGE_DATA,
    ...(activeLanguage?.languageData ?? {}),
  };
  if (!checkoutConfig) return;

  installOrderSummaryToggle();

  if (!loadCheckoutData()) return;

  const existingRecovery = readHostedPaymentRecoverySession();
  if (matchesCheckoutRecoverySession(existingRecovery, checkoutData!.cartItems)) {
    window.location.replace(existingRecovery!.href);
    return;
  }

  try {
    authoritativeTaxQuote = await fetchAuthoritativeTaxQuote(checkoutData!);
    if (currentInitVersion !== initVersion) return;
  } catch (error) {
    if (error instanceof TaxQuoteCartChangedError) {
      redirectToCartForRepair({
        valid: false,
        issues: error.issues,
        message: checkoutFreshnessMessage(error.issues),
      });
      return;
    }
    showError(
      error instanceof Error
        ? error.message
        : checkoutCopy.totalVerificationFailedText,
    );
    setPayButton(checkoutCopy.totalUnavailableText, true);
    return;
  }

  renderSummary();
  renderGateways();

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
