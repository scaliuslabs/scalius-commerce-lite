// /account/orders/[id]: where the order is, what was bought, delivery,
// payment (with online payment recovery) and order help.

import { checkoutText, pageOrderNumber, pagePhone } from "@/lib/checkout-text";
import { addOnRowsOver, readAddOnRows } from "@scalius/shared/add-on-totals";
import { addOnRowHtml } from "@/lib/add-on-row";
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
  accountMoney,
  accountOfflineMessage,
  accountShipmentStatusText,
  formatAccountDate,
  formatOrderPlaces,
  orderPaymentLine,
  presentOrderTracking,
} from "@/lib/account-format";
import { accountCopy } from "@/lib/account-copy";
import { formatCount, formatStoreDateTime, pageLanguage, storeRegion } from "@/lib/store-time-zone";
import { presentCheckoutAttributes } from "@scalius/shared/plugins/checkout-attribute-text";
import { buyAgain as putOrderInCart } from "@/lib/account-buy-again";
import { accountPill, orderStatusTone } from "@/lib/account-ui";
import { getProductImageUrl } from "@/lib/product-media";
import { appGatewayName, getGatewayPresentation } from "@/lib/checkout/gateway-presentation";
import { CheckoutBuyerMessage, CheckoutCopyError, checkoutFailureText } from "@/lib/checkout/error-messages";
import { stripeErrorCopyKey, type StripeError } from "@/lib/checkout/stripe-error";
import { followColorScheme, stripeCardStyle } from "@/lib/stripe-card-style";
import { isPaymentMethodIdShape } from "@/lib/payment-method-id";
import { escapeHtml } from "@scalius/shared/html-escape";
import { fromMinor } from "@scalius/shared/money";

import { ENGLISH_CHECKOUT_LANGUAGE_DATA, type CheckoutLanguageData } from "@scalius/shared/checkout-language";
import { summarizeOrderDiscounts } from "@/lib/order-discount-summary";
import { orderDeliveryRow } from "@/lib/order-delivery-row";
import { isFreeOrderLine } from "@scalius/shared/order-money-presentation";
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
  orderLineGroupStatusText,
  orderLinePropertyRows,
  resolveOrderDeliveryBlock,
  showsOrderLineGroupHeadings,
  supportActionDescription,
} from "@/lib/order-line-groups";
import { buyerLineAddOnRows, readBuyerLineAddOns } from "@scalius/shared/buyer-line-add-on-text";
import { orderEntries, rowItemsOnly, withoutBundleEntry, type OrderEntry } from "@/lib/order-bundles";
import { pagePath } from "@/lib/presence-url";
import { longAnswerHtml, longAnswerWords } from "@/lib/long-answer";
import type { MoneySummaryRow } from "@/lib/money-summary-order";
import { getOrderReceiptSupportActionLabel } from "@/lib/order-success-localization";
import { renderBuyerUiWhenNeeded } from "@/lib/buyer-ui/lazy";
import { buyerOrderStatusText } from "@/lib/buyer-order-words";

/** The customer order-detail payload, including the buyer tracking fields. */
export type AccountOrderDetail = CustomerOrderDetail;

/**
 * The order's payment facts plus the detail's `giftCardTenders` (optional:
 * read defensively until every client carries it).
 */
function paymentFacts(detail: AccountOrderDetail) {
  return { ...detail.order, buyerView: detail.buyerView, giftCardTenders: (detail as { giftCardTenders?: unknown }).giftCardTenders };
}

interface StripeCardElement {
  mount(selector: string): void;
  on(event: string, handler: (e: { error?: StripeError }) => void): void;
  unmount?(): void;
  update?(options: { style: ReturnType<typeof stripeCardStyle> }): void;
}

interface StripeInstance {
  elements(): { create(type: "card", options?: { style?: ReturnType<typeof stripeCardStyle> }): StripeCardElement };
  confirmCardPayment(
    clientSecret: string,
    data: { payment_method: { card: StripeCardElement } },
  ): Promise<{ error?: StripeError; paymentIntent?: { status: string } }>;
}

type DetailWindow = Window & {
  Stripe?: (key: string) => StripeInstance;
  __scaliusOrderDetailRun?: number;
};
const detailWindow = window as DetailWindow;

/**
 * The checkout language the page embeds (`#orderCheckoutCopy`, the store's
 * language with the merchant's wording); English when it is missing.
 */
let copy: CheckoutLanguageData = ENGLISH_CHECKOUT_LANGUAGE_DATA;

function readCheckoutCopy(): void {
  try {
    const parsed = JSON.parse(document.getElementById("orderCheckoutCopy")?.textContent ?? "null") as Partial<CheckoutLanguageData> | null;
    copy = parsed && typeof parsed === "object" ? { ...ENGLISH_CHECKOUT_LANGUAGE_DATA, ...parsed } : ENGLISH_CHECKOUT_LANGUAGE_DATA;
  } catch {
    copy = ENGLISH_CHECKOUT_LANGUAGE_DATA;
  }
}

