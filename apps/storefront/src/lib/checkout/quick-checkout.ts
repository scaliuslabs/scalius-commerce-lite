/**
 * Checkout without JavaScript (`/checkout/quick`): the quick-buy line from
 * `/buy/<slug>` is carried in the form body, every step is a plain POST, and
 * the page answers with the next thing it needs (a thana, a delivery option)
 * and, once it has everything, the API's reviewed total with its quote
 * fingerprint. "Place order" then commits a cash-on-delivery order exactly as
 * the cart's COD form does (`processOrder`).
 *
 * Nothing buyer-specific travels in a URL; the checkout id makes a resubmitted
 * form (refresh, double tap) the same order.
 */
import { nanoid } from "nanoid";
import { validateAndFormatPhone } from "@scalius/shared/customer-utils";
import { escapeHtml } from "@scalius/shared/html-escape";
import type { ShippingMethod } from "@/lib/api/types";
import type { CheckoutTaxQuote } from "./tax-quote-contract";

export const QUICK_CHECKOUT_PATH = "/checkout/quick";
/** The form is small; anything larger is not it. */
export const QUICK_CHECKOUT_MAX_BODY_BYTES = 32 * 1024;

const CHECKOUT_ID_PATTERN = /^chk_session_[A-Za-z0-9_-]{8,64}$/;
const FINGERPRINT_PATTERN = /^taxq_[A-Za-z0-9_-]{22}$/;
const ID_PATTERN = /^[A-Za-z0-9_:-]{1,180}$/;

export type QuickCheckoutMode = "delivery" | "pickup" | "none";

export interface QuickCheckoutForm {
  /** The cart lines as the cart keeps them (`{ [cartKey]: CartItem }`), JSON. */
  cartItems: string;
  checkoutId: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  /** What the buyer chose; `none` is decided from the lines, never posted. */
  deliveryMode: "delivery" | "pickup";
  shippingAddress: string;
  city: string;
  zone: string;
  shippingLocation: string;
  notes: string;
  discountCode: string;
  expectedQuoteFingerprint: string;
  intent: "review" | "place";
}

function text(form: FormData, name: string, maxLength: number): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function id(form: FormData, name: string): string {
  const value = text(form, name, 180);
  return ID_PATTERN.test(value) ? value : "";
}

/**
 * The `<noscript>` part of the `/buy/<slug>` page: the line, in the body of a
 * form, on to this checkout. With scripts on it is inert and the page's
 * script adds the line to the cart as before.
 */
export function quickBuyNoScriptForm(cartItems: Record<string, unknown>): string {
  return `<noscript>
          <style>.loader, #status-text { display: none; }</style>
          <form method="post" action="${QUICK_CHECKOUT_PATH}">
            <input type="hidden" name="cartItems" value="${escapeHtml(JSON.stringify(cartItems))}">
            <input type="hidden" name="checkoutId" value="${newQuickCheckoutId()}">
            <button type="submit" style="width:100%;min-height:44px;border:0;border-radius:0.5rem;background:#111827;color:#fff;font:inherit;font-weight:600;cursor:pointer">Continue to checkout</button>
          </form>
        </noscript>`;
}

export function newQuickCheckoutId(): string {
  return `chk_session_${nanoid()}`;
}

export function readQuickCheckoutForm(form: FormData): QuickCheckoutForm {
  const checkoutId = text(form, "checkoutId", 80);
  const fingerprint = text(form, "expectedQuoteFingerprint", 40);
  return {
    cartItems: text(form, "cartItems", 24 * 1024),
    checkoutId: CHECKOUT_ID_PATTERN.test(checkoutId) ? checkoutId : newQuickCheckoutId(),
    customerName: text(form, "customerName", 100),
    customerPhone: text(form, "customerPhone", 20),
    customerEmail: text(form, "customerEmail", 254),
    deliveryMode: form.get("deliveryMode") === "pickup" ? "pickup" : "delivery",
    shippingAddress: text(form, "shippingAddress", 500),
    city: id(form, "city"),
    zone: id(form, "zone"),
    shippingLocation: id(form, "shippingLocation"),
    notes: text(form, "notes", 500),
    discountCode: text(form, "discountCode", 50).toUpperCase(),
    expectedQuoteFingerprint: FINGERPRINT_PATTERN.test(fingerprint) ? fingerprint : "",
    intent: form.get("intent") === "place" ? "place" : "review",
  };
}

export interface QuickCheckoutLine {
  cartKey: string;
  name: string;
  quantity: number;
  fulfillmentKind: string | null;
}

