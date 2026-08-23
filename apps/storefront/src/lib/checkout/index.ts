import type { CheckoutConfig, PaymentContext } from "./types";
import { registerGateway, getGateway } from "./registry";
import { codHandler } from "./handlers/cod";
import { stripeHandler } from "./handlers/stripe";
import { sslcommerzHandler } from "./handlers/sslcommerz";
import { polarHandler } from "./handlers/polar";
import { formatPrice, DEFAULT_CURRENCY } from "@scalius/shared/currency";
import type { PaymentResult } from "./types";
import {
  CHECKOUT_TRANSFER_UNAVAILABLE_MESSAGE,
  clearCheckoutTransferSession,
  writeHostedPaymentRecoverySession,
} from "./session-state";
import {
  isDepositPaymentRequired,
  resolveCheckoutPaymentRequest,
} from "./payment-mode";
import type { CartValidationIssue, CartValidationRequestItem } from "../api/orders";
import { trackStorefrontAddPaymentInfoOnce } from "../analytics";
import { writeCartRepairState } from "../cart/repair-state";
import { getCheckoutStatusErrorMessage } from "./error-messages";
import { fetchAuthoritativeTaxQuote } from "./tax-quote-client";
import type { CheckoutTaxQuote } from "./tax-quote-contract";
import { cartItemVariantLabel } from "../cart/item-options";
import { isGatewayTestMode } from "./gateway-environment";
import {
  hideCheckoutLoadingOverlay,
  showCheckoutLoadingOverlay,
} from "./loading-overlay";
import { normalizeCheckoutRedirectUrl } from "./redirect-url";

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
  return getCheckoutStatusErrorMessage(result.status, result.error || "Payment failed");
}

export function getPaymentResultRecovery(result: PaymentResult): {
  message: string;
  buttonText: string;
} | null {
  if (result.errorCode !== "CUSTOMER_SESSION_STALE") return null;

  return {
    message: "Your sign-in session expired. Your checkout details are safe. Continue as a guest, or sign in again.",
    buttonText: "Continue as guest",
  };
}

function setPayButton(text: string, disabled = false): void {
  const btn = document.getElementById("payButton") as HTMLButtonElement | null;
  const span = document.getElementById("payButtonText");
  if (btn) btn.disabled = disabled || isProcessing;
  if (span) span.textContent = text;
}

function setReturnToCartButton(): void {
  const btn = document.getElementById("payButton") as HTMLButtonElement | null;
  const span = document.getElementById("payButtonText");
  if (!btn) return;
  btn.disabled = false;
  btn.onclick = () => {
    window.location.href = "/cart";
  };
  if (span) span.textContent = "Return to cart";
}

function applySelectedMethodStyles(methodId: string | null): void {
  document.querySelectorAll(".payment-method-card").forEach((card) => {
    const el = card as HTMLElement;
    const isSelected = el.dataset.method === methodId;
    el.setAttribute("aria-checked", String(isSelected));
    if (methodId !== null) el.tabIndex = isSelected ? 0 : -1;
    el.classList.toggle("border-primary", isSelected);
    el.classList.toggle("border-input", !isSelected);
    el.querySelector(".check-dot")?.classList.toggle("hidden", !isSelected);
  });
}

