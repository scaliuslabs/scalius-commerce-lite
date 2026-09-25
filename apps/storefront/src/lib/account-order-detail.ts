// /account/orders/[id]: where the order is, what was bought, delivery,
// payment (with online payment recovery) and order help.

import {
  createCustomerOrderPaymentSession,
  createCustomerOrderSupportRequest,
  getCustomerOrderDetail,
  getCustomerSession,
  type CustomerOrderDetail,
  type CustomerOrderPaymentSession,
  type CustomerOrderShipment,
  type CustomerOrderSupportRequestType,
} from "@/lib/api/customer-auth";
import { getCheckoutConfig, type CheckoutConfig } from "@/lib/api/checkout";
import {
  getAccountPaymentRecoveryAction,
  getAccountPaymentReturnNotice,
  normalizeHostedGatewayUrl,
  type AccountPaymentRecoveryAction,
} from "@/lib/account-payment-recovery";
import {
  ACCOUNT_OFFLINE_MESSAGE,
  accountMoney,
  formatAccountDate,
  formatDeliveryArea,
  orderPaymentLine,
} from "@/lib/account-format";
import { addOrderToCart } from "@/lib/account-buy-again";
import { getProductImageUrl } from "@/lib/product-media";
import { getGatewayPresentation } from "@/lib/checkout/gateway-presentation";
import { isGatewayEligibleForPaymentAmount } from "@/lib/checkout/gateway-amount-eligibility";
import { DEFAULT_CURRENCY } from "@scalius/shared/currency";
import { escapeHtml } from "@scalius/shared/html-escape";
import { fromMinor } from "@scalius/shared/money";
import { formatOrderNumber } from "@scalius/shared/order-utils";
import { formatBdMobile } from "@scalius/shared/phone-input";
import { ENGLISH_CHECKOUT_LANGUAGE_DATA as copy } from "@scalius/shared/checkout-language";
import { summarizeOrderDiscounts } from "@/lib/order-discount-summary";
import { orderDeliveryRow } from "@/lib/order-delivery-row";
import { orderShowsLineDiscounts, presentedLineTotalMinor } from "@/lib/order-line-discounts";
import { readReceiptGiftCardTenders, receiptGiftCardTenderLabel } from "@/lib/order-success-state";
import { lineExtrasMarkup } from "@/lib/order-line-extras";
import {
  orderProgressMarkup,
  orderShipmentMarkup,
  orderTimelineMarkup,
  safeTrackingUrl,
  type OrderTrackingText,
} from "@/lib/order-tracking-markup";
import {
  groupOrderLines,
  orderCompletionWording,
  orderLineGroupStatusText,
  orderLinePropertyRows,
  relabelOrderProgress,
  relabelOrderTimeline,
  resolveOrderDeliveryBlock,
  showsOrderLineGroupHeadings,
  supportActionDescription,
} from "@/lib/order-line-groups";

/** The customer order-detail payload, including the buyer tracking fields. */
export type AccountOrderDetail = CustomerOrderDetail;

/**
 * The order's payment facts plus the detail's `giftCardTenders` (optional:
 * read defensively until every client carries it).
 */
function paymentFacts(detail: AccountOrderDetail) {
  return { ...detail.order, giftCardTenders: (detail as { giftCardTenders?: unknown }).giftCardTenders };
}

interface StripeCardElement {
  mount(selector: string): void;
  on(event: string, handler: (e: { error?: { message: string } }) => void): void;
  unmount?(): void;
}

interface StripeInstance {
  elements(): { create(type: "card", options?: { style?: Record<string, Record<string, string>> }): StripeCardElement };
  confirmCardPayment(
    clientSecret: string,
    data: { payment_method: { card: StripeCardElement } },
  ): Promise<{ error?: { message?: string }; paymentIntent?: { status: string } }>;
}

type DetailWindow = Window & {
  Stripe?: (key: string) => StripeInstance;
  __scaliusOrderDetailRun?: number;
};
const detailWindow = window as DetailWindow;

const CANCEL_REASONS = [
  "Ordered by mistake",
  "Found a better price",
  "Delivery is too slow",
  "Need to change the address or items",
  "Other",
];
const RETURN_REASONS = [
  "Damaged or defective",
  "Wrong item received",
  "Not as described",
  "Changed my mind",
  "Other",
];

let currentDetail: AccountOrderDetail | null = null;
let currentCheckoutConfig: CheckoutConfig | null = null;
let recoveryAction: AccountPaymentRecoveryAction | null = null;
let selectedGateway: string | null = null;
let recoveryLoading = false;
let supportLoading = false;
let selectedSupportType: CustomerOrderSupportRequestType | null = null;
let stripeInstance: StripeInstance | null = null;
let stripeCard: StripeCardElement | null = null;
let stripeClientSecret: string | null = null;
let stripeOrderId: string | null = null;
let stripeScript: Promise<void> | null = null;

function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function writeError(result: { status?: number; error?: string }, fallback: string): string {
  return !result.status || result.status >= 500 ? ACCOUNT_OFFLINE_MESSAGE : result.error || fallback;
}

