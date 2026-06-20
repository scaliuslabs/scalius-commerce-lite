import type { CheckoutConfig, PaymentContext } from "./types";
import { registerGateway, getGateway } from "./registry";
import { codHandler } from "./handlers/cod";
import { stripeHandler } from "./handlers/stripe";
import { sslcommerzHandler } from "./handlers/sslcommerz";
import { polarHandler } from "./handlers/polar";
import { formatPrice, DEFAULT_CURRENCY } from "@scalius/shared/currency";
import type { PaymentResult } from "./types";
import { clearCheckoutSession } from "./session-state";
import { isDepositPaymentRequired } from "./payment-mode";
import type { CartValidationIssue, CartValidationRequestItem } from "../api/orders";
import { writeCartRepairState } from "../cart/repair-state";

// Register all built-in gateway handlers
registerGateway(codHandler);
registerGateway(stripeHandler);
registerGateway(sslcommerzHandler);
registerGateway(polarHandler);

// ── State ────────────────────────────────────────────────────────────────────

let selectedMethod: string | null = null;
let checkoutData: Record<string, unknown> | null = null;
let checkoutConfig: CheckoutConfig | null = null;
let gateways: Array<{ id: string; [key: string]: unknown }> = [];
let isProcessing = false;
let selectionVersion = 0;

// ── Helpers ──────────────────────────────────────────────────────────────────

function showError(msg: string): void {
  const el = document.getElementById("errorMsg");
  if (!el) return;
  el.textContent = msg;
  el.classList.remove("hidden");
  el.scrollIntoView({ behavior: "smooth", block: "center" });
}

function hideError(): void {
  const el = document.getElementById("errorMsg");
  el?.classList.add("hidden");
}

function setPayButton(text: string, disabled = false): void {
  const btn = document.getElementById("payButton") as HTMLButtonElement | null;
  const span = document.getElementById("payButtonText");
  if (btn) btn.disabled = disabled || isProcessing;
  if (span) span.textContent = text;
}

function applySelectedMethodStyles(methodId: string | null): void {
  document.querySelectorAll(".payment-method-card").forEach((card) => {
    const el = card as HTMLElement;
    const isSelected = el.dataset.method === methodId;
    el.classList.toggle("border-primary", isSelected);
    el.classList.toggle("border-input", !isSelected);
    el.querySelector(".check-dot")?.classList.toggle("hidden", !isSelected);
  });
}

function currencyFmt(amount: number | string): string {
  return formatPrice(amount);
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
  variantId?: unknown;
  quantity?: unknown;
  price?: unknown;
  name?: unknown;
  size?: unknown;
  color?: unknown;
};

function readNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function variantLabelForCheckoutLine(item: CheckoutCartLine): string | null {
  const parts = [item.size, item.color]
    .filter((part): part is string => typeof part === "string" && part.trim() !== "")
    .map((part) => part.trim());
  return parts.length > 0 ? parts.join(" / ") : null;
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
    .map<CartValidationRequestItem | null>(([cartKey, item]) => {
      if (typeof item.id !== "string" || item.id.trim() === "") return null;
      const quantity = Math.max(1, Math.floor(readNumber(item.quantity, 1)));
      const price = readNumber(item.price);
      return {
        cartKey,
        productId: item.id,
        variantId: typeof item.variantId === "string" && item.variantId !== "default"
          ? item.variantId
          : null,
        quantity,
        price,
        productName: typeof item.name === "string" ? item.name : null,
        variantLabel: variantLabelForCheckoutLine(item),
      };
    })
    .filter((item): item is CartValidationRequestItem => item !== null);
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
  const items = checkoutCartValidationPayload(data);
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

// ── Load checkout data ────────────────────────────────────────────────────────

function loadCheckoutData(): boolean {
  try {
    const raw = sessionStorage.getItem("scalius_checkout_data");
    const gwRaw = sessionStorage.getItem("scalius_checkout_gateways");
    if (!raw) {
      window.location.href = "/cart";
      return false;
    }
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
          .filter((gateway): gateway is { id: string; [key: string]: unknown } => Boolean(gateway))
      : checkoutConfig!.gateways;
    if (gwRaw && gateways.length === 0) {
      sessionStorage.removeItem("scalius_checkout_gateways");
      gateways = checkoutConfig!.gateways;
    }
    return true;
  } catch {
    window.location.href = "/cart";
    return false;
  }
}

// ── Render order summary ──────────────────────────────────────────────────────

export function renderOrderSummaryDetails(
  details: HTMLElement,
  data: Record<string, unknown>,
  config: CheckoutConfig,
): void {
  let cartItems: Record<string, { price: number; quantity: number }> = {};
  try {
    cartItems = JSON.parse(String(data.cartItems || "{}"));
  } catch {
    // ignore
  }
  const { items, subtotal, shipping, discount, total } = getCheckoutTotals(data, cartItems);
  details.replaceChildren();
  appendSummaryRow(details, `${items.length} item(s)`, currencyFmt(subtotal));
  appendSummaryRow(details, "Shipping", currencyFmt(shipping));
  if (discount > 0) {
    appendSummaryRow(
      details,
      "Discount",
      `-${currencyFmt(discount)}`,
      "flex justify-between text-primary",
    );
  }
  appendSummaryRow(
    details,
    "Total",
    currencyFmt(total),
    "flex justify-between font-bold text-foreground pt-2 border-t border-border mt-2 mb-2",
  );

  if (isDepositPaymentRequired(config, total)) {
    const advance = config.partialPaymentAmount;
    const balance = total - advance;
    appendSummaryRow(
      details,
      "Advance Payment Required",
      currencyFmt(advance),
      "flex justify-between font-bold text-primary bg-primary/10 p-2 rounded-lg mb-1 border border-primary/20",
    );
    appendSummaryRow(
      details,
      "Balance Due on Delivery",
      currencyFmt(balance),
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

function getCheckoutTotals(
  data: Record<string, unknown>,
  parsedCartItems?: Record<string, { price: number; quantity: number }>,
): {
  items: Array<{ price: number; quantity: number }>;
  subtotal: number;
  shipping: number;
  discount: number;
  total: number;
} {
  let cartItems = parsedCartItems;
  if (!cartItems) {
    try {
      cartItems = JSON.parse(String(data.cartItems || "{}"));
    } catch {
      cartItems = {};
    }
  }
  const resolvedCartItems = cartItems ?? {};
  const items = Object.values(resolvedCartItems);
  const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const shipping = parseFloat(String(data.shippingCharge || "0"));
  const discount = parseFloat(String(data.discountAmount || "0"));
  const total = subtotal + shipping - discount;

  return { items, subtotal, shipping, discount, total };
}

function renderSummary(): void {
  if (!checkoutData || !checkoutConfig) return;
  const section = document.getElementById("orderSummary");
  const details = document.getElementById("summaryDetails");
  if (!section || !details) return;

  renderOrderSummaryDetails(details, checkoutData, checkoutConfig);

  section.classList.remove("hidden");
}

// ── Render payment method cards ───────────────────────────────────────────────

function renderGateways(): void {
  if (!checkoutConfig || !checkoutData) return;
  const container = document.getElementById("paymentMethods");
  if (!container) return;
  container.innerHTML = "";

  if (checkoutConfig.unavailable || gateways.length === 0) {
    showError(
      checkoutConfig.unavailableMessage ||
        "Checkout is temporarily unavailable. Please try again shortly.",
    );
    setPayButton("Checkout unavailable", true);
    return;
  }

  const { total } = getCheckoutTotals(checkoutData);
  const depositRequired = isDepositPaymentRequired(checkoutConfig, total);
  const renderedMethodIds = new Set<string>();
  let renderedCount = 0;

  for (const gw of gateways) {
    // If partial payment is active, skip COD since online payment is mandatory
    if (checkoutConfig.partialPaymentEnabled && gw.id === "cod") continue;

    const handler = getGateway(gw.id);
    const meta = handler?.meta || { label: (gw as { name?: string }).name || gw.id, icon: "\uD83D\uDCB3", desc: "" };

    // Adjust label if partial payment is required
    let label = meta.label;
    if (checkoutConfig.partialPaymentEnabled && (gw.id === "stripe" || gw.id === "sslcommerz" || gw.id === "polar")) {
      label = depositRequired ? `Pay Advance via ${meta.label}` : `Pay Online via ${meta.label}`;
    }

    const card = document.createElement("div");
    card.className =
      "payment-method-card cursor-pointer rounded-xl border-2 border-input bg-card p-4 transition-all hover:border-primary/50 flex items-center gap-4";
    card.dataset.method = gw.id;
    card.innerHTML = `
      <div class="flex items-center justify-center w-10 h-10 rounded-full bg-muted border border-border shrink-0">
        ${meta.icon}
      </div>
      <div class="flex-1">
        <p class="font-semibold text-sm text-foreground">${label}</p>
        <p class="text-[11px] text-muted-foreground leading-tight mt-0.5">${meta.desc}</p>
        ${gw.id === "sslcommerz" && (gw as { sandbox?: boolean }).sandbox ? '<span class="text-[10px] bg-muted text-foreground px-1.5 py-0.5 rounded font-medium border border-border">Sandbox</span>' : ""}
      </div>
      <div class="method-check w-5 h-5 rounded-full border-2 border-input flex items-center justify-center shrink-0">
        <div class="check-dot w-2.5 h-2.5 rounded-full bg-primary hidden"></div>
      </div>
    `;
    card.addEventListener("click", () => selectMethod(gw.id, gw));
    container.appendChild(card);
    renderedMethodIds.add(gw.id);
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
  const text = handler?.getButtonText(isPartial) ?? "Continue to Payment";
  setPayButton(text, false);
}

// ── Process payment ───────────────────────────────────────────────────────────

export function clearCheckoutAndCart(): void {
  clearCheckoutSession();
  try {
    localStorage.removeItem("cart");
  } catch {
    // ignore
  }
}

export function shouldClearCheckoutBeforeRedirect(result: PaymentResult): boolean {
  return result.clearCartOnRedirect === true;
}

export function shouldClearCheckoutSessionBeforeRedirect(result: PaymentResult): boolean {
  return result.clearCartOnRedirect === true || result.clearCheckoutSessionOnRedirect === true;
}

async function processPayment(): Promise<void> {
  if (!selectedMethod || isProcessing || !checkoutData || !checkoutConfig) return;
  isProcessing = true;
  hideError();
  setPayButton("Processing...", true);

  const loadingOverlay = document.getElementById("loadingOverlay");
  const loadingTitle = document.getElementById("loadingTitle");
  const loadingMsg = document.getElementById("loadingMsg");
  const progressBar = document.getElementById("loadingProgressBar");

  if (loadingOverlay) {
    if (loadingTitle) loadingTitle.textContent = selectedMethod === "cod" ? "Confirming Order" : "Initializing Delivery";
    if (loadingMsg) loadingMsg.textContent = "Please wait while we safely process your order in our systems.";
    loadingOverlay.style.display = "block";

    if (progressBar) {
      progressBar.style.width = "0%";
      setTimeout(() => {
        progressBar.style.width = "40%";
      }, 200);
      setTimeout(() => {
        progressBar.style.width = "75%";
      }, 1000);
      setTimeout(() => {
        progressBar.style.width = "90%";
      }, 2500);
    }
  }

  const handler = getGateway(selectedMethod);
  if (!handler) {
    if (loadingOverlay) {
      loadingOverlay.style.display = "none";
    }
    showError("Unknown payment method selected.");
    isProcessing = false;
    setPayButton("Continue to Payment", false);
    return;
  }

  try {
    const freshness = await validateCheckoutCartFreshness(checkoutData);
    if (!freshness.valid) {
      if (loadingOverlay) {
        loadingOverlay.style.display = "none";
      }
      isProcessing = false;
      redirectToCartForRepair(freshness);
      return;
    }

    // Compute totals for context
    const { total: totalAmount } = getCheckoutTotals(checkoutData);
    const advanceAmount = checkoutConfig.partialPaymentEnabled
      ? Math.min(checkoutConfig.partialPaymentAmount, totalAmount)
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
      if (shouldClearCheckoutBeforeRedirect(result)) {
        clearCheckoutAndCart();
      } else if (shouldClearCheckoutSessionBeforeRedirect(result)) {
        clearCheckoutSession();
      }
      window.location.href = result.redirectUrl;
      return;
    }

    if (!result.success) {
      if (result.cartIssues && result.cartIssues.length > 0) {
        if (loadingOverlay) {
          loadingOverlay.style.display = "none";
        }
        redirectToCartForRepair({
          valid: false,
          issues: result.cartIssues,
          message: result.error || checkoutFreshnessMessage(null, result.cartIssues),
        });
        return;
      }
      throw new Error(result.error || "Payment failed");
    }
  } catch (err: unknown) {
    if (loadingOverlay) {
      loadingOverlay.style.display = "none";
    }
    showError(err instanceof Error ? err.message : "An error occurred. Please try again.");
    isProcessing = false;

    // Restore button text based on selected method
    const restoreHandler = getGateway(selectedMethod);
    const isPartial = checkoutConfig.partialPaymentEnabled;
    const text = restoreHandler?.getButtonText(isPartial) ?? "Continue to Payment";
    setPayButton(text, false);
  } finally {
    isProcessing = false;
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

export async function initCheckoutPage(): Promise<void> {
  checkoutConfig = (window as unknown as Record<string, CheckoutConfig>).__CHECKOUT_CONFIG__;
  if (!checkoutConfig) return;

  if (!loadCheckoutData()) return;

  const freshness = await validateCheckoutCartFreshness(checkoutData!);
  if (!freshness.valid) {
    redirectToCartForRepair(freshness);
    return;
  }

  renderSummary();
  renderGateways();

  const payBtn = document.getElementById("payButton");
  payBtn?.addEventListener("click", processPayment);
}