function handlePaymentMethodKeyDown(event: KeyboardEvent): void {
  const keys = ["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"];
  if (!keys.includes(event.key)) return;

  const cards = Array.from(
    document.querySelectorAll<HTMLButtonElement>(".payment-method-card"),
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

function appendPaymentMethodContent(
  card: HTMLButtonElement,
  meta: { label: string; icon: string; desc: string },
  label: string,
  testMode: boolean,
  trustedIcon: boolean,
): void {
  const icon = document.createElement("div");
  icon.className =
    "flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border bg-muted";
  if (trustedIcon) icon.innerHTML = meta.icon;
  else icon.textContent = meta.icon;
  icon.setAttribute("aria-hidden", "true");
  card.appendChild(icon);

  const copy = document.createElement("div");
  copy.className = "min-w-0 flex-1";
  appendTextElement(copy, "p", "text-sm font-semibold text-foreground", label);
  if (meta.desc) {
    appendTextElement(
      copy,
      "p",
      "mt-0.5 text-[11px] leading-tight text-muted-foreground",
      meta.desc,
    );
  }
  if (testMode) {
    appendTextElement(
      copy,
      "span",
      "mt-1 inline-flex rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-200",
      "Test mode · no real charge",
    );
  }
  card.appendChild(copy);

  const check = document.createElement("div");
  check.className =
    "method-check flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 border-input";
  check.setAttribute("aria-hidden", "true");
  const dot = document.createElement("div");
  dot.className = "check-dot hidden h-2.5 w-2.5 rounded-full bg-primary";
  check.appendChild(dot);
  card.appendChild(check);

  card.setAttribute(
    "aria-label",
    [label, meta.desc, testMode ? "Test mode, no real charge" : ""]
      .filter(Boolean)
      .join(". "),
  );
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

type CheckoutCartFreshnessResult = {
  valid: boolean;
  issues: CartValidationIssue[];
  message: string;
};

type CheckoutCartLine = {
  id?: unknown;
  variantId: unknown;
  quantity?: unknown;
  price?: unknown;
  name?: unknown;
  options?: unknown;
};

function readNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function variantLabelForCheckoutLine(item: CheckoutCartLine): string | null {
  return cartItemVariantLabel(item.options);
}

export function checkoutCartValidationPayload(
  data: Record<string, unknown>,
): CartValidationRequestItem[] {
  let cartItems: Record<string, CheckoutCartLine> = {};
  try {
    const parsed = JSON.parse(String(data.cartItems || "{}")) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      cartItems = parsed as Record<string, CheckoutCartLine>;
    }
  } catch {
    cartItems = {};
  }

  return Object.entries(cartItems)
    .map<CartValidationRequestItem>(([cartKey, item]) => {
      if (typeof item.id !== "string" || item.id.trim() === "") {
        throw new Error("A checkout cart item is missing its product id.");
      }
      if (
        typeof item.variantId !== "string" ||
        item.variantId.trim() === "" ||
        item.variantId.trim() === "default"
      ) {
        throw new Error("A checkout cart item is missing its saved product variant.");
      }
      const quantity = Math.max(1, Math.floor(readNumber(item.quantity, 1)));
      const price = readNumber(item.price);
      return {
        cartKey,
        productId: item.id.trim(),
        variantId: item.variantId.trim(),
        quantity,
        price,
        productName: typeof item.name === "string" ? item.name : null,
        variantLabel: variantLabelForCheckoutLine(item),
      };
    });
}

function checkoutFreshnessMessage(
  json: { error?: unknown; details?: { message?: unknown } } | null,
  issues: CartValidationIssue[],
): string {
  if (issues.length > 0) {
    return issues.length === 1
      ? "One cart item changed before payment. Please review it before checkout."
      : `${issues.length} cart items changed before payment. Please review them before checkout.`;
  }
  if (typeof json?.details?.message === "string" && json.details.message.trim()) {
    return json.details.message;
  }
  if (typeof json?.error === "string" && json.error.trim()) {
    return json.error;
  }
  return "Could not verify cart availability. Please review your cart before checkout.";
}

export async function validateCheckoutCartFreshness(
  data: Record<string, unknown>,
): Promise<CheckoutCartFreshnessResult> {
  let items: CartValidationRequestItem[];
  try {
    items = checkoutCartValidationPayload(data);
  } catch {
    return {
      valid: false,
      issues: [],
      message: "Your cart contains an item without a saved product variant. Please return to your cart and add it again.",
    };
  }
  if (items.length === 0) {
    return {
      valid: false,
      issues: [],
      message: "Your cart is empty. Please add items before checkout.",
    };
  }

  try {
    const response = await fetch("/api/checkout/validate-cart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    });
    const json = await response.json().catch(() => null) as {
      success?: boolean;
      error?: unknown;
      data?: { valid: boolean; issues: CartValidationIssue[] };
      details?: { itemIssues?: CartValidationIssue[]; message?: unknown };
    } | null;
    const rawIssues = json?.data?.issues ?? json?.details?.itemIssues ?? [];
    const issues = Array.isArray(rawIssues) ? rawIssues : [];
    const valid = response.ok && json?.success === true && json.data?.valid !== false && issues.length === 0;

    return {
      valid,
      issues,
      message: checkoutFreshnessMessage(json, issues),
    };
  } catch {
    return {
      valid: false,
      issues: [],
      message: "Could not verify cart availability. Please review your cart before checkout.",
    };
  }
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
    return fail(CHECKOUT_TRANSFER_UNAVAILABLE_MESSAGE);
  }

  if (!raw) {
    return fail(
      "Checkout details were not found. Please return to cart and try again.",
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
      "Checkout details could not be read. Please return to cart and try again.",
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
  appendSummaryRow(details, "Subtotal", currencyFmt(quote.subtotalAmount, quote));
  appendSummaryRow(details, "Shipping", currencyFmt(quote.shippingAmount, quote));
  appendSummaryRow(
    details,
    "Discount",
    quote.discountAmount > 0
      ? `-${currencyFmt(quote.discountAmount, quote)}`
      : currencyFmt(0, quote),
    quote.discountAmount > 0
      ? "flex justify-between text-primary"
      : "flex justify-between",
  );
  appendSummaryRow(
    details,
    `${quote.displayLabel}${quote.pricesIncludeTax ? " (included)" : ""}`,
    currencyFmt(quote.taxAmount, quote),
  );
  appendSummaryRow(
    details,
    "Total",
    currencyFmt(quote.totalAmount, quote),
    "flex justify-between font-bold text-foreground pt-2 border-t border-border mt-2 mb-2",
  );

  if (isDepositPaymentRequired(config, quote.totalAmount)) {
    const advance = config.partialPaymentAmount;
    const balance = quote.totalAmount - advance;
    appendSummaryRow(
      details,
      "Advance Payment Required",
      currencyFmt(advance, quote),
      "flex justify-between font-bold text-primary bg-primary/10 p-2 rounded-lg mb-1 border border-primary/20",
    );
    appendSummaryRow(
      details,
      "Balance Due on Delivery",
      currencyFmt(balance, quote),
      "flex justify-between text-gray-600 text-xs px-2 mb-2",
    );
  }

  appendTextElement(
    details,
    "div",
    "text-[10px] text-muted-foreground mt-2 border-t border-border pt-2",
    `To: ${String(data.customerName || "")} \u2022 ${String(data.shippingAddress || "")}`,
  );
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

  section.classList.remove("hidden");
}

// ── Render payment method cards ───────────────────────────────────────────────

function renderGateways(): void {
  if (!checkoutConfig || !checkoutData || !authoritativeTaxQuote) return;
  const container = document.getElementById("paymentMethods");
  if (!container) return;
  container.innerHTML = "";
  container.setAttribute("role", "radiogroup");
  container.setAttribute("aria-label", "Payment methods");

  if (checkoutConfig.unavailable || gateways.length === 0) {
    showError(
      checkoutConfig.unavailableMessage ||
        "Checkout is temporarily unavailable. Please try again shortly.",
    );
    setPayButton("Checkout unavailable", true);
    return;
  }

  const depositRequired = isDepositPaymentRequired(
    checkoutConfig,
    authoritativeTaxQuote.totalAmount,
  );
  const renderedMethodIds = new Set<string>();
  const renderedGateways: CheckoutConfig["gateways"] = [];
  let renderedCount = 0;

  for (const gw of gateways) {
    // If partial payment is active, skip COD since online payment is mandatory
    if (checkoutConfig.partialPaymentEnabled && gw.id === "cod") continue;

    const handler = getGateway(gw.id);
    const meta = handler?.meta || {
      label: (gw as { name?: string }).name || gw.id,
      icon: "\uD83D\uDCB3",
      desc: "",
    };

    // Adjust label if partial payment is required
    let label = meta.label;
    if (
      depositRequired &&
      (gw.id === "stripe" || gw.id === "sslcommerz" || gw.id === "polar")
    ) {
      label = `${meta.label} · advance payment`;
    }

    const card = document.createElement("button");
    card.type = "button";
    card.setAttribute("role", "radio");
    card.setAttribute("aria-checked", "false");
    card.tabIndex = renderedCount === 0 ? 0 : -1;
    card.className =
      "payment-method-card w-full appearance-none cursor-pointer rounded-xl border-2 border-input bg-card p-4 text-left transition-all hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background flex items-center gap-4";
    card.dataset.method = gw.id;
    appendPaymentMethodContent(
      card,
      meta,
      label,
      isGatewayTestMode(gw),
      Boolean(handler),
    );
    card.addEventListener("click", () => selectMethod(gw.id, gw));
    card.addEventListener("keydown", handlePaymentMethodKeyDown);
    container.appendChild(card);
    renderedMethodIds.add(gw.id);
    renderedGateways.push(gw);
    renderedCount += 1;
  }

  if (renderedCount === 0) {
    showError("No available payment method can complete this checkout. Please go back to cart or contact the store.");
    setPayButton("Checkout unavailable", true);
    return;
  }

  const defaultMethod = checkoutConfig.activeDefaultMethod;
  const defaultGateway = gateways.find((gw) => gw.id === defaultMethod);
  if (defaultMethod && defaultGateway && renderedMethodIds.has(defaultMethod)) {
    void selectMethod(defaultMethod, defaultGateway);
    return;
  }

  // A checkout policy may change while a buyer is already on this page. If
  // that removes the saved default but leaves one usable method, select the
  // only truthful choice instead of stranding the buyer behind a disabled
  // "Select a payment method" action.
  if (renderedGateways.length === 1) {
    const [onlyGateway] = renderedGateways;
    if (onlyGateway) void selectMethod(onlyGateway.id, onlyGateway);
  }
}

// ── Gateway selection ─────────────────────────────────────────────────────────

async function selectMethod(methodId: string, gw: { id: string; [key: string]: unknown }): Promise<void> {
  const selectionId = ++selectionVersion;
  selectedMethod = null;
  applySelectedMethodStyles(null);
  setPayButton("Preparing payment...", true);
  hideError();
  const handler = getGateway(methodId);
  const stripeSection = document.getElementById("stripeSection");

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
      applySelectedMethodStyles(null);
      stripeSection?.classList.add("hidden");
      setPayButton("Select a payment method", true);
      return;
    }
  }

  if (selectionId !== selectionVersion) return;
  selectedMethod = methodId;
  applySelectedMethodStyles(methodId);

  // Set button text
  const isPartial = checkoutConfig?.partialPaymentEnabled ?? false;
  const text = handler?.getButtonText(isPartial) ?? "Continue to payment";
  setPayButton(text, handler?.isReady ? !handler.isReady() : false);
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
  isProcessing = true;
  hideError();
  setPayButton("Processing...", true);
  trackAddPaymentInfoForSelection(selectedMethod);

  showCheckoutLoadingOverlay(
    selectedMethod === "cod"
      ? {
          title: "Placing your order",
          message: "Confirming item availability and delivery.",
        }
      : {
          title: "Opening secure payment",
          message: "You'll continue with the selected payment provider.",
        },
  );

  const handler = getGateway(selectedMethod);
  if (!handler) {
    hideCheckoutLoadingOverlay();
    showError("Unknown payment method selected.");
    isProcessing = false;
    setPayButton("Continue to payment", false);
    return;
  }

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
    };

    const result = await handler.processPayment(ctx);

    if (result.success && result.redirectUrl) {
      const redirectUrl = normalizeCheckoutRedirectUrl(
        result.redirectUrl,
        window.location.origin,
      );
      if (!redirectUrl) {
        throw new Error("Payment could not open because the gateway returned an unsafe redirect URL.");
      }
      writeHostedPaymentRecoverySession(
        result.hostedPaymentRecoveryUrl ?? redirectUrl,
        checkoutData,
        selectedMethod,
      );
      window.location.href = redirectUrl;
      return;
    }

    if (!result.success) {
      if (result.cartIssues && result.cartIssues.length > 0) {
        hideCheckoutLoadingOverlay({ restoreFocus: false });
        redirectToCartForRepair({
          valid: false,
          issues: result.cartIssues,
          message: result.error || checkoutFreshnessMessage(null, result.cartIssues),
        });
        return;
      }

      const recovery = getPaymentResultRecovery(result);
      if (recovery) {
        hideCheckoutLoadingOverlay();
        isProcessing = false;
        showError(recovery.message);
        setPayButton(recovery.buttonText, false);
        return;
      }
      throw new Error(getPaymentResultErrorMessage(result));
    }
  } catch (err: unknown) {
    hideCheckoutLoadingOverlay();
    showError(err instanceof Error ? err.message : "An error occurred. Please try again.");
    isProcessing = false;

    // Restore button text based on selected method
    const restoreHandler = getGateway(selectedMethod);
    const isPartial = checkoutConfig.partialPaymentEnabled;
    const text = restoreHandler?.getButtonText(isPartial) ?? "Continue to payment";
    setPayButton(text, restoreHandler?.isReady ? !restoreHandler.isReady() : false);
  } finally {
    isProcessing = false;
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

export async function initCheckoutPage(): Promise<void> {
  selectedMethod = null;
  checkoutData = null;
  gateways = [];
  authoritativeTaxQuote = null;
  isProcessing = false;
  selectionVersion += 1;
  checkoutConfig = (window as unknown as Record<string, CheckoutConfig>).__CHECKOUT_CONFIG__;
  if (!checkoutConfig) return;

  if (!loadCheckoutData()) return;

  const freshness = await validateCheckoutCartFreshness(checkoutData!);
  if (!freshness.valid) {
    redirectToCartForRepair(freshness);
    return;
  }

  try {
    authoritativeTaxQuote = await fetchAuthoritativeTaxQuote(checkoutData!);
  } catch (error) {
    showError(
      error instanceof Error
        ? error.message
        : "We could not verify the current taxes and order total. Please return to your cart and try again.",
    );
    setPayButton("Total unavailable", true);
    return;
  }

  renderSummary();
  renderGateways();

  const payBtn = document.getElementById("payButton");
  payBtn?.addEventListener("click", processPayment);
}