const trackingText: OrderTrackingText = {
  done: copy.orderTrackingStepDoneText,
  trackingId: copy.orderTrackingIdText,
  trackWithCourier: copy.orderTrackWithCourierText,
  formatDate: (iso) => formatAccountDate(iso),
};

function trackingUrl(shipment: CustomerOrderShipment): string | null {
  const explicitUrl = safeTrackingUrl(shipment.trackingUrl, window.location.origin);
  if (explicitUrl) return explicitUrl;
  if (!shipment.trackingId) return null;
  if (shipment.providerType === "pathao") return `https://merchant.pathao.com/tracking?consignment_id=${encodeURIComponent(shipment.trackingId)}`;
  if (shipment.providerType === "steadfast") return `https://steadfast.com.bd/t/${encodeURIComponent(shipment.trackingId)}`;
  return null;
}

// ---------- payment recovery ----------

function setRecoveryMessage(message: string | null, tone: "muted" | "error" | "success" = "muted"): void {
  const el = byId("orderPaymentRecoveryMessage");
  if (!el) return;
  el.textContent = message ?? "";
  el.className = message
    ? `text-sm ${tone === "error" ? "text-destructive" : tone === "success" ? "text-primary" : "text-muted-foreground"}`
    : "hidden text-sm";
}

function setStripeError(message: string | null): void {
  const el = byId("accountStripeError");
  if (!el) return;
  el.textContent = message ?? "";
  el.classList.toggle("hidden", !message);
}

function setRecoveryButton(label: string, disabled = false): void {
  const button = byId<HTMLButtonElement>("orderPaymentRecoveryButton");
  if (!button) return;
  button.textContent = label;
  button.disabled = disabled;
}

function isOnlineGateway(value: string): boolean {
  return /^[a-z][a-z0-9_-]{0,63}$/.test(value) && value !== "cod";
}

function gatewayMarkup(gateway: string): string {
  const presentation = getGatewayPresentation(gateway, gateway);
  const lightMark = presentation.markSrc
    ? `<img src="${escapeHtml(presentation.markSrc)}" alt="" aria-hidden="true" class="h-5 w-auto max-w-24 object-contain ${presentation.darkMarkSrc ? "dark:hidden" : ""}">`
    : "";
  const darkMark = presentation.darkMarkSrc
    ? `<img src="${escapeHtml(presentation.darkMarkSrc)}" alt="" aria-hidden="true" class="hidden h-5 w-auto max-w-24 object-contain dark:block">`
    : "";
  const mark = lightMark || darkMark ? `<span class="flex min-w-20 shrink-0 items-center">${lightMark}${darkMark}</span>` : "";
  return `<span class="flex items-center gap-3">${mark}<span class="min-w-0"><span class="block font-medium">${escapeHtml(presentation.buyerLabel)}</span>${presentation.description ? `<span class="mt-0.5 block text-sm text-muted-foreground">${escapeHtml(presentation.description)}</span>` : ""}</span></span>`;
}

function availableGateways(): string[] {
  const detail = currentDetail;
  if (!detail || !recoveryAction) return [];
  const currencyCode = detail.order.currencyCode ?? currentCheckoutConfig?.currency?.code ?? DEFAULT_CURRENCY.code;
  if (detail.paymentRecovery.paymentType === "balance") {
    if (!currentCheckoutConfig || currentCheckoutConfig.unavailable) return [recoveryAction.gateway];
    const configured = currentCheckoutConfig.gateways.find((gateway) => gateway.id === recoveryAction?.gateway);
    return configured && isGatewayEligibleForPaymentAmount(configured, recoveryAction.amountDue, currencyCode)
      ? [recoveryAction.gateway]
      : [];
  }
  const configured = (currentCheckoutConfig?.gateways ?? [])
    .filter((gateway) => isGatewayEligibleForPaymentAmount(gateway, recoveryAction?.amountDue ?? 0, currencyCode))
    .map((gateway) => gateway.id)
    .filter(isOnlineGateway);
  if (configured.length > 0) return [...new Set(configured)];
  return currentCheckoutConfig?.unavailable ? [recoveryAction.gateway] : [];
}

function recoveryButtonLabel(gateway: string): string {
  if (gateway === "stripe") return "Enter card details";
  if (currentDetail?.paymentRecovery.paymentType === "balance") return "Pay balance";
  const name = currentCheckoutConfig?.gateways?.find((candidate) => candidate.id === gateway)?.name;
  return `Continue with ${getGatewayPresentation(gateway, name ?? gateway).providerLabel ?? name ?? gateway}`;
}

function resetStripe(): void {
  stripeCard?.unmount?.();
  stripeInstance = null;
  stripeCard = null;
  stripeClientSecret = null;
  stripeOrderId = null;
  setStripeError(null);
  byId("accountStripeSection")?.classList.add("hidden");
}

