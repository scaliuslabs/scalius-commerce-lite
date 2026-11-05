// The theme editor's sample pages (`/theme-preview/sample/<page>`): the
// checkout, the receipt and the account drawn with the draft theme from fixed
// sample orders, never a buyer's. A buyer's own page never draws a draft;
// these pages show the merchant what the theme's private-page blocks do
// instead. Everything here is fixed data
// in the store's language and currency: no session, receipt proof, cart,
// order or account is read to draw it.
import type { CheckoutConfig as CheckoutPageConfig } from "./checkout/types";
import type { CheckoutTaxQuote } from "./checkout/tax-quote-contract";
import type { CustomerOrder } from "./api/customer-auth";
import type { AccountSummary } from "./account-tabs";
import type { ReceiptOrder } from "./order-receipt-view";
import { storefrontLanguage, type StorefrontLanguage } from "./storefront-language";
import { fromMinor } from "@scalius/shared/money";

export {
  THEME_PREVIEW_SAMPLE_PAGES,
  isThemePreviewSamplePage,
  isThemePreviewSamplePath,
  themePreviewSamplePath,
  type ThemePreviewSamplePage,
} from "@scalius/shared/theme-preview-path";

interface SampleWords {
  notice: string;
  buyer: string;
  address: string;
  city: string;
  zone: string;
  delivery: string;
  deliveryTime: string;
  firstProduct: string;
  firstVariant: string;
  secondProduct: string;
  note: string;
}

const WORDS: Record<StorefrontLanguage, SampleWords> = {
  en: {
    notice: "Sample order: a buyer sees their own.",
    buyer: "Sample buyer",
    address: "House 1, Road 1",
    city: "Dhaka",
    zone: "Mirpur",
    delivery: "Standard delivery",
    deliveryTime: "2 to 3 days",
    firstProduct: "Sample product",
    firstVariant: "Size: M",
    secondProduct: "Another sample product",
    note: "Please call before delivery.",
  },
  bn: {
    notice: "নমুনা অর্ডার: ক্রেতা তাঁর নিজের অর্ডার দেখেন।",
    buyer: "নমুনা ক্রেতা",
    address: "বাড়ি ১, রোড ১",
    city: "ঢাকা",
    zone: "মিরপুর",
    delivery: "সাধারণ ডেলিভারি",
    deliveryTime: "২ থেকে ৩ দিন",
    firstProduct: "নমুনা পণ্য",
    firstVariant: "সাইজ: M",
    secondProduct: "আরেকটি নমুনা পণ্য",
    note: "ডেলিভারির আগে ফোন করবেন।",
  },
};

export function themePreviewSampleWords(languageCode: unknown): SampleWords {
  return WORDS[storefrontLanguage(languageCode)];
}

/** The store's currency, for amounts in its own minor units. */
export interface SampleCurrency {
  code: string;
  decimalPlaces: number;
}

const PHONE = "+8801700000000";
const EMAIL = "buyer@example.com";
const CREATED_AT = "2026-01-15T10:30:00.000Z";

/** Two lines, a delivery fee and the total, in minor units of the store's currency. */
function sampleAmounts(currency: SampleCurrency) {
  const minor = 10 ** currency.decimalPlaces;
  const first = 1_200 * minor;
  const second = 650 * minor;
  const shipping = 60 * minor;
  const subtotal = first * 2 + second;
  return { first, second, shipping, subtotal, total: subtotal + shipping };
}

/**
 * The checkout's payment methods for the sample: the store's own (the public
 * checkout settings every checkout reads), or, with fewer than two, cash on
 * delivery and a hosted gateway, so the theme's payment layout shows.
 */
function sampleGateways(config: { gateways: CheckoutPageConfig["gateways"] }): CheckoutPageConfig["gateways"] {
  const own = config.gateways.filter((gateway) => gateway.id !== "gift_card");
  return own.length >= 2
    ? own.map((gateway) => ({ ...gateway, testMode: false }))
    : [
        { id: "cod", name: "Cash on delivery", flow: "cod" },
        { id: "scalius.bangladesh:sslcommerz", name: "SSLCommerz", flow: "hosted" },
      ];
}

