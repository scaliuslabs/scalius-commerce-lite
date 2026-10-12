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
import { BILLING_ADDRESS_FIELDS, billingQuoteFields, type BillingAddressField } from "./billing-address";
import { nanoid } from "nanoid";
import { validateAndFormatPhone } from "@scalius/shared/customer-utils";
import { escapeHtml } from "@scalius/shared/html-escape";
import type { ShippingMethod } from "@/lib/api/types";
import type { CheckoutTaxQuote } from "./tax-quote-contract";
import {
  FOREIGN_ADDRESS_FIELDS,
  LOCATION_COUNTRY,
  readForeignAddressFields,
  shippingCountryOf,
  type ForeignAddressField,
} from "./shipping-country";

export const QUICK_CHECKOUT_PATH = "/checkout/quick";
/** The most of one option an order form (`lineQuantity`) asks for. */
export const QUICK_CHECKOUT_LINE_MAX_QUANTITY = 10;
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
  customerWhatsapp: string;
  /** What the buyer chose; `none` is decided from the lines, never posted. */
  deliveryMode: "delivery" | "pickup";
  /** The address country (Bangladesh unless the store sells abroad and the buyer chose another). */
  shippingCountryCode: string;
  shippingAddress: string;
  city: string;
  zone: string;
  /** Another country's address fields (empty for Bangladesh). */
  foreign: Record<ForeignAddressField, string>;
  /** The billing address as posted (only what checkout asked for is sent: `checkoutBillingFields`). */
  billing: Record<BillingAddressField | "billingCountryCode", string>;
  /** "Same as shipping address" ticked (a shipped order, when the merchant requires a full billing address). */
  billingSameAsShipping: boolean;
  shippingLocation: string;
  notes: string;
  discountCode: string;
  expectedQuoteFingerprint: string;
  /** The marketing consent box's value when ticked (the label's language), else "". */
  marketingConsent: string;
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
    cartItems: withLineQuantity(text(form, "cartItems", 24 * 1024), form.get("lineQuantity")),
    checkoutId: CHECKOUT_ID_PATTERN.test(checkoutId) ? checkoutId : newQuickCheckoutId(),
    customerName: text(form, "customerName", 100),
    customerPhone: text(form, "customerPhone", 20),
    customerEmail: text(form, "customerEmail", 254),
    customerWhatsapp: text(form, "customerWhatsapp", 20),
    deliveryMode: form.get("deliveryMode") === "pickup" ? "pickup" : "delivery",
    shippingCountryCode: shippingCountryOf(form.get("shippingCountryCode")),
    shippingAddress: text(form, "shippingAddress", 500),
    city: id(form, "city"),
    zone: id(form, "zone"),
    foreign: Object.fromEntries(Object.entries(readForeignAddressFields((field) => form.get(field)))
      .map(([field, value]) => [field, value ?? ""])) as Record<ForeignAddressField, string>,
    billing: Object.fromEntries(["billingCountryCode", ...BILLING_ADDRESS_FIELDS]
      .map((field) => [field, text(form, field, field === "billingAddress" ? 500 : 200)])) as QuickCheckoutForm["billing"],
    // A first visit has no post yet: the box starts ticked.
    billingSameAsShipping: form.has("intent") ? form.get("billingSameAsShipping") === "1" : true,
    shippingLocation: id(form, "shippingLocation"),
    notes: text(form, "notes", 500),
    discountCode: text(form, "discountCode", 50).toUpperCase(),
    expectedQuoteFingerprint: FINGERPRINT_PATTERN.test(fingerprint) ? fingerprint : "",
    marketingConsent: text(form, "marketingConsent", 16),
    intent: form.get("intent") === "place" ? "place" : "review",
  };
}

/**
 * The posted lines with a landing form's quantity (`lineQuantity`) applied:
 * only to a single line, within 1 to `QUICK_CHECKOUT_LINE_MAX_QUANTITY`. Anything
 * else leaves the lines as posted.
 */