function hideRecovery(): void {
  recoveryAction = null;
  selectedGateway = null;
  byId("orderPaymentRecovery")?.classList.add("hidden");
  const methods = byId("orderPaymentRecoveryMethods");
  if (methods) methods.innerHTML = "";
  resetStripe();
}

function selectGateway(gateway: string): void {
  if (recoveryLoading || selectedGateway === gateway) return;
  selectedGateway = gateway;
  resetStripe();
  document.querySelectorAll<HTMLButtonElement>("[data-recovery-gateway]").forEach((button) => {
    const selected = button.dataset.recoveryGateway === gateway;
    button.setAttribute("aria-checked", String(selected));
    button.classList.toggle("border-primary", selected);
    button.classList.toggle("bg-primary/10", selected);
  });
  setRecoveryMessage(null);
  setRecoveryButton(recoveryButtonLabel(gateway));
}

function renderPaymentRecovery(detail: AccountOrderDetail): void {
  const container = byId("orderPaymentRecovery");
  const methods = byId("orderPaymentRecoveryMethods");
  if (!container) return;
  const refunded = ["refunded", "partially_refunded"].includes(detail.order.paymentStatus);
  recoveryAction = detail.activeRefundOperation || refunded ? null : getAccountPaymentRecoveryAction(detail.paymentRecovery);
  const gateways = availableGateways();
  if (!recoveryAction || gateways.length === 0) return hideRecovery();
  if (!selectedGateway || !gateways.includes(selectedGateway)) {
    selectedGateway = gateways.includes(recoveryAction.gateway) ? recoveryAction.gateway : gateways[0] ?? null;
    resetStripe();
  }

  const title = byId("orderPaymentRecoveryTitle");
  const description = byId("orderPaymentRecoveryDescription");
  if (title) title.textContent = recoveryAction.title;
  if (description) {
    description.textContent = `${recoveryAction.description} Amount due: ${accountMoney(recoveryAction.amountDue, detail.order.currencyCode)}.`;
  }
  if (methods) {
    methods.innerHTML = gateways.map((gateway) => {
      const selected = gateway === selectedGateway;
      return `<button type="button" role="radio" aria-checked="${selected}" data-recovery-gateway="${escapeHtml(gateway)}" class="min-h-11 rounded-lg border px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-muted ${selected ? "border-primary bg-primary/10" : "border-border bg-background"}">${gatewayMarkup(gateway)}</button>`;
    }).join("");
  }
  container.classList.remove("hidden");
  byId("accountStripeSection")?.classList.toggle("hidden", !stripeClientSecret);
  if (!stripeClientSecret && selectedGateway) {
    setRecoveryMessage(null);
    setRecoveryButton(recoveryButtonLabel(selectedGateway), recoveryLoading);
  }
}

async function loadStripeScript(): Promise<void> {
  if (detailWindow.Stripe) return;
  stripeScript ??= new Promise<void>((resolve, reject) => {
    const script = document.querySelector<HTMLScriptElement>('script[src="https://js.stripe.com/v3/"]') ?? document.head.appendChild(Object.assign(document.createElement("script"), { src: "https://js.stripe.com/v3/", async: true }));
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener("error", () => reject(new Error("Card payment form is unavailable. Refresh and try again.")), { once: true });
  });
  return stripeScript;
}

async function prepareStripe(session: CustomerOrderPaymentSession): Promise<void> {
  const stripe = session.stripe;
  if (!stripe?.publishableKey || !stripe.clientSecret) throw new Error("Card payment could not start. Try again.");
  await loadStripeScript();
  if (!detailWindow.Stripe) throw new Error("Card payment form is unavailable. Refresh and try again.");
  stripeClientSecret = stripe.clientSecret;
  stripeOrderId = currentDetail?.order.id ?? null;
  if (!stripeCard) {
    stripeInstance = detailWindow.Stripe(stripe.publishableKey);
    stripeCard = stripeInstance.elements().create("card", {
      style: { base: { fontSize: "15px", color: "#111", fontFamily: "sans-serif" }, invalid: { color: "#e53e3e" } },
    });
    stripeCard.mount("#accountStripeCardElement");
    stripeCard.on("change", (event) => setStripeError(event.error?.message ?? null));
  }
  byId("accountStripeSection")?.classList.remove("hidden");
  setRecoveryMessage("Enter your card details, then confirm payment.");
  setRecoveryButton("Confirm card payment");
}

async function confirmStripe(): Promise<void> {
  if (!stripeInstance || !stripeCard || !stripeClientSecret) {
    setRecoveryMessage("The card form is not ready yet.", "error");
    return;
  }
  recoveryLoading = true;
  setRecoveryButton("Confirming…", true);
  try {
    const { error, paymentIntent } = await stripeInstance.confirmCardPayment(stripeClientSecret, {
      payment_method: { card: stripeCard },
    });
    if (error) throw new Error(error.message || "Card payment failed.");
    if (paymentIntent?.status !== "succeeded" && paymentIntent?.status !== "requires_capture") {
      throw new Error("Payment was not completed.");
    }
    setRecoveryMessage("Payment submitted. Updating the order…", "success");
    setRecoveryButton("Updating…", true);
    window.setTimeout(() => void loadOrderDetail(), 1500);
  } catch (error: unknown) {
    setRecoveryMessage(error instanceof Error ? error.message : "Payment could not be completed.", "error");
    setRecoveryButton("Confirm card payment");
  } finally {
    recoveryLoading = false;
  }
}

