// What the receipt's cards show (components/order/ReceiptCards.astro), from
// one order: its totals in the order's saved money, its delivery, its lines
// grouped as they are handed over, and the words for each. One derivation for
// the receipt page and the theme editor's sample receipt, so the sample shows
// exactly what a buyer's receipt does with the same theme.
import { checkoutText, pageOrderNumber, pagePhone } from "@/lib/checkout-text";
import { formatOrderPlaces } from "@/lib/account-format";
import type { CheckoutLanguageData, getOrderReceipt } from "@/lib/api";
import { formatMoney } from "@/lib/currency";
import { orderDeliveryRow } from "@/lib/order-delivery-row";
import { summarizeOrderDiscounts } from "@/lib/order-discount-summary";
import { orderShowsLineDiscounts } from "@/lib/order-line-discounts";
import {
  groupOrderLines,
  resolveOrderDeliveryBlock,
  showsOrderLineGroupHeadings,
} from "@/lib/order-line-groups";
import {
  getOrderPaymentPresentation,
  getOrderSuccessViewState,
  getOrderSuccessVisibleBalanceDue,
} from "@/lib/order-success-state";
import { formatOrderReceiptDate, formatOrderReceiptDay } from "@/lib/order-success-localization";
import { formatPageNumber } from "@/lib/store-time-zone";
import { checkoutLanguageBaseCode } from "@scalius/shared/checkout-language";
import { presentCheckoutAttributes } from "@scalius/shared/plugins/checkout-attribute-text";
import { storeRegion } from "@/lib/store-time-zone";
import { fromMinor } from "@scalius/shared/money";
import { resolveSavedOrderMoneySummary } from "@scalius/shared/order-money-presentation";

/** An order as the receipt read returns it. */
export type ReceiptOrder = NonNullable<Awaited<ReturnType<typeof getOrderReceipt>>>;
/** The receipt's state (placed, paid, pending...) and its badges. */
export type ReceiptSuccessView = ReturnType<typeof getOrderSuccessViewState>;

export interface OrderReceiptViewInput {
  order: ReceiptOrder;
  copy: CheckoutLanguageData["languageData"];
  /** The checkout language's code (dates, digits and places in its language). */
  languageCode: string;
  /** The store's currency when the order saved none. */
  configuredCurrencyCode: string;
}