/** The posted lines, or null when there is nothing (or nothing readable) to buy. */
export function readQuickCheckoutLines(cartItems: string): QuickCheckoutLine[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(cartItems);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const lines = Object.entries(parsed as Record<string, unknown>).flatMap(([cartKey, entry]) => {
    if (typeof entry !== "object" || entry === null) return [];
    const item = entry as Record<string, unknown>;
    if (typeof item.id !== "string" || typeof item.variantId !== "string" || typeof item.name !== "string") return [];
    if (typeof item.quantity !== "number" || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 99) return [];
    return [{
      cartKey,
      name: item.name,
      quantity: item.quantity,
      fulfillmentKind: typeof item.fulfillmentKind === "string" ? item.fulfillmentKind : null,
    }];
  });
  return lines.length > 0 && lines.length <= 20 ? lines : null;
}

/** Something physical (or of unknown kind) needs a delivery or pickup option. */
export function quickCheckoutNeedsDelivery(lines: readonly QuickCheckoutLine[]): boolean {
  return lines.some((line) => !line.fulfillmentKind || line.fulfillmentKind === "physical");
}

export function quickCheckoutMode(
  lines: readonly QuickCheckoutLine[],
  form: Pick<QuickCheckoutForm, "deliveryMode">,
  offersPickup: boolean,
  offersDelivery: boolean,
): QuickCheckoutMode {
  if (!quickCheckoutNeedsDelivery(lines)) return "none";
  if (!offersDelivery) return "pickup";
  return offersPickup && form.deliveryMode === "pickup" ? "pickup" : "delivery";
}

/**
 * The option the total is quoted with: the buyer's choice while it is still
 * offered, otherwise the first one, so the buyer sees a total at once and can
 * change it.
 */
export function chooseQuickCheckoutRate(
  rates: readonly Pick<ShippingMethod, "id">[],
  chosen: string,
): string {
  return rates.find((rate) => rate.id === chosen)?.id ?? rates[0]?.id ?? "";
}

export type QuickCheckoutFieldError =
  | "customerName"
  | "customerPhone"
  | "customerEmail"
  | "shippingAddress"
  | "city"
  | "zone";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Contact and address problems, checked only when the buyer asks to place the order. */
export function quickCheckoutFieldErrors(
  form: QuickCheckoutForm,
  mode: QuickCheckoutMode,
  minAddressLength: number,
): QuickCheckoutFieldError[] {
  const errors: QuickCheckoutFieldError[] = [];
  if (form.customerName.length < 3) errors.push("customerName");
  try {
    validateAndFormatPhone(form.customerPhone);
  } catch {
    errors.push("customerPhone");
  }
  if (form.customerEmail && !EMAIL_PATTERN.test(form.customerEmail)) errors.push("customerEmail");
  if (mode === "delivery") {
    if (form.shippingAddress.length < minAddressLength) errors.push("shippingAddress");
    if (!form.city) errors.push("city");
    else if (!form.zone) errors.push("zone");
  }
  return errors;
}

/**
 * What the tax quote is asked for (the shape `fetchAuthoritativeTaxQuote`
 * reads), or null while the address or option it needs is still missing.
 */
export function quickCheckoutQuoteInput(
  form: QuickCheckoutForm,
  mode: QuickCheckoutMode,
  rateId: string,
): Record<string, unknown> | null {
  if (mode !== "none" && !rateId) return null;
  if (mode === "delivery" && (!form.city || !form.zone)) return null;
  let customerPhone: string | undefined;
  try {
    customerPhone = validateAndFormatPhone(form.customerPhone);
  } catch {
    customerPhone = undefined;
  }
  return {
    cartItems: form.cartItems,
    deliveryMode: mode,
    ...(mode === "delivery" ? { city: form.city, zone: form.zone } : {}),
    ...(mode === "none" ? {} : { shippingMethodId: rateId }),
    discountCodes: form.discountCode ? JSON.stringify([form.discountCode]) : "[]",
    ...(customerPhone ? { customerPhone } : {}),
  };
}

/**
 * The order form `processOrder` reads, built from the reviewed state: only
 * the codes the quote applied go to the order.
 */
export function quickCheckoutOrderForm(
  form: QuickCheckoutForm,
  mode: QuickCheckoutMode,
  rateId: string,
  quote: Pick<CheckoutTaxQuote, "discounts">,
): FormData {
  const data = new FormData();
  const codes = quote.discounts.flatMap(({ code }) => (code ? [code] : []));
  const values: Record<string, string> = {
    formIntent: "checkout",
    cartItems: form.cartItems,
    checkoutId: form.checkoutId,
    expectedQuoteFingerprint: form.expectedQuoteFingerprint,
    customerName: form.customerName,
    customerPhone: form.customerPhone,
    customerEmail: form.customerEmail,
    notes: form.notes,
    discountCodes: codes.length > 0 ? JSON.stringify(codes) : "",
    deliveryMode: mode === "pickup" ? "pickup" : "delivery",
    ...(mode === "none" ? {} : { shippingLocation: rateId }),
    ...(mode === "delivery"
      ? { shippingAddress: form.shippingAddress, city: form.city, zone: form.zone }
      : {}),
  };
  for (const [name, value] of Object.entries(values)) data.set(name, value);
  return data;
}