async function startRecovery(): Promise<void> {
  const detail = currentDetail;
  if (!detail || !recoveryAction || !selectedGateway || recoveryLoading) return;
  if (selectedGateway === "stripe" && stripeClientSecret && stripeOrderId === detail.order.id) {
    await confirmStripe();
    return;
  }
  recoveryLoading = true;
  setRecoveryButton("Preparing payment…", true);
  setStripeError(null);
  try {
    const result = await createCustomerOrderPaymentSession(detail.order.id, {
      gateway: selectedGateway,
      replaceExistingAttempt: detail.paymentRecovery.paymentType !== "balance",
      onProcessing: (event) => setRecoveryMessage(`${event.message} Retrying in ${event.retryAfterSeconds}s…`),
    });
    if (!result.success || !result.session) throw new Error(writeError(result, "Payment could not start. Try again."));
    if (result.session.gateway === "stripe") {
      selectedGateway = "stripe";
      await prepareStripe(result.session);
      return;
    }
    const gatewayUrl = normalizeHostedGatewayUrl(result.session.hosted?.gatewayUrl);
    if (!gatewayUrl) throw new Error("The payment page could not open. Try again.");
    setRecoveryButton("Redirecting…", true);
    window.location.assign(gatewayUrl);
  } catch (error: unknown) {
    setRecoveryMessage(error instanceof Error ? error.message : "Payment could not start. Try again.", "error");
    setRecoveryButton(recoveryButtonLabel(selectedGateway));
  } finally {
    recoveryLoading = false;
  }
}

// ---------- order help ----------

function supportReasons(type: CustomerOrderSupportRequestType): string[] {
  return type === "cancel_pre_shipment" ? CANCEL_REASONS : RETURN_REASONS;
}

function setSupportError(message: string | null): void {
  const el = byId("orderSupportFormError");
  if (!el) return;
  el.textContent = message ?? "";
  el.classList.toggle("hidden", !message);
}

function setSupportButton(label: string, disabled = false): void {
  const button = byId<HTMLButtonElement>("orderSupportSubmit");
  if (!button) return;
  button.textContent = label;
  button.disabled = disabled;
}

function hideSupportForm(): void {
  selectedSupportType = null;
  supportLoading = false;
  setSupportError(null);
  setSupportButton("Submit request");
  const message = byId<HTMLTextAreaElement>("orderSupportMessage");
  if (message) message.value = "";
  byId("orderSupportForm")?.classList.add("hidden");
}

function openSupportForm(type: CustomerOrderSupportRequestType): void {
  const action = currentDetail?.supportRequestActions.find((item) => item.type === type);
  if (!action?.eligible || supportLoading) return;
  selectedSupportType = type;
  setSupportError(null);
  setSupportButton("Submit request");
  const title = byId("orderSupportFormTitle");
  if (title) title.textContent = action.label;
  const reasons = byId("orderSupportReasons");
  if (reasons) {
    reasons.innerHTML = supportReasons(type).map((reason) => `
      <label class="flex min-h-11 items-center gap-3 text-sm text-foreground">
        <input type="radio" name="orderSupportReason" value="${escapeHtml(reason)}" class="h-4 w-4 accent-primary" />
        ${escapeHtml(reason)}
      </label>`).join("");
  }
  const message = byId<HTMLTextAreaElement>("orderSupportMessage");
  if (message) message.value = "";
  byId("orderSupportForm")?.classList.remove("hidden");
  reasons?.querySelector("input")?.focus();
}

function renderSupport(detail: AccountOrderDetail): void {
  // A closed order (cancelled, refunded) offers no request: no "Send a request" line for it.
  const canRequest = detail.supportRequestActions.length > 0;
  const intro = byId("orderSupportIntro");
  if (intro) {
    intro.textContent = canRequest ? detail.supportRequestIntro : "";
    intro.hidden = !canRequest;
  }
  const requests = byId("orderSupportRequests");
  if (requests) {
    requests.innerHTML = detail.supportRequests.map((request) => `
      <article class="rounded-lg border border-border p-4 text-sm">
        <h3 class="font-medium text-foreground">${escapeHtml(request.label)}</h3>
        <p class="mt-1 text-muted-foreground">${escapeHtml(request.reason)}</p>
        <time class="mt-1 block text-muted-foreground" datetime="${escapeHtml(request.submittedAt || request.createdAt || "")}">${escapeHtml(formatAccountDate(request.submittedAt || request.createdAt))}</time>
      </article>`).join("");
  }
  const actions = byId("orderSupportActions");
  if (actions) {
    actions.hidden = !canRequest;
    actions.innerHTML = detail.supportRequestActions.map((action) => `
      <button type="button" data-support-request-type="${escapeHtml(action.type)}" ${action.eligible ? "" : "disabled"} class="min-h-11 rounded-lg border border-border px-3 py-2 text-left text-sm transition-colors ${action.eligible ? "text-foreground hover:bg-muted" : "cursor-not-allowed text-muted-foreground"}">
        <span class="font-medium">${escapeHtml(action.label)}</span>
        <span class="mt-0.5 block text-muted-foreground">${escapeHtml(action.eligible ? supportActionDescription(action, detail.order, copy) : action.disabledReason ?? supportActionDescription(action, detail.order, copy))}</span>
      </button>`).join("");
  }
  const selected = detail.supportRequestActions.find((action) => action.type === selectedSupportType);
  if (!selected?.eligible) hideSupportForm();
}

