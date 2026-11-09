// The account's order cards (Account → Orders): each order's state, date,
// item count, total, a line of what happens next, thumbnails and Buy again,
// in the account's words. The account page draws them for the buyer; the
// theme editor's sample account draws sample orders the same way.
import { pageOrderNumber } from "@/lib/checkout-text";
import type { CustomerOrder } from "@/lib/api/customer-auth";
import {
  accountMoney,
  accountOrderStatusText,
  accountShipmentStatusText,
  formatAccountDate,
  openRequestLabel,
  orderPaymentLine,
} from "@/lib/account-format";
import type { accountCopy } from "@/lib/account-copy";
import { formatCount } from "@/lib/store-time-zone";
import type { getCheckoutLanguagePreset } from "@scalius/shared/checkout-language";
import { orderStatusTone } from "@/lib/account-ui";
import { getProductImageUrl } from "@/lib/product-media";

export function accountOrderCards(
  orders: readonly CustomerOrder[],
  copy: ReturnType<typeof accountCopy>,
  checkoutCopy: ReturnType<typeof getCheckoutLanguagePreset>,
) {
  const words = copy.orders;
  return orders.map((order) => {
    const itemCount = order.items.reduce((sum, item) => sum + item.quantity, 0);
    const payment = orderPaymentLine(order, checkoutCopy);
    const shipment = order.latestShipment;
    const courier = shipment ? shipment.providerName || shipment.courierName : null;
    const request = openRequestLabel(order.openSupportRequestType);
    const needsPayment = payment.state === copy.format.paymentNeedsAttention;
    return {
      id: order.id,
      href: `/account/orders/${encodeURIComponent(order.id)}`,
      number: pageOrderNumber(order.orderNumber, order.id),
      status: accountOrderStatusText(order.status),
      tone: orderStatusTone(order.status),
      request,
      date: formatAccountDate(order.createdAt, { time: false }),
      items: words.items(formatCount(itemCount), itemCount === 1),
      total: accountMoney(order.totalAmount, order.currencyCode),
      detail: needsPayment
        ? { text: payment.state, warn: true }
        : shipment
          ? { text: [courier, accountShipmentStatusText(shipment.status)].filter(Boolean).join(" · "), warn: false }
          : { text: `${payment.method} · ${payment.state}`, warn: false },
      thumbs: order.items.slice(0, 4).map((item) => ({ src: getProductImageUrl(item.productImage, 160), alt: item.productName ?? "" })),
      more: Math.max(0, order.items.length - 4),
      // Buy again reads the order's lines whole (inputs and their surcharges) before they go back.
      buyAgain: order.id,
    };
  });
}

export type AccountOrderCard = ReturnType<typeof accountOrderCards>[number];