export function orderReceiptView({ order, copy, languageCode, configuredCurrencyCode }: OrderReceiptViewInput) {
  const orderLineGroups = groupOrderLines(order.items || [], order, copy);
  const showOrderLineGroupHeadings = showsOrderLineGroupHeadings(orderLineGroups);
  const deliveryBlock = resolveOrderDeliveryBlock(order, copy);
  const visibleBalanceDue = getOrderSuccessVisibleBalanceDue(order);
  // Gift cards that paid part of the order, and the words for what is left.
  const receiptPayment = getOrderPaymentPresentation(order, copy);
  const receiptGiftCardTenders = receiptPayment?.giftCardTenders ?? [];
  const savedMoneySummary = resolveSavedOrderMoneySummary(order);
  const receiptCurrencyCode = savedMoneySummary?.currencyCode ?? configuredCurrencyCode;
  const formatReceiptAmount = (amount: number) => formatMoney(amount, { code: receiptCurrencyCode });
  // Major units from the saved minor-unit snapshot when complete; legacy decimals otherwise.
  const toMajor = (amountMinor: number) => fromMinor(amountMinor, savedMoneySummary?.decimalPlaces ?? 0);
  const formatReceiptMinor = (amountMinor: number) => formatReceiptAmount(toMajor(amountMinor));
  const receiptMoney = savedMoneySummary
    ? {
        subtotal: toMajor(savedMoneySummary.subtotalMinor),
        shipping: toMajor(savedMoneySummary.shippingMinor),
        discount: toMajor(savedMoneySummary.discountMinor),
        tax: toMajor(savedMoneySummary.taxMinor),
        total: toMajor(savedMoneySummary.totalMinor),
      }
    : {
        subtotal: order.totalAmount - order.shippingCharge + (order.discountAmount ?? 0),
        shipping: order.shippingCharge,
        discount: order.discountAmount ?? 0,
        tax: 0,
        total: order.totalAmount,
      };
  const receiptDiscounts = summarizeOrderDiscounts({
    discounts: order.discounts,
    shipping: receiptMoney.shipping,
    deliveryFee: savedMoneySummary && order.shippingMethodBaseAmountMinor != null
      ? toMajor(order.shippingMethodBaseAmountMinor)
      : null,
    discount: receiptMoney.discount,
    decimalPlaces: savedMoneySummary?.decimalPlaces,
    discountText: copy.discountText,
  });
  const receiptDeliveryRow = deliveryBlock
    ? orderDeliveryRow({
        mode: deliveryBlock.mode,
        methodName: order.shippingMethodName,
        ...receiptDiscounts.delivery,
      }, copy, formatReceiptAmount)
    : null;
  // An order-level promotion is one line in the totals, never an "Item discount" on each line.
  const showsLineDiscounts = orderShowsLineDiscounts(order.discounts);
  // Nothing to deliver and nothing charged: no delivery row and no "method not recorded" note.
  const showsReceiptDeliveryRow = !(deliveryBlock?.mode === "none"
    && !order.shippingMethodName
    && receiptMoney.shipping === 0);
  const receiptDeliveryDetails = !showsReceiptDeliveryRow
    ? ""
    : order.shippingMethodName
    ? [
        order.shippingMethodDescription,
        order.shippingFeeWaived && savedMoneySummary && order.shippingMethodBaseAmountMinor != null
          ? checkoutText(copy.orderReceiptFeeWaivedText, {
              fee: formatReceiptMinor(order.shippingMethodBaseAmountMinor),
            })
          : null,
      ].filter(Boolean).join(" · ")
    : copy.orderReceiptDeliveryNotRecordedText;
  const deliveryLocality = deliveryBlock?.mode === "ship"
    ? order.shippingCountryCode && order.shippingCountryCode !== "BD"
      // Another country's places, then the country (MARKETS-DESIGN D7).
      ? formatOrderPlaces(order, checkoutLanguageBaseCode(languageCode))
      : [order.areaName || order.area, order.zoneName || order.zone, order.cityName || order.city]
        .filter((value): value is string => Boolean(value))
        .join(", ")
    : "";
  const orderPlacedAt = formatOrderReceiptDate(order.createdAt, languageCode);
  // An invoice still owed: "Payment due by 19 November 2026 (net 30)", or that it was due.
  const receiptPaymentTerms = order.paymentTerms && order.balanceDue > 0
    ? checkoutText(order.paymentTerms.overdue ? copy.invoiceOverdueText : copy.invoiceDueText, {
        date: formatOrderReceiptDay(order.paymentTerms.dueAt, languageCode) ?? "",
        days: formatPageNumber(order.paymentTerms.days, checkoutLanguageBaseCode(languageCode)),
      })
    : null;
  // The receipt's numbers in its language's digits, wherever it renders (the theme preview's sample too).
  const digitsLanguage = checkoutLanguageBaseCode(languageCode);
  const orderNumber = pageOrderNumber(order.orderNumber, order.id, digitsLanguage);
  // The buyer reads the phone in the page's digits; a tel: link would keep it Latin (fieldPhone).
  const customerPhone = order.customerPhone ? pagePhone(order.customerPhone, digitsLanguage) : null;
  const quantityText = (quantity: number) => formatPageNumber(quantity, digitsLanguage);
  // The apps' answers the buyer gave (a delivery day and window), under the apps' words, in the receipt's language.
  const appAnswers = presentCheckoutAttributes(order.appAnswers ?? {}, order.attributeApps ?? [], {
    locale: digitsLanguage, defaultLocale: digitsLanguage, words: copy, region: storeRegion(),
  });
  return {
    appAnswers,
    customerPhone,
    quantityText,
    orderLineGroups,
    showOrderLineGroupHeadings,
    deliveryBlock,
    visibleBalanceDue,
    receiptPayment,
    receiptGiftCardTenders,
    savedMoneySummary,
    receiptCurrencyCode,
    formatReceiptAmount,
    formatReceiptMinor,
    receiptMoney,
    receiptDiscounts,
    receiptDeliveryRow,
    showsLineDiscounts,
    showsReceiptDeliveryRow,
    receiptDeliveryDetails,
    deliveryLocality,
    orderPlacedAt,
    receiptPaymentTerms,
    orderNumber,
  };
}

export type OrderReceiptView = ReturnType<typeof orderReceiptView>;