async function submitSupportRequest(): Promise<void> {
  const detail = currentDetail;
  if (!detail || supportLoading || !selectedSupportType) return;
  const reason = document.querySelector<HTMLInputElement>('input[name="orderSupportReason"]:checked')?.value ?? "";
  const message = byId<HTMLTextAreaElement>("orderSupportMessage")?.value.trim() || null;
  if (!reason) {
    setSupportError("Choose a reason.");
    return;
  }
  if (reason === "Other" && !message) {
    setSupportError("Tell the store what you need.");
    byId("orderSupportMessage")?.focus();
    return;
  }
  supportLoading = true;
  setSupportError(null);
  setSupportButton("Submitting…", true);
  const result = await createCustomerOrderSupportRequest(detail.order.id, { type: selectedSupportType, reason, message });
  supportLoading = false;
  if (!result.success) {
    setSupportError(writeError(result, "Request could not be sent. Try again."));
    setSupportButton("Submit request");
    return;
  }
  hideSupportForm();
  await loadOrderDetail();
}

// ---------- buy again ----------

async function buyAgain(): Promise<void> {
  const button = byId<HTMLButtonElement>("orderBuyAgain");
  const message = byId("orderBuyAgainMessage");
  if (!currentDetail || !button || button.disabled) return;
  button.disabled = true;
  if (message) message.textContent = "";
  const result = await addOrderToCart(currentDetail.items);
  button.disabled = false;
  if (!message) return;
  message.textContent = !result
    ? ACCOUNT_OFFLINE_MESSAGE
    : result.added === 0
      ? "These items are no longer available."
      : result.missing > 0
        ? "Some items are no longer available, so they weren't added."
        : "";
}

// ---------- page ----------

function renderProgress(detail: AccountOrderDetail): void {
  const progress = byId("orderProgress");
  // Pickup and no-delivery orders track as "Ready for pickup"/"Picked up" or "Preparing"/"Completed".
  if (progress && detail.progress) progress.innerHTML = orderProgressMarkup(relabelOrderProgress(detail.progress, detail.order, copy), trackingText);
  const expected = byId("orderExpectedDelivery");
  if (expected) {
    const show = Boolean(detail.order.expectedDelivery)
      && resolveOrderDeliveryBlock(detail.order, copy).mode === "ship"
      && !detail.progress?.outcome
      && !detail.progress?.steps[3]?.done;
    expected.textContent = show ? `Expected delivery: ${detail.order.expectedDelivery}` : "";
    expected.classList.toggle("hidden", !show);
  }
  const timeline = byId("orderTimeline");
  if (timeline) timeline.innerHTML = orderTimelineMarkup(relabelOrderTimeline(detail.timeline, detail.order, copy), trackingText);
}