export function withLineQuantity(cartItems: string, quantity: FormDataEntryValue | null): string {
  if (typeof quantity !== "string" || !/^\d{1,2}$/.test(quantity)) return cartItems;
  const value = Number(quantity);
  if (value < 1 || value > QUICK_CHECKOUT_LINE_MAX_QUANTITY) return cartItems;
  try {
    const lines = JSON.parse(cartItems) as Record<string, Record<string, unknown>>;
    const keys = Object.keys(lines);
    if (keys.length !== 1 || typeof lines[keys[0]!] !== "object" || lines[keys[0]!] === null) return cartItems;
    return JSON.stringify({ [keys[0]!]: { ...lines[keys[0]!], quantity: value } });
  } catch {
    return cartItems;
  }
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

/**
 * The country a phone number typed without a country code is read in: the
 * delivery address's, and Bangladesh for pickup and services (the order form
 * posts a country only for a delivery abroad, so the server reads it so too).
 */
export function quickCheckoutPhoneCountry(
  form: Pick<QuickCheckoutForm, "shippingCountryCode">,
  mode: QuickCheckoutMode,
): string {
  return mode === "delivery" && isQuickCheckoutAbroad(form) ? form.shippingCountryCode : LOCATION_COUNTRY;
}

/** Another country than Bangladesh: its shipping zone matches on the region and postal code. */
export function isQuickCheckoutAbroad(form: Pick<QuickCheckoutForm, "shippingCountryCode">): boolean {
  return form.shippingCountryCode !== LOCATION_COUNTRY;
}

/** Enough to read and quote a delivery rate: Bangladesh's city and thana, or another country. */
export function hasQuickCheckoutDestination(form: Pick<QuickCheckoutForm, "shippingCountryCode" | "city" | "zone">): boolean {
  return isQuickCheckoutAbroad(form) || Boolean(form.city && form.zone);
}

export type QuickCheckoutFieldError =
  | "customerName"
  | "customerPhone"
  | "customerEmail"
  | "customerEmailRequired"
  | "customerWhatsapp"
  | "shippingAddress"
  | "city"
  | "zone";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Contact and address problems, checked only when the buyer asks to place the order. */
export function quickCheckoutFieldErrors(
  form: QuickCheckoutForm,
  mode: QuickCheckoutMode,
  minAddressLength: number,
  /** Customer accounts' email field (phone is always required). */
  emailNeed: "required" | "optional" | "hidden" = "optional",
): QuickCheckoutFieldError[] {
  const errors: QuickCheckoutFieldError[] = [];
  if (form.customerName.length < 3) errors.push("customerName");
  try {
    validateAndFormatPhone(form.customerPhone, undefined, { defaultCountry: quickCheckoutPhoneCountry(form, mode) });
  } catch {
    errors.push("customerPhone");
  }
  if (emailNeed === "required" && !form.customerEmail) errors.push("customerEmailRequired");
  else if (emailNeed !== "hidden" && form.customerEmail && !EMAIL_PATTERN.test(form.customerEmail)) errors.push("customerEmail");
  const whatsappDigits = form.customerWhatsapp.replace(/\D/g, "");
  if (whatsappDigits && (whatsappDigits.length < 10 || whatsappDigits.length > 15)) errors.push("customerWhatsapp");
  if (mode === "delivery") {
    // Another country's address is checked against its rules by the API.
    if (isQuickCheckoutAbroad(form)) {
      if (!form.shippingAddress) errors.push("shippingAddress");
      return errors;
    }
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
  if (mode === "delivery" && !hasQuickCheckoutDestination(form)) return null;
  let customerPhone: string | undefined;
  try {
    customerPhone = validateAndFormatPhone(form.customerPhone, undefined, { defaultCountry: quickCheckoutPhoneCountry(form, mode) });
  } catch {
    customerPhone = undefined;
  }
  return {
    cartItems: form.cartItems,
    deliveryMode: mode,
    ...(mode === "delivery"
      ? isQuickCheckoutAbroad(form)
        ? {
          shippingCountryCode: form.shippingCountryCode,
          shippingAdminArea: form.foreign.shippingAdminArea,
          shippingPostalCode: form.foreign.shippingPostalCode,
        }
        : { city: form.city, zone: form.zone }
      : {}),
    ...(mode === "none" ? {} : { shippingMethodId: rateId }),
    // Nothing physical: taxed at the billing country, region and postal code.
    ...billingQuoteFields(mode, form.billing),
    discountCodes: form.discountCode ? JSON.stringify([form.discountCode]) : "[]",
    ...(customerPhone ? { customerPhone } : {}),
  };
}

/**
 * The carried lines at the unit prices of the reviewed quote. The line was
 * priced when the buyer pressed Buy now; the buyer has since reviewed the
 * quote's prices, and those are what the order is checked against.
 */
export function repriceQuickCheckoutLines(
  cartItems: string,
  quote: Pick<CheckoutTaxQuote, "items">,
): string {
  const prices = new Map(quote.items.map((item) => [item.cartKey, item.unitPrice]));
  const lines = JSON.parse(cartItems) as Record<string, Record<string, unknown>>;
  return JSON.stringify(Object.fromEntries(Object.entries(lines).map(([cartKey, line]) => [
    cartKey,
    prices.has(cartKey) ? { ...line, price: prices.get(cartKey) } : line,
  ])));
}

/**
 * The order form `processOrder` reads, built from the reviewed state: the
 * quote's prices and only the codes the quote applied go to the order.
 */
export function quickCheckoutOrderForm(
  form: QuickCheckoutForm,
  mode: QuickCheckoutMode,
  rateId: string,
  quote: Pick<CheckoutTaxQuote, "discounts" | "items">,
): FormData {
  const data = new FormData();
  const codes = quote.discounts.flatMap(({ code }) => (code ? [code] : []));
  const values: Record<string, string> = {
    formIntent: "checkout",
    cartItems: repriceQuickCheckoutLines(form.cartItems, quote),
    checkoutId: form.checkoutId,
    expectedQuoteFingerprint: form.expectedQuoteFingerprint,
    customerName: form.customerName,
    customerPhone: form.customerPhone,
    customerEmail: form.customerEmail,
    customerWhatsapp: form.customerWhatsapp,
    notes: form.notes,
    ...(form.marketingConsent ? { marketingConsent: form.marketingConsent } : {}),
    discountCodes: codes.length > 0 ? JSON.stringify(codes) : "",
    deliveryMode: mode === "pickup" ? "pickup" : "delivery",
    ...(mode === "none" ? {} : { shippingLocation: rateId }),
    ...(mode === "delivery"
      ? isQuickCheckoutAbroad(form)
        ? {
          shippingAddress: form.shippingAddress,
          shippingCountryCode: form.shippingCountryCode,
          ...Object.fromEntries(FOREIGN_ADDRESS_FIELDS.flatMap((field) => (form.foreign[field] ? [[field, form.foreign[field]]] : []))),
        }
        : { shippingAddress: form.shippingAddress, city: form.city, zone: form.zone }
      : {}),
    // The billing address as posted: the order keeps only what checkout asked for.
    ...Object.fromEntries(Object.entries(form.billing).filter(([, value]) => value)),
    ...(form.billingSameAsShipping ? { billingSameAsShipping: "1" } : {}),
  };
  for (const [name, value] of Object.entries(values)) data.set(name, value);
  return data;
}