let currentDetail: AccountOrderDetail | null = null;
let currentCheckoutConfig: CheckoutConfig | null = null;
let recoveryAction: AccountPaymentRecoveryAction | null = null;
let selectedGateway: string | null = null;
let recoveryLoading = false;
let supportLoading = false;
let selectedSupportType: CustomerOrderSupportRequestType | null = null;
let stripeInstance: StripeInstance | null = null;
let stripeCard: StripeCardElement | null = null;
/** Stops restyling the mounted card when the colour scheme changes. */
let stopFollowingScheme: (() => void) | null = null;
let stripeClientSecret: string | null = null;
let stripeOrderId: string | null = null;
let stripeScript: Promise<void> | null = null;

function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function writeError(result: { status?: number; error?: string }, fallback: string): string {
  return !result.status || result.status >= 500 ? accountOfflineMessage() : result.error || fallback;
}

function trackingText(): OrderTrackingText {
  return {
    done: copy.orderTrackingStepDoneText,
    trackingId: copy.orderTrackingIdText,
    trackWithCourier: copy.orderTrackWithCourierText,
    formatDate: (iso) => formatAccountDate(iso),
  };
}

/** The courier's page the API gives with the shipment (couriers declare it; the store never guesses one). */
function trackingUrl(shipment: CustomerOrderShipment): string | null {
  return safeTrackingUrl(shipment.trackingUrl, window.location.origin);
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
  return isPaymentMethodIdShape(value) && value !== "cod";
}

function gatewayMarkup(gateway: string): string {
  // An app's wallet reads by the store's checkout name, never its stored id.
  const presentation = getGatewayPresentation(gateway, appGatewayName(gateway, currentCheckoutConfig?.gateways) ?? gateway, accountCopy().paymentMethodNames);
  const lightMark = presentation.markSrc
    ? `<img src="${escapeHtml(presentation.markSrc)}" alt="" aria-hidden="true" class="h-5 w-auto max-w-24 object-contain ${presentation.darkMarkSrc ? "dark:hidden" : ""}">`
    : "";
  const darkMark = presentation.darkMarkSrc
    ? `<img src="${escapeHtml(presentation.darkMarkSrc)}" alt="" aria-hidden="true" class="hidden h-5 w-auto max-w-24 object-contain dark:block">`
    : "";
  const mark = lightMark || darkMark ? `<span class="flex min-w-20 shrink-0 items-center">${lightMark}${darkMark}</span>` : "";
  return `<span class="flex items-center gap-3">${mark}<span class="min-w-0"><span class="block font-medium">${escapeHtml(presentation.buyerLabel)}</span>${presentation.description ? `<span class="mt-0.5 block text-sm text-muted-foreground">${escapeHtml(presentation.description)}</span>` : ""}</span></span>`;
}

/** The methods the API says a session would be accepted for (amount, currency and readiness checked there). */
function availableGateways(): string[] {
  return currentDetail && recoveryAction ? currentDetail.paymentRecovery.gateways : [];
}

function recoveryButtonLabel(gateway: string): string {
  const words = accountCopy().recovery;
  if (gateway === "stripe") return words.enterCard;
  if (currentDetail?.paymentRecovery.paymentType === "balance") return words.payBalance;
  const name = currentCheckoutConfig?.gateways?.find((candidate) => candidate.id === gateway)?.name;
  const presentation = getGatewayPresentation(gateway, name ?? gateway, accountCopy().paymentMethodNames);
  return words.continueWith(presentation.providerLabel ?? presentation.buyerLabel);
}

function resetStripe(): void {
  stripeCard?.unmount?.();
  stopFollowingScheme?.();
  stopFollowingScheme = null;
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
  recoveryAction = getAccountPaymentRecoveryAction(detail.paymentRecovery, detail.buyerView.paymentAction);
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
    description.textContent = accountCopy().recovery.amountDue(recoveryAction.description, accountMoney(recoveryAction.amountDue, detail.order.currencyCode));
  }
  if (methods) {
    methods.innerHTML = gateways.map((gateway) => {
      const selected = gateway === selectedGateway;
      return `<button type="button" role="radio" aria-checked="${selected}" data-recovery-gateway="${escapeHtml(gateway)}" class="min-h-11 rounded-lg border px-3 py-2 text-start text-sm text-foreground transition-colors hover:bg-muted ${selected ? "border-primary bg-primary/10" : "border-border bg-background"}">${gatewayMarkup(gateway)}</button>`;
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
    script.addEventListener("error", () => reject(new CheckoutBuyerMessage(accountCopy().recovery.cardFormUnavailable)), { once: true });
  });
  return stripeScript;
}