function renderItemsAndSummary(detail: AccountOrderDetail): void {
  const { order } = detail;
  const places = order.currencyDecimalPlaces ?? 2;
  const minor = (value: number) => accountMoney(fromMinor(value, places), order.currencyCode);
  const items = byId("orderItems");
  // An order-level promotion is one line in the summary, never a discount on each item.
  const showsLineDiscounts = orderShowsLineDiscounts(detail.discounts);
  if (items) {
    const lineMarkup = (item: AccountOrderDetail["items"][number]) => {
      const hasMinor = item.lineSubtotalMinor != null && item.unitPriceMinor != null;
      const lineTotal = hasMinor
        ? minor(presentedLineTotalMinor({
            grossSubtotalMinor: item.lineSubtotalMinor!,
            discountMinor: item.discountAmountMinor ?? 0,
            taxMinor: item.taxAmountMinor ?? 0,
          }, showsLineDiscounts, Boolean(order.pricesIncludeTax)))
        : accountMoney(item.lineTotal, order.currencyCode);
      const unit = hasMinor ? minor(item.unitPriceMinor!) : accountMoney(item.unitPrice, order.currencyCode);
      const name = escapeHtml(item.productName || "Product");
      // Buyer inputs: display only, escaped, never in links or data attributes.
      const properties = orderLinePropertyRows(item.properties, (property) => minor(property.priceMinor), copy);
      // Downloads, gift cards and the review form take a full-width row under
      // the line (under its text from sm up), never the narrow column beside the total.
      const extras = lineExtrasMarkup(item, { orderId: order.id, access: "account" });
      return `<li class="flex flex-wrap gap-x-3 py-4 first:pt-0 last:pb-0">
        <img src="${escapeHtml(getProductImageUrl(item.productImage, 128))}" alt="" class="h-16 w-16 shrink-0 rounded-lg border border-border bg-card object-contain" loading="lazy" />
        <div class="min-w-0 flex-1 text-sm">
          ${item.productSlug ? `<a href="/products/${encodeURIComponent(item.productSlug)}" class="font-medium text-foreground hover:underline">${name}</a>` : `<p class="font-medium text-foreground">${name}</p>`}
          ${item.variantLabel ? `<p class="text-muted-foreground">${escapeHtml(item.variantLabel)}</p>` : ""}
          ${properties.length > 0 ? `<ul class="text-muted-foreground">${properties.map((row) => `<li class="break-words"><span class="text-foreground">${escapeHtml(row.label)}:</span> ${escapeHtml(row.value)}${row.surcharge ? ` (${escapeHtml(row.surcharge)})` : ""}</li>`).join("")}</ul>` : ""}
          <p class="text-muted-foreground">Qty ${item.quantity} × ${escapeHtml(unit)}</p>
          ${showsLineDiscounts && (item.discountAmountMinor ?? 0) > 0 ? `<p class="text-muted-foreground">Discount -${escapeHtml(minor(item.discountAmountMinor!))}</p>` : ""}
        </div>
        <p class="shrink-0 text-sm font-medium tabular-nums text-foreground">${escapeHtml(lineTotal)}</p>
        ${extras ? `<div class="basis-full text-sm sm:pl-[4.75rem]">${extras}</div>` : ""}
      </li>`;
    };
    const groups = groupOrderLines(detail.items, order, copy);
    items.innerHTML = showsOrderLineGroupHeadings(groups)
      ? groups.map((group) => {
          const status = orderLineGroupStatusText(group);
          return `<li class="py-4 first:pt-0 last:pb-0" data-order-line-group="${escapeHtml(group.type)}">
        <div class="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h3 class="text-sm font-semibold text-foreground">${escapeHtml(group.heading)}</h3>
          ${status ? `<p class="text-sm text-muted-foreground">${escapeHtml(status)}</p>` : ""}
        </div>
        <ul class="divide-y divide-border">${group.items.map(lineMarkup).join("")}</ul>
      </li>`;
        }).join("")
      : detail.items.map(lineMarkup).join("");
  }

  const summary = byId("orderSummary");
  if (summary) {
    const cell = (value: string, className = "") => `<span${className ? ` class="${className}"` : ""}>${escapeHtml(value)}</span>`;
    const row = (label: string, valueHtml: string, total = false) =>
      `<div class="flex justify-between gap-4 ${total ? "border-t border-border pt-2 font-semibold text-foreground" : "text-muted-foreground"}"><dt>${escapeHtml(label)}</dt><dd class="text-right tabular-nums">${valueHtml}</dd></div>`;
    const major = (value: number) => fromMinor(value, places);
    const money = (value: number) => accountMoney(value, order.currencyCode);
    const tax = order.taxAmountMinor ?? 0;
    const giftCardTenders = readReceiptGiftCardTenders(paymentFacts(detail));
    const paymentLine = orderPaymentLine(paymentFacts(detail));
    const { delivery, lines } = summarizeOrderDiscounts({
      discounts: detail.discounts,
      shipping: major(order.shippingAmountMinor ?? 0),
      deliveryFee: order.shippingMethodBaseAmountMinor != null ? major(order.shippingMethodBaseAmountMinor) : null,
      discount: major(order.discountAmountMinor ?? 0),
      decimalPlaces: places,
      discountText: copy.discountText,
    });
    const deliveryMode = resolveOrderDeliveryBlock(order, copy).mode;
    // Nothing to deliver and nothing charged: no delivery row.
    const showsDeliveryRow = !(deliveryMode === "none" && !order.shippingMethodName && delivery.charged === 0 && delivery.fee === 0);
    const deliveryRow = orderDeliveryRow({ mode: deliveryMode, methodName: order.shippingMethodName, ...delivery }, copy, money);
    summary.innerHTML = [
      row("Subtotal", cell(minor(order.subtotalAmountMinor ?? 0))),
      !showsDeliveryRow ? "" : row(
        deliveryRow.label,
        [
          deliveryRow.struck ? `<s class="mr-1.5">${escapeHtml(deliveryRow.struck)}</s>` : "",
          cell(deliveryRow.value, "text-foreground"),
          deliveryRow.codes ? ` ${cell(`(${deliveryRow.codes})`)}` : "",
        ].join(""),
      ),
      ...lines.map((line) => row(line.label, cell(`−${money(line.amount)}`, "text-foreground"))),
      tax > 0 ? row(`${order.taxLabel || "Tax"}${order.pricesIncludeTax ? " (included)" : ""}`, cell(minor(tax))) : "",
      row("Total", cell(minor(order.totalAmountMinor ?? 0)), true),
      // Gift cards are payment: one row per card after the total, then what is left.
      ...giftCardTenders.map((tender) =>
        row(receiptGiftCardTenderLabel(tender, copy), cell(`−${money(tender.amount)}`, "text-foreground"))),
      giftCardTenders.length > 0 && paymentLine.balanceDue > 0
        ? row(paymentLine.balanceLabel, cell(money(paymentLine.balanceDue), "font-medium text-foreground"))
        : "",
    ].join("");
  }
}

