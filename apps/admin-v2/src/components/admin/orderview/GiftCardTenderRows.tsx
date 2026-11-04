// The gift-card tenders in the payment summary (rows of its <dl>): "Gift card •••• 7K2Q  ৳500",
// with "Released" (cancelled or abandoned: the hold went back) or "Refunded", and the
// store-credit cards refunds issued. Cards are shown by their last 4 only.
import { getDecimalPlaces } from "@scalius/shared/currency";
import { formatSavedMinorAmount } from "~/lib/order-money-format";
import { useMessages } from "~/i18n";
import { giftCardTenderMessages as giftCardOrderMessages } from "~/i18n/gift-card-tenders";
import { giftCardTenderLines, type PaymentRow } from "./gift-card-tender-lines";
import type { Order } from "./types";

export { giftCardTenderLines } from "./gift-card-tender-lines";

export function GiftCardTenderRows({ payments }: {
  order: Order;
  /** The payments read (empty until it loads); gift-card tenders are `order_payments` rows. */
  payments: ReadonlyArray<PaymentRow>;
}) {
  const t = useMessages(giftCardOrderMessages);
  const lines = giftCardTenderLines(payments);
  if (lines.length === 0) return null;

  return (
    <>
      {lines.map((line) => {
        const format = (minor: number) => formatSavedMinorAmount(minor, {
          currencyCode: line.currency,
          decimalPlaces: getDecimalPlaces(line.currency),
        });
        const amount = format(line.amountMinor);
        const value = line.state === "released"
          ? t("tender.released", { amount })
          : line.state === "refunded"
            ? t("tender.refunded", { amount })
            : line.state === "partlyRefunded"
              ? t("tender.partlyRefunded", { amount, refunded: format(line.refundedMinor) })
              : amount;
        return (
          <div key={line.key} className="flex justify-between gap-4">
            <dt className="text-muted-foreground">
              {t(line.kind === "tender" ? "tender.label" : "storeCredit.label", { last4: line.last4 })}
            </dt>
            <dd className="min-w-0 break-words text-end">{value}</dd>
          </div>
        );
      })}
    </>
  );
}