/** What the sample checkout draws: the settings, the reviewed details and the quote. */
export function themePreviewSampleCheckout(
  config: CheckoutPageConfig,
  currency: SampleCurrency,
  languageCode: unknown,
): { config: CheckoutPageConfig; data: Record<string, unknown>; quote: CheckoutTaxQuote } {
  const words = themePreviewSampleWords(languageCode);
  const amounts = sampleAmounts(currency);
  const major = (amount: number) => fromMinor(amount, currency.decimalPlaces);
  const gateways = sampleGateways(config);
  const item = (cartKey: string, productName: string, variantLabel: string | null, quantity: number, unitMinor: number) => ({
    cartKey,
    productId: `sample_${cartKey}`,
    variantId: `sample_${cartKey}_variant`,
    quantity,
    unitPrice: major(unitMinor),
    productName,
    variantLabel,
    fulfillmentType: "ship" as const,
    properties: [],
    propertiesPriceMinor: 0,
    propertiesHash: null,
  });
  return {
    config: {
      ...config,
      gateways,
      activeDefaultMethod: gateways[0]?.id,
      partialPaymentEnabled: false,
      partialPaymentAmount: 0,
      unavailable: false,
    },
    data: {
      customerName: words.buyer,
      customerPhone: PHONE,
      customerEmail: EMAIL,
      shippingAddress: words.address,
      cityName: words.city,
      zoneName: words.zone,
      cartItems: {},
    },
    quote: {
      valid: true,
      quoteFingerprint: "sample",
      displayLabel: "",
      pricesIncludeTax: false,
      shippingTaxed: false,
      currencyCode: currency.code,
      decimalPlaces: currency.decimalPlaces,
      settingsVersion: 0,
      subtotalMinor: amounts.subtotal,
      subtotalAmount: major(amounts.subtotal),
      shippingMinor: amounts.shipping,
      shippingAmount: major(amounts.shipping),
      discountMinor: 0,
      discountAmount: 0,
      taxMinor: 0,
      taxAmount: 0,
      totalMinor: amounts.total,
      totalAmount: major(amounts.total),
      shippingMethod: { id: "sample_delivery", name: words.delivery, description: words.deliveryTime, baseAmountMinor: amounts.shipping, feeWaived: false },
      shippingRateToken: null,
      deliveryMethodKind: "delivery",
      requiresShipping: true,
      pickup: null,
      allowedPaymentMethods: gateways.map((gateway) => gateway.id),
      discounts: [],
      offers: [],
      rejectedCodes: [],
      items: [
        item("first", words.firstProduct, words.firstVariant, 2, amounts.first),
        item("second", words.secondProduct, null, 1, amounts.second),
      ],
    } as CheckoutTaxQuote,
  };
}

/** A placed cash-on-delivery order, as the receipt read would return it. */
export function themePreviewSampleReceipt(currency: SampleCurrency, languageCode: unknown): ReceiptOrder {
  const words = themePreviewSampleWords(languageCode);
  const amounts = sampleAmounts(currency);
  const major = (amount: number) => fromMinor(amount, currency.decimalPlaces);
  return {
    id: "sample_order",
    orderNumber: 1001,
    customerName: words.buyer,
    customerPhone: PHONE,
    customerEmail: EMAIL,
    shippingAddress: words.address,
    city: null,
    zone: null,
    area: null,
    cityName: words.city,
    zoneName: words.zone,
    areaName: null,
    totalAmount: major(amounts.total),
    shippingCharge: major(amounts.shipping),
    discountAmount: null,
    paymentMethod: "cod",
    paymentStatus: "unpaid",
    status: "pending",
    paidAmount: 0,
    balanceDue: major(amounts.total),
    accountLinked: true,
    notes: words.note,
    shippingMethodName: words.delivery,
    shippingMethodDescription: words.deliveryTime,
    requiresShipping: true,
    shippingMethodKind: "delivery",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    items: [
      { id: "sample_line_1", productId: "sample_first", variantId: "sample_first_variant", quantity: 2, price: major(amounts.first), productName: words.firstProduct, productImage: null, variantLabel: words.firstVariant, fulfillmentType: "ship" },
      { id: "sample_line_2", productId: "sample_second", variantId: null, quantity: 1, price: major(amounts.second), productName: words.secondProduct, productImage: null, variantLabel: null, fulfillmentType: "ship" },
    ],
    supportRequests: [],
    supportRequestActions: [],
    supportRequestIntro: "",
  };
}

/** Two orders and the account's tab counts, as the account reads would return them. */
export function themePreviewSampleAccount(currency: SampleCurrency, languageCode: unknown): { orders: CustomerOrder[]; summary: AccountSummary } {
  const words = themePreviewSampleWords(languageCode);
  const amounts = sampleAmounts(currency);
  const major = (amount: number) => fromMinor(amount, currency.decimalPlaces);
  const order = (index: number, status: string, total: number, items: CustomerOrder["items"]): CustomerOrder => ({
    id: `sample_order_${index}`,
    orderNumber: 1000 + index,
    status,
    statusLabel: status,
    currencyCode: currency.code,
    openSupportRequestType: null,
    totalAmount: major(total),
    paidAmount: 0,
    balanceDue: major(total),
    shippingCharge: major(amounts.shipping),
    shippingMethodId: null,
    shippingMethodName: words.delivery,
    shippingMethodDescription: null,
    shippingMethodBaseAmountMinor: null,
    shippingFeeWaived: null,
    discountAmount: null,
    paymentStatus: "unpaid",
    paymentMethod: "cod",
    fulfillmentStatus: "unfulfilled",
    shippingAddress: words.address,
    cityName: words.city,
    zoneName: words.zone,
    areaName: null,
    notes: null,
    createdAt: CREATED_AT,
    latestShipment: null,
    items,
  });
  const line = (name: string, variantLabel: string | null, quantity: number, price: number) => ({
    productId: `sample_${name}`, variantId: null, quantity, price: major(price), productName: name, productSlug: null, productImage: null, variantLabel,
  });
  return {
    orders: [
      order(2, "processing", amounts.total, [line(words.firstProduct, words.firstVariant, 2, amounts.first), line(words.secondProduct, null, 1, amounts.second)]),
      order(1, "delivered", amounts.second + amounts.shipping, [line(words.secondProduct, null, 1, amounts.second)]),
    ],
    summary: { unreadInbox: 1, reviewsToWrite: 1, reviewsWritten: 0, downloads: 0, giftCards: 0, activeWarranties: 0 },
  };
}