function renderDelivery(detail: AccountOrderDetail): void {
  const { order } = detail;
  const block = resolveOrderDeliveryBlock(order, copy);
  const heading = byId("deliveryHeading");
  if (heading) {
    heading.textContent = block.mode === "pickup" ? block.heading : block.mode === "none" ? copy.orderReceiptDeliveryText : "Shipping address";
  }
  const address = byId("orderAddress");
  if (address) {
    const lines = block.mode === "pickup"
      ? [
          order.shippingMethodName,
          block.location,
          block.hours ? `${block.hoursLabel}: ${block.hours}` : null,
          block.notReady,
        ]
      : block.mode === "none"
        ? [block.text]
        : [
            block.address,
            formatDeliveryArea(order),
            order.shippingMethodName ? `Delivery method: ${order.shippingMethodName}` : null,
          ];
    address.innerHTML = [
      order.customerName,
      order.customerPhone ? formatBdMobile(order.customerPhone) : null,
      ...lines,
    ].filter(Boolean).map((line) => `<p>${escapeHtml(String(line))}</p>`).join("");
  }
  const note = byId("orderNote");
  if (note) {
    note.classList.toggle("hidden", !order.notes);
    note.innerHTML = order.notes
      ? `<p class="font-medium text-foreground">${escapeHtml(copy.orderReceiptNoteText)}</p><p class="whitespace-pre-line break-words text-muted-foreground">${escapeHtml(order.notes)}</p>`
      : "";
  }
  const shipments = byId("orderShipments");
  if (shipments) {
    shipments.innerHTML = detail.shipments.map((shipment) => {
      const updated = formatAccountDate(shipment.lastChecked || shipment.updatedAt || shipment.createdAt);
      return orderShipmentMarkup({
        statusLabel: shipment.statusLabel,
        courier: shipment.providerName || shipment.courierName,
        trackingId: shipment.trackingId,
        trackingUrl: trackingUrl(shipment),
        updated: updated ? `Updated ${updated}` : null,
      }, trackingText);
    }).join("");
  }
}

function renderPayment(detail: AccountOrderDetail): void {
  const { order } = detail;
  // "Gift card + Cash on delivery" and "৳800 due on delivery" when cards paid part.
  const line = orderPaymentLine(paymentFacts(detail));
  const paidByGiftCards = readReceiptGiftCardTenders(paymentFacts(detail)).length > 0;
  const money = (value: number) => accountMoney(value, order.currencyCode);
  const refunds = detail.refundAttempts.map((refund) => `
    <div class="border-t border-border pt-2">
      <p class="flex justify-between gap-4 text-foreground"><span>${escapeHtml(refund.label)}</span><span class="tabular-nums">${escapeHtml(money(refund.amount))}</span></p>
      <p class="text-muted-foreground">${escapeHtml(refund.message)}</p>
    </div>`).join("");
  const payment = byId("orderPayment");
  if (payment) {
    payment.innerHTML = [
      `<p class="font-medium text-foreground">${escapeHtml(line.method)}</p>`,
      `<p class="text-muted-foreground">${escapeHtml(line.state)}</p>`,
      // The card rows in the summary already say what the gift cards paid.
      line.balanceDue > 0 && order.paidAmount > 0 && !paidByGiftCards ? `<p class="text-muted-foreground">${escapeHtml(money(order.paidAmount))} paid</p>` : "",
      detail.cod?.collectedAmount ? `<p class="text-muted-foreground">${escapeHtml(money(detail.cod.collectedAmount))} collected</p>` : "",
      detail.paymentPlan ? `<p class="text-muted-foreground">Advance ${escapeHtml(money(detail.paymentPlan.depositAmount))}</p>` : "",
      refunds,
    ].join("");
  }
  const refundNotice = byId("orderRefundNotice");
  if (refundNotice) {
    const active = detail.activeRefundOperation;
    refundNotice.classList.toggle("hidden", !active);
    refundNotice.innerHTML = active
      ? `<p class="font-medium">${escapeHtml(active.label)}</p><p class="mt-1">${escapeHtml(active.message)} ${escapeHtml(money(active.amount))} is on its way back to you.</p>`
      : "";
  }
}