async function prepareStripe(session: CustomerOrderPaymentSession): Promise<void> {
  const stripe = session.stripe;
  const words = accountCopy().recovery;
  if (!stripe?.publishableKey || !stripe.clientSecret) throw new CheckoutBuyerMessage(words.cardCouldNotStart);
  await loadStripeScript();
  if (!detailWindow.Stripe) throw new CheckoutBuyerMessage(words.cardFormUnavailable);
  stripeClientSecret = stripe.clientSecret;
  stripeOrderId = currentDetail?.order.id ?? null;
  if (!stripeCard) {
    stripeInstance = detailWindow.Stripe(stripe.publishableKey);
    // The page's colours where the card mounts, again whenever the colour scheme changes.
    const styled = byId("accountStripeCardElement") ?? document.body;
    stripeCard = stripeInstance.elements().create("card", { style: stripeCardStyle(styled, "15px") });
    stripeCard.mount("#accountStripeCardElement");
    stopFollowingScheme = followColorScheme(styled, "15px", stripeCard);
    // Stripe's own message is in Stripe's language: the field to check is the page's copy.
    stripeCard.on("change", (event) => setStripeError(event.error ? copy[stripeErrorCopyKey(event.error, "cardDetailsIncompleteText")] : null));
  }
  byId("accountStripeSection")?.classList.remove("hidden");
  setRecoveryMessage(words.enterCardThenConfirm);
  setRecoveryButton(words.confirmCard);
}

