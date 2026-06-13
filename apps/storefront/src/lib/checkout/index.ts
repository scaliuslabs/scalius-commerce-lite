import type { CheckoutConfig, PaymentContext } from "./types";
import { registerGateway, getGateway } from "./registry";
import { codHandler } from "./handlers/cod";
import { stripeHandler } from "./handlers/stripe";
import { sslcommerzHandler } from "./handlers/sslcommerz";
import { polarHandler } from "./handlers/polar";
import { formatPrice, DEFAULT_CURRENCY } from "@scalius/shared/currency";
import type { PaymentResult } from "./types";
import { clearCheckoutSession } from "./session-state";

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
    gateways = gwRaw ? JSON.parse(gwRaw) : checkoutConfig!.gateways;
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
  const items = Object.values(cartItems);
  const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const shipping = parseFloat(String(data.shippingCharge || "0"));
  const discount = parseFloat(String(data.discountAmount || "0"));
  const total = subtotal + shipping - discount;

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

  if (config.partialPaymentEnabled && config.partialPaymentAmount > 0) {
    const advance = Math.min(config.partialPaymentAmount, total);
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
  if (!checkoutConfig) return;
  const container = document.getElementById("paymentMethods");
  if (!container) return;
  container.innerHTML = "";

  for (const gw of gateways) {
    // If partial payment is active, skip COD since online payment is mandatory
    if (checkoutConfig.partialPaymentEnabled && gw.id === "cod") continue;

    const handler = getGateway(gw.id);
    const meta = handler?.meta || { label: (gw as { name?: string }).name || gw.id, icon: "\uD83D\uDCB3", desc: "" };

    // Adjust label if partial payment is required
    let label = meta.label;
    if (checkoutConfig.partialPaymentEnabled && (gw.id === "stripe" || gw.id === "sslcommerz" || gw.id === "polar")) {
      label = `Pay Advance via ${meta.label}`;
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
  }
}

// ── Gateway selection ─────────────────────────────────────────────────────────

async function selectMethod(methodId: string, gw: { id: string; [key: string]: unknown }): Promise<void> {
  selectedMethod = methodId;

  // Update card styles
  document.querySelectorAll(".payment-method-card").forEach((card) => {
    const el = card as HTMLElement;
    const isSelected = el.dataset.method === methodId;
    el.classList.toggle("border-primary", isSelected);
    el.classList.toggle("border-input", !isSelected);
    el.querySelector(".check-dot")?.classList.toggle("hidden", !isSelected);
  });

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
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : String(err));
      return;
    }
  }

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
    showError("Unknown payment method selected.");
    isProcessing = false;
    return;
  }

  try {
    // Compute totals for context
    let cartItems: Record<string, { price: number; quantity: number }> = {};
    try {
      cartItems = JSON.parse((checkoutData.cartItems as string) || "{}");
    } catch {
      // ignore
    }
    const items = Object.values(cartItems);
    const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const shipping = parseFloat((checkoutData.shippingCharge as string) || "0");
    const discount = parseFloat((checkoutData.discountAmount as string) || "0");
    const totalAmount = subtotal + shipping - discount;
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
      throw new Error(result.error || "Payment failed");
    }
  } catch (err: unknown) {
    if (loadingOverlay) {
      loadingOverlay.style.display = "none";
    }
    showError(err instanceof Error ? err.message : "An error occurred. Please try again.");

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

export function initCheckoutPage(): void {
  checkoutConfig = (window as unknown as Record<string, CheckoutConfig>).__CHECKOUT_CONFIG__;
  if (!checkoutConfig) return;

  if (!loadCheckoutData()) return;
  renderSummary();
  renderGateways();

  const payBtn = document.getElementById("payButton");
  payBtn?.addEventListener("click", processPayment);
}