function renderReturnNotice(): void {
  const el = byId("orderPaymentReturnNotice");
  if (!el) return;
  const params = new URLSearchParams(window.location.search);
  const notice = getAccountPaymentReturnNotice(params.get("payment"), params.get("result"));
  el.classList.toggle("hidden", !notice);
  el.innerHTML = notice ? `<p class="font-medium">${escapeHtml(notice.title)}</p><p class="mt-1">${escapeHtml(notice.message)}</p>` : "";
}

export function renderOrderDetail(detail: AccountOrderDetail, checkoutConfig: CheckoutConfig | null): void {
  currentDetail = detail;
  currentCheckoutConfig = checkoutConfig;
  const buyAgainMessage = byId("orderBuyAgainMessage");
  if (buyAgainMessage) buyAgainMessage.textContent = "";
  const { order } = detail;
  const title = byId("orderTitle");
  if (title) title.textContent = `Order ${formatOrderNumber(order.orderNumber, order.id)}`;
  const subtitle = byId("orderSubtitle");
  if (subtitle) subtitle.textContent = `Placed ${formatAccountDate(order.createdAt)}`;
  const status = byId("orderStatus");
  // A finished pickup order reads "Picked up"; a service/digital-only one "Completed", never "Delivered".
  if (status) {
    status.textContent = orderCompletionWording(order, copy)?.statusLabel
      ?? order.statusLabel ?? detail.progress?.outcome?.label ?? order.status;
  }
  renderReturnNotice();
  renderProgress(detail);
  renderItemsAndSummary(detail);
  renderDelivery(detail);
  renderPayment(detail);
  renderSupport(detail);
  renderPaymentRecovery(detail);
}

function showOnly(state: "loading" | "unauth" | "error" | "content"): void {
  for (const [id, key] of [["orderLoading", "loading"], ["orderUnauthenticated", "unauth"], ["orderError", "error"], ["orderContent", "content"]] as const) {
    byId(id)?.classList.toggle("hidden", state !== key);
  }
}

/** A missing order can't be retried; an outage can. */
function showError(title: string, message: string, retry = true): void {
  currentDetail = null;
  hideRecovery();
  const titleEl = byId("orderErrorTitle");
  const messageEl = byId("orderErrorMessage");
  if (titleEl) titleEl.textContent = title;
  if (messageEl) messageEl.textContent = message;
  // The hidden attribute, not the class: the button's `inline-flex` utility
  // sorts after `hidden` and would keep it on screen.
  const retryButton = byId("orderRetry");
  if (retryButton) retryButton.hidden = !retry;
  showOnly("error");
}

export async function loadOrderDetail(): Promise<void> {
  const root = document.querySelector<HTMLElement>("[data-order-detail-page]");
  if (!root) return;
  const run = (detailWindow.__scaliusOrderDetailRun ?? 0) + 1;
  detailWindow.__scaliusOrderDetailRun = run;
  showOnly("loading");
  const orderId = root.dataset.orderId ?? "";
  if (!orderId) return showError("Order not found", "This order link is incomplete.", false);

  const session = await getCustomerSession();
  if (detailWindow.__scaliusOrderDetailRun !== run) return;
  if (session.unavailable) return showError("We couldn't reach the store", ACCOUNT_OFFLINE_MESSAGE);
  if (!session.authenticated) {
    currentDetail = null;
    hideRecovery();
    return showOnly("unauth");
  }

  const [result, checkoutConfig] = await Promise.all([getCustomerOrderDetail(orderId), getCheckoutConfig()]);
  if (detailWindow.__scaliusOrderDetailRun !== run) return;
  if (!result.success || !result.detail) {
    if (result.status === 401) return showOnly("unauth");
    return result.status === 404
      ? showError("Order not found", "We couldn't find this order in your account.", false)
      : showError("We couldn't reach the store", ACCOUNT_OFFLINE_MESSAGE);
  }
  try {
    renderOrderDetail(result.detail as AccountOrderDetail, checkoutConfig);
    showOnly("content");
  } catch (error) {
    console.error("[customer-order-detail] render failed", error);
    showError("Something went wrong", "This order could not be shown. Try again.");
  }
}

/** Wires the page's controls once per page view. */
export function bindOrderDetailPage(): void {
  const on = (id: string, handler: (event: MouseEvent) => void) => {
    const element = byId(id);
    if (element) element.onclick = handler;
  };
  on("orderRetry", () => void loadOrderDetail());
  on("orderPaymentRecoveryButton", () => void startRecovery());
  on("orderPaymentRecoveryMethods", (event) => {
    const gateway = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-recovery-gateway]")?.dataset.recoveryGateway;
    if (gateway && isOnlineGateway(gateway)) selectGateway(gateway);
  });
  on("orderSupportActions", (event) => {
    const type = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-support-request-type]")?.dataset.supportRequestType;
    if (type === "cancel_pre_shipment" || type === "return" || type === "refund") openSupportForm(type);
  });
  on("orderSupportCancel", () => hideSupportForm());
  on("orderBuyAgain", () => void buyAgain());
  on("orderSupportSubmit", () => void submitSupportRequest());
}