async function confirmStripe(): Promise<void> {
  const words = accountCopy().recovery;
  if (!stripeInstance || !stripeCard || !stripeClientSecret) {
    setRecoveryMessage(words.cardNotReady, "error");
    return;
  }
  recoveryLoading = true;
  setRecoveryButton(words.confirming, true);
  try {
    const { error, paymentIntent } = await stripeInstance.confirmCardPayment(stripeClientSecret, {
      payment_method: { card: stripeCard },
    });
    if (error) throw new CheckoutCopyError(stripeErrorCopyKey(error, "cardPaymentFailedText"), error.message);
    if (paymentIntent?.status !== "succeeded" && paymentIntent?.status !== "requires_capture") {
      throw new CheckoutBuyerMessage(words.notCompleted);
    }
    setRecoveryMessage(words.submitted, "success");
    setRecoveryButton(words.updating, true);
    window.setTimeout(() => void loadOrderDetail(), 1500);
  } catch (error: unknown) {
    setRecoveryMessage(checkoutFailureText(error, copy, "cardPaymentFailedText"), "error");
    setRecoveryButton(words.confirmCard);
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
  const words = accountCopy().recovery;
  setRecoveryButton(words.preparing, true);
  setStripeError(null);
  try {
    const result = await createCustomerOrderPaymentSession(detail.order.id, {
      gateway: selectedGateway,
      replaceExistingAttempt: detail.paymentRecovery.paymentType !== "balance",
      onProcessing: (event) => setRecoveryMessage(words.retryingIn(event.message, formatCount(event.retryAfterSeconds))),
    });
    if (!result.success || !result.session) throw new CheckoutBuyerMessage(writeError(result, words.couldNotStart));
    if (result.session.gateway === "stripe") {
      selectedGateway = "stripe";
      await prepareStripe(result.session);
      return;
    }
    const gatewayUrl = normalizeHostedGatewayUrl(result.session.hosted?.gatewayUrl);
    if (!gatewayUrl) throw new CheckoutBuyerMessage(words.pageCouldNotOpen);
    setRecoveryButton(words.redirecting, true);
    window.location.assign(gatewayUrl);
  } catch (error: unknown) {
    setRecoveryMessage(checkoutFailureText(error, copy, "paymentStartFailedText"), "error");
    setRecoveryButton(recoveryButtonLabel(selectedGateway));
  } finally {
    recoveryLoading = false;
  }
}

// ---------- order help ----------

function supportReasons(type: CustomerOrderSupportRequestType): readonly string[] {
  const words = accountCopy().order;
  return type === "cancel_pre_shipment" ? words.cancelReasons : words.returnReasons;
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
  setSupportButton(accountCopy().order.submit);
  const message = byId<HTMLTextAreaElement>("orderSupportMessage");
  if (message) message.value = "";
  byId("orderSupportForm")?.classList.add("hidden");
}

function openSupportForm(type: CustomerOrderSupportRequestType): void {
  const action = currentDetail?.supportRequestActions.find((item) => item.type === type);
  if (!action?.eligible || supportLoading) return;
  selectedSupportType = type;
  setSupportError(null);
  setSupportButton(accountCopy().order.submit);
  const title = byId("orderSupportFormTitle");
  if (title) title.textContent = getOrderReceiptSupportActionLabel(action.type, copy);
  const reasons = byId("orderSupportReasons");
  if (reasons) {
    reasons.innerHTML = supportReasons(type).map((reason) => `
      <label class="flex min-h-11 items-center gap-3 text-sm text-foreground">
        <input type="radio" name="orderSupportReason" value="${escapeHtml(reason)}" class="h-4 w-4 accent-primary" />
        ${escapeHtml(reason)}
      </label>`).join("");
  }
  // A return names its items: each delivered line, with how many come back (buyer QA m4).
  const lines = type === "return" ? action.returnableItems ?? [] : [];
  const itemsField = byId("orderSupportItemsField");
  const itemsList = byId("orderSupportItems");
  if (itemsField) itemsField.hidden = lines.length === 0;
  if (itemsList) {
    const words = accountCopy().order;
    itemsList.innerHTML = lines.map((line) => {
      const name = line.variantLabel ? `${line.productName} (${line.variantLabel})` : line.productName;
      return `
      <div class="flex min-h-11 items-center gap-3 text-sm text-foreground">
        <input type="checkbox" name="orderSupportItem" value="${escapeHtml(line.orderItemId)}" id="returnItem-${escapeHtml(line.orderItemId)}" class="h-4 w-4 accent-primary" />
        <label for="returnItem-${escapeHtml(line.orderItemId)}" class="min-w-0 flex-1">${escapeHtml(name)}</label>
        ${line.quantity > 1 ? `<input type="number" inputmode="numeric" min="1" max="${line.quantity}" value="1" data-return-quantity="${escapeHtml(line.orderItemId)}" aria-label="${escapeHtml(words.returnQuantityFor.replace("{name}", name))}" class="${RETURN_QUANTITY_CLASS}" />` : ""}
      </div>`;
    }).join("");
  }
  const message = byId<HTMLTextAreaElement>("orderSupportMessage");
  if (message) message.value = "";
  byId("orderSupportForm")?.classList.remove("hidden");
  (itemsList?.querySelector("input") ?? reasons?.querySelector("input"))?.focus();
}

const RETURN_QUANTITY_CLASS = "h-11 w-20 rounded-lg border border-input bg-background px-2 text-end tabular-nums";

/** The chosen return lines; null when the form names items but none is chosen. */
function chosenReturnItems(): Array<{ orderItemId: string; quantity: number }> | null | undefined {
  const field = byId("orderSupportItemsField");
  if (!field || field.hidden) return undefined;
  const chosen = [...document.querySelectorAll<HTMLInputElement>('input[name="orderSupportItem"]:checked')].map((box) => {
    const quantityInput = document.querySelector<HTMLInputElement>(`input[data-return-quantity="${CSS.escape(box.value)}"]`);
    const max = Number(quantityInput?.max ?? 1);
    const typed = Math.floor(Number(quantityInput?.value ?? 1));
    return { orderItemId: box.value, quantity: Math.min(Math.max(1, Number.isFinite(typed) ? typed : 1), max) };
  });
  return chosen.length > 0 ? chosen : null;
}

function renderSupport(detail: AccountOrderDetail): void {
  // A closed order (cancelled, refunded) offers no request: no "Send a request" line for it.
  const canRequest = detail.supportRequestActions.length > 0;
  const intro = byId("orderSupportIntro");
  if (intro) {
    // The store's own words, else the page language's.
    intro.textContent = canRequest ? detail.supportRequestIntro ?? accountCopy().order.helpIntro : "";
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
      <button type="button" data-support-request-type="${escapeHtml(action.type)}" ${action.eligible ? "" : "disabled"} class="min-h-11 rounded-lg border border-border px-3 py-2 text-start text-sm transition-colors ${action.eligible ? "text-foreground hover:bg-muted" : "cursor-not-allowed text-muted-foreground"}">
        <span class="font-medium">${escapeHtml(getOrderReceiptSupportActionLabel(action.type, copy))}</span>
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
  const words = accountCopy().order;
  const items = chosenReturnItems();
  if (items === null) {
    setSupportError(words.chooseReturnItems);
    document.querySelector<HTMLInputElement>('input[name="orderSupportItem"]')?.focus();
    return;
  }
  if (!reason) {
    setSupportError(words.chooseReason);
    return;
  }
  if (reason === words.other && !message) {
    setSupportError(words.tellStore);
    byId("orderSupportMessage")?.focus();
    return;
  }
  supportLoading = true;
  setSupportError(null);
  setSupportButton(words.submitting, true);
  const result = await createCustomerOrderSupportRequest(detail.order.id, { type: selectedSupportType, reason, message, ...(items ? { items } : {}) });
  supportLoading = false;
  if (!result.success) {
    setSupportError(writeError(result, words.requestFailed));
    setSupportButton(words.submit);
    return;
  }
  hideSupportForm();
  await loadOrderDetail();
}

// ---------- buy again ----------

/** The order list's Buy again link lands here with this hash. */
export const BUY_AGAIN_HASH = "#buy-again";

async function buyAgain(): Promise<void> {
  const button = byId<HTMLButtonElement>("orderBuyAgain");
  const message = byId("orderBuyAgainMessage");
  if (!currentDetail || !button || button.disabled) return;
  button.disabled = true;
  if (message) message.textContent = "";
  const status = await putOrderInCart({ currencyCode: currentDetail.order.currencyCode ?? null, lines: currentDetail.items });
  button.disabled = false;
  if (message) message.textContent = status;
}

// ---------- page ----------

function renderProgress(detail: AccountOrderDetail): void {
  const progress = byId("orderProgress");
  // The API's steps and updates in the page's words (by their keys), then
  // pickup and no-delivery orders track as "Ready for pickup"/"Picked up" or "Preparing"/"Completed".
  const courier = detail.shipments[0] ? detail.shipments[0].providerName || detail.shipments[0].courierName : null;
  const worded = presentOrderTracking(detail, courier, detail.order, copy);
  if (progress && worded.progress) progress.innerHTML = orderProgressMarkup(worded.progress, trackingText());
  const expected = byId("orderExpectedDelivery");
  if (expected) {
    const show = Boolean(detail.order.expectedDelivery)
      && resolveOrderDeliveryBlock(detail.order, copy).mode === "ship"
      && !detail.progress?.outcome
      && !detail.progress?.steps[3]?.done;
    expected.textContent = show ? accountCopy().order.expectedDelivery(detail.order.expectedDelivery!) : "";
    expected.classList.toggle("hidden", !show);
  }
  const timeline = byId("orderTimeline");
  if (timeline) timeline.innerHTML = orderTimelineMarkup(worded.timeline, trackingText());
}

function renderItemsAndSummary(detail: AccountOrderDetail): void {
  const { order } = detail;
  const places = order.currencyDecimalPlaces ?? 2;
  const minor = (value: number) => accountMoney(fromMinor(value, places), order.currencyCode);
  const items = byId("orderItems");
  // An order-level promotion is one line in the summary, never a discount on each item.
  const showsLineDiscounts = orderShowsLineDiscounts(detail.discounts);
  const words = accountCopy().order;
  // The apps' add-ons as their own summary rows (the server's, from the order's frozen lines): the rows then show the items alone.
  const addOns = addOnRowsOver(order.subtotalAmountMinor ?? 0, readAddOnRows(detail.addOns));
  const addOnsInSummary = addOns.rows.length > 0;
  if (items) {
    type Row = AccountOrderDetail["items"][number];
    const answerWords = longAnswerWords(pageLanguage());
    /** A row's own amounts: what the apps charged on it is a summary row, never part of its price. */
    const amountsOf = (item: Row) => rowItemsOnly(item.lineSubtotalMinor != null
      ? { unitPriceMinor: item.unitPriceMinor ?? null, grossSubtotalMinor: item.lineSubtotalMinor, discountMinor: item.discountAmountMinor ?? 0 }
      : null, item, addOnsInSummary);
    const rowsMarkup = (rows: ReturnType<typeof orderLinePropertyRows>) => rows.length > 0
      ? `<ul class="text-muted-foreground">${rows.map((row) => `<li class="break-words">${longAnswerHtml(row.text, answerWords, `<span class="text-foreground">${escapeHtml(row.label)}:</span> ${escapeHtml(row.value)}${row.surcharge ? ` (${escapeHtml(row.surcharge)})` : ""}`)}</li>`).join("")}</ul>`
      : "";
    const addOnRowsOf = (rows: readonly Row[]) => buyerLineAddOnRows(
      rows.flatMap((row) => readBuyerLineAddOns((row as { addOns?: unknown }).addOns)),
      { label: copy.lineAddOnText, money: minor, language: pageLanguage() },
    );
    const nameMarkup = (item: Row) => {
      const name = escapeHtml(item.productName || words.product);
      return item.productSlug
        ? `<a href="${escapeHtml(pagePath(`/products/${encodeURIComponent(item.productSlug)}`))}" class="font-medium text-foreground hover:underline" data-part="line-title">${name}</a>`
        : `<p class="font-medium text-foreground" data-part="line-title">${name}</p>`;
    };
    // The image in its box, as the cart draws it: a theme sizes the box and fits the image in it.
    const image = (item: Row) => `<div class="h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-border bg-card" data-part="line-image"><img src="${escapeHtml(getProductImageUrl(item.productImage, 128))}" alt="" class="h-full w-full object-contain" loading="lazy" /></div>`;
    // The apps' blocks for one row (`order.line.after`, keyed by the row's id as the API keys them), under it.
    const lineTarget = (item: Row) => {
      const name = item.productName || words.product;
      return `<div data-buyer-ui-target="order.line.after" data-buyer-ui-line="${escapeHtml(item.id)}" data-buyer-ui-line-name="${escapeHtml(item.variantLabel ? `${name} (${item.variantLabel})` : name)}" class="mt-2 grid gap-2" hidden></div>`;
    };
    // Files, keys, card codes, the store's message and the review form get the line's full width.
    const extrasOf = (item: Row) => lineExtrasMarkup(item, { orderId: order.id, access: "account", languageData: copy });
    const priceMarkup = (amounts: ReturnType<typeof amountsOf>, fallback: number) => {
      const total = amounts ? minor(presentedLineTotalMinor(amounts, showsLineDiscounts)) : accountMoney(fallback, order.currencyCode);
      // A free gift reads its full price struck, then zero.
      const struck = amounts && isFreeOrderLine(amounts) ? `<s class="me-1.5 text-muted-foreground">${escapeHtml(minor(amounts.grossSubtotalMinor))}</s>` : "";
      return `<p class="shrink-0 text-sm font-medium tabular-nums text-foreground" data-part="line-price">${struck}${escapeHtml(total)}</p>`;
    };
    const lineMarkup = (item: Row) => {
      // A kit's item charged as two lines is one row here, its unit price null when its total does not divide.
      const amounts = amountsOf(item);
      const unit = amounts?.unitPriceMinor != null ? minor(amounts.unitPriceMinor) : amounts
        ? minor(Math.round(amounts.grossSubtotalMinor / Math.max(1, item.quantity)))
        : accountMoney(item.unitPrice, order.currencyCode);
      // Buyer inputs (display only, escaped), then what the apps charged on the row: its `addOns`, the one place a row says it.
      const properties = [
        ...orderLinePropertyRows(item.properties, (property) => minor(property.priceMinor), copy),
        ...addOnRowsOf([item]),
      ];
      const extras = extrasOf(item);
      return `<li class="py-4 first:pt-0 last:pb-0" data-part="line"><div class="flex gap-3">
        ${image(item)}
        <div class="min-w-0 flex-1 text-sm">
          ${nameMarkup(item)}
          <div data-part="line-details">
            ${item.variantLabel ? `<p class="text-muted-foreground">${escapeHtml(item.variantLabel)}</p>` : ""}
            ${rowsMarkup(properties)}
            <p class="text-muted-foreground">${escapeHtml(words.quantity(formatCount(item.quantity), unit))}</p>
            ${showsLineDiscounts && (item.discountAmountMinor ?? 0) > 0 ? `<p class="text-muted-foreground">${escapeHtml(words.lineDiscount(minor(item.discountAmountMinor!)))}</p>` : ""}
          </div>
        </div>
        ${priceMarkup(amounts, item.lineTotal)}
      </div>${extras ? `<div class="text-sm sm:ps-[4.75rem]">${extras}</div>` : ""}${lineTarget(item)}</li>`;
    };
    /**
     * One bundle as the buyer bought it: its name, sets and price once, the
     * add-ons charged on it once, then each item with what only it has (how
     * many each set holds, its inputs, its delivery state, its keys, the
     * store's message, its review).
     */
    const bundleMarkup = (entry: Extract<OrderEntry<Row>, { kind: "bundle" }>) => {
      const rows = entry.rows;
      const amounts = rows.map(amountsOf);
      const exact = amounts.every((amount) => amount !== null);
      const totalMinor = exact ? amounts.reduce((sum, amount) => sum + presentedLineTotalMinor(amount!, showsLineDiscounts), 0) : null;
      const total = totalMinor ?? rows.reduce((sum, row) => sum + row.lineTotal, 0);
      const units = entry.units;
      const perSet = units && totalMinor !== null && totalMinor % units === 0 ? minor(totalMinor / units) : null;
      const quantity = units ? (perSet ? words.quantity(formatCount(units), perSet) : words.sets(formatCount(units))) : "";
      const itemMarkup = (item: Row) => {
        const status = orderLineGroupStatusText(groupOrderLines([item], order, copy)[0] ?? { statusLabel: null, progressLabel: null });
        // How many each set holds; the row's units when the sets are not known.
        const each = item.bundle?.perUnit && entry.units ? words.perSet(formatCount(item.bundle.perUnit)) : words.sets(formatCount(item.quantity));
        const extras = extrasOf(item);
        return `<li class="py-3 first:pt-0 last:pb-0" data-bundle-item><div class="flex gap-3">
          ${image(item)}
          <div class="min-w-0 flex-1 text-sm">
            ${nameMarkup(item)}
            <div data-part="line-details">
              ${item.variantLabel ? `<p class="text-muted-foreground">${escapeHtml(item.variantLabel)}</p>` : ""}
              ${rowsMarkup(orderLinePropertyRows(withoutBundleEntry(item.properties), (property) => minor(property.priceMinor), copy))}
              <p class="text-muted-foreground">${escapeHtml([each, status].filter(Boolean).join(" · "))}</p>
            </div>
          </div>
        </div>${extras ? `<div class="text-sm sm:ps-[4.75rem]">${extras}</div>` : ""}${lineTarget(item)}</li>`;
      };
      return `<li class="py-4 first:pt-0 last:pb-0" data-order-bundle="${escapeHtml(entry.bundle.id)}" data-part="line">
        <div class="flex gap-3">
          <div class="min-w-0 flex-1 text-sm">
            <p class="font-medium text-foreground" data-part="line-title">${escapeHtml(entry.bundle.title)}</p>
            <div data-part="line-details">
              ${rowsMarkup(addOnRowsOf(rows))}
              ${quantity ? `<p class="text-muted-foreground">${escapeHtml(quantity)}</p>` : ""}
            </div>
          </div>
          <p class="shrink-0 text-sm font-medium tabular-nums text-foreground" data-part="line-price">${escapeHtml(totalMinor !== null ? minor(totalMinor) : accountMoney(total, order.currencyCode))}</p>
        </div>
        <ul class="mt-3 divide-y divide-border border-s-2 border-border ps-3">${rows.map(itemMarkup).join("")}</ul>
      </li>`;
    };
    const entryMarkup = (entry: OrderEntry<Row>) => entry.kind === "row" ? lineMarkup(entry.row) : bundleMarkup(entry);
    const entries = orderEntries(detail.items);
    const groups = groupOrderLines(detail.items, order, copy);
    // A bundle sits whole in the group of its first item, never split across groups.
    const typeOf = (entry: OrderEntry<Row>) => groupOrderLines([entry.kind === "row" ? entry.row : entry.rows[0]!], order, copy)[0]?.type;
    items.innerHTML = showsOrderLineGroupHeadings(groups)
      ? groups.flatMap((group) => {
          const members = entries.filter((entry) => typeOf(entry) === group.type);
          if (members.length === 0) return [];
          const status = orderLineGroupStatusText(group);
          return [`<li class="py-4 first:pt-0 last:pb-0" data-order-line-group="${escapeHtml(group.type)}">
        <div class="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h3 class="text-sm font-semibold text-foreground">${escapeHtml(group.heading)}</h3>
          ${status ? `<p class="text-sm text-muted-foreground">${escapeHtml(status)}</p>` : ""}
        </div>
        <ul class="divide-y divide-border">${members.map(entryMarkup).join("")}</ul>
      </li>`];
        }).join("")
      : entries.map(entryMarkup).join("");
  }

  const summary = byId("orderSummary");
  if (summary) {
    const cell = (value: string, className = "") => `<span${className ? ` class="${className}"` : ""}>${escapeHtml(value)}</span>`;
    // Rows of label and amount, as on every money summary (an add-on row may open to its app's lines).
    const row = (label: string, valueHtml: string, kind: MoneySummaryRow) =>
      `<div class="flex justify-between gap-4 ${kind === "total" ? "border-t border-border pt-2 font-semibold text-foreground" : "text-muted-foreground"}" data-summary-row="${kind}"><dt${kind === "total" ? ' data-part="summary-total-label"' : ""}>${escapeHtml(label)}</dt><dd class="text-end tabular-nums">${valueHtml}</dd></div>`;
    const major = (value: number) => fromMinor(value, places);
    const money = (value: number) => accountMoney(value, order.currencyCode);
    const tax = order.taxAmountMinor ?? 0;
    const giftCardTenders = readReceiptGiftCardTenders(paymentFacts(detail));
    const paymentLine = orderPaymentLine(paymentFacts(detail), copy);
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
      row(words.subtotal, cell(minor(addOns.itemsSubtotalMinor)), "subtotal"),
      ...addOns.rows.map((addOn) => addOnRowHtml(addOn, minor(addOn.amountMinor), "account")),
      !showsDeliveryRow ? "" : row(
        deliveryRow.label,
        [
          deliveryRow.struck ? `<s class="me-1.5">${escapeHtml(deliveryRow.struck)}</s>` : "",
          cell(deliveryRow.value, "text-foreground"),
          deliveryRow.codes ? ` ${cell(`(${deliveryRow.codes})`)}` : "",
        ].join(""),
        "delivery",
      ),
      ...lines.map((line) => row(line.label, cell(`−${money(line.amount)}`, "text-foreground"), "discount")),
      tax > 0 ? row(order.pricesIncludeTax ? words.taxIncluded(order.taxLabel || words.tax) : order.taxLabel || words.tax, cell(minor(tax)), "tax") : "",
      row(words.total, cell(minor(order.totalAmountMinor ?? 0)), "total"),
      // Gift cards are payment: one row per card after the total, then what is left.
      ...giftCardTenders.map((tender) =>
        row(receiptGiftCardTenderLabel(tender, copy), cell(`−${money(tender.amount)}`, "text-foreground"), "paid")),
      giftCardTenders.length > 0 && paymentLine.balanceDue > 0
        ? row(paymentLine.balanceLabel, cell(money(paymentLine.balanceDue), "font-medium text-foreground"), "due")
        : "",
    ].join("");
  }
}

function renderDelivery(detail: AccountOrderDetail): void {
  const { order } = detail;
  const words = accountCopy().order;
  const block = resolveOrderDeliveryBlock(order, copy);
  const heading = byId("deliveryHeading");
  if (heading) {
    heading.textContent = block.mode === "pickup" ? block.heading : block.mode === "none" ? copy.orderReceiptDeliveryText : words.shippingAddress;
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
            formatOrderPlaces(order, pageLanguage()),
            order.shippingMethodName ? words.deliveryMethod(order.shippingMethodName) : null,
          ];
    address.innerHTML = [
      order.customerName,
      order.customerPhone ? pagePhone(order.customerPhone) : null,
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
  // The apps' answers the buyer gave (a delivery day and window), under the apps' words, in the page's language.
  const answers = byId("orderAppAnswers");
  if (answers) {
    const language = pageLanguage();
    answers.innerHTML = presentCheckoutAttributes(detail.appAnswers ?? {}, detail.attributeApps ?? [], {
      locale: language, defaultLocale: language, words: copy, region: storeRegion(),
    }).map((group) => `<div class="mt-3 border-t border-border pt-3"><p class="font-medium text-foreground">${escapeHtml(group.appName)}</p>${group.entries
      .map((entry) => `<p class="break-words text-muted-foreground">${escapeHtml(entry.label)}: <span class="text-foreground">${escapeHtml(entry.value)}</span></p>`).join("")}</div>`).join("");
  }
  const shipments = byId("orderShipments");
  if (shipments) {
    shipments.innerHTML = detail.shipments.map((shipment) => {
      const updated = formatAccountDate(shipment.lastChecked || shipment.updatedAt || shipment.createdAt);
      return orderShipmentMarkup({
        statusLabel: accountShipmentStatusText(shipment.status),
        courier: shipment.providerName || shipment.courierName,
        trackingId: shipment.trackingId,
        trackingUrl: trackingUrl(shipment),
        updated: updated ? words.updated(updated) : null,
      }, trackingText());
    }).join("");
  }
}

function renderPayment(detail: AccountOrderDetail): void {
  const { order } = detail;
  // "Gift card + Cash on delivery" and "৳800 due on delivery" when cards paid part.
  const line = orderPaymentLine(paymentFacts(detail), copy);
  const words = accountCopy().order;
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
      // An invoice still owed: "Payment due by November 20, 2026 (net 30)", as the receipt says it.
      order.paymentTerms && line.balanceDue > 0
        ? `<p class="text-muted-foreground" data-payment-terms>${escapeHtml(checkoutText(order.paymentTerms.overdue ? copy.invoiceOverdueText : copy.invoiceDueText, {
          date: formatStoreDateTime(new Date(order.paymentTerms.dueAt), pageLanguage(), { dateStyle: "long" }),
          days: formatCount(order.paymentTerms.days),
        }))}</p>`
        : "",
      // The card rows in the summary already say what the gift cards paid.
      line.balanceDue > 0 && order.paidAmount > 0 && !paidByGiftCards ? `<p class="text-muted-foreground">${escapeHtml(words.paid(money(order.paidAmount)))}</p>` : "",
      detail.cod?.collectedAmount ? `<p class="text-muted-foreground">${escapeHtml(words.collected(money(detail.cod.collectedAmount)))}</p>` : "",
      detail.paymentPlan ? `<p class="text-muted-foreground">${escapeHtml(words.advance(money(detail.paymentPlan.depositAmount)))}</p>` : "",
      refunds,
    ].join("");
  }
  const refundNotice = byId("orderRefundNotice");
  if (refundNotice) {
    const active = detail.activeRefundOperation;
    refundNotice.classList.toggle("hidden", !active);
    refundNotice.innerHTML = active
      ? `<p class="font-medium">${escapeHtml(active.label)}</p><p class="mt-1">${escapeHtml(active.message)} ${escapeHtml(words.refundOnWay(money(active.amount)))}</p>`
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
  const words = accountCopy().order;
  const title = byId("orderTitle");
  if (title) title.textContent = words.title(pageOrderNumber(order.orderNumber, order.id));
  const subtitle = byId("orderSubtitle");
  if (subtitle) subtitle.textContent = words.placed(formatAccountDate(order.createdAt));
  const status = byId("orderStatus");
  // A finished pickup order reads "Picked up"; a service/digital-only one "Completed", never "Delivered".
  if (status) {
    status.className = accountPill(orderStatusTone(detail.buyerView.status));
    status.dataset.part = "status-badge";
    status.textContent = buyerOrderStatusText(detail.buyerView.status, copy);
  }
  renderReturnNotice();
  renderProgress(detail);
  renderItemsAndSummary(detail);
  renderDelivery(detail);
  renderPayment(detail);
  renderSupport(detail);
  renderPaymentRecovery(detail);
  void renderBuyerUiWhenNeeded(detail.buyerUi ?? [], { root: document, onChange: loadOrderDetail });
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
  readCheckoutCopy();
  const words = accountCopy().order;
  showOnly("loading");
  const orderId = root.dataset.orderId ?? "";
  if (!orderId) return showError(words.notFound, words.linkIncomplete, false);

  const session = await getCustomerSession();
  if (detailWindow.__scaliusOrderDetailRun !== run) return;
  if (session.unavailable) return showError(words.unreachable, accountOfflineMessage());
  if (!session.authenticated) {
    currentDetail = null;
    hideRecovery();
    return showOnly("unauth");
  }

  const [result, checkoutConfig] = await Promise.all([getCustomerOrderDetail(orderId, { buyerUi: true }), getCheckoutConfig()]);
  if (detailWindow.__scaliusOrderDetailRun !== run) return;
  if (!result.success || !result.detail) {
    if (result.status === 401) return showOnly("unauth");
    return result.status === 404
      ? showError(words.notFound, words.notInAccount, false)
      : showError(words.unreachable, accountOfflineMessage());
  }
  try {
    renderOrderDetail(result.detail as AccountOrderDetail, checkoutConfig);
    showOnly("content");
    // "Buy again" on the order list that opened this page (before its own
    // script could add the lines): add them now, once (buyer QA m6).
    if (window.location.hash === BUY_AGAIN_HASH) {
      history.replaceState(history.state, "", window.location.pathname + window.location.search);
      void buyAgain();
    }
  } catch (error) {
    console.error("[customer-order-detail] render failed", error);
    showError(words.wentWrong, words.couldNotShow);
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
