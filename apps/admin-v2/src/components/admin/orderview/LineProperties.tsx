import { useMessages } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";
import { BuyerFiles } from "./BuyerFiles";
import type { OrderItem } from "./types";

/**
 * The buyer inputs frozen on an order line, under its name in muted text:
 * "Engraving: Rahim (+৳200)". Labels are the merchant's words as they were
 * when the order was placed.
 */
export function LineProperties({ item, money }: {
  item: Pick<OrderItem, "properties">;
  /** Formats a major-unit surcharge in the order's currency. */
  money: (amount: number) => string;
}) {
  const t = useMessages(orderDetailMessages);
  const properties = item.properties ?? [];
  if (properties.length === 0) return null;
  return (
    <dl className="text-muted-foreground">
      {properties.map((property) => property.type === "file" ? (
        <div key={property.key} className="break-words">
          <dt>{t("properties.label", { label: property.label })}</dt>
          <dd className="mt-1">
            <BuyerFiles value={property.value} fallback={property.displayValue} />
          </dd>
          {property.priceMinor > 0 ? (
            <dd className="tabular-nums">{t("properties.surcharge", { amount: money(property.price) })}</dd>
          ) : null}
        </div>
      ) : (
        <div key={property.key} className="break-words">
          <dt className="inline">{t("properties.label", { label: property.label })}</dt>{" "}
          <dd className="inline whitespace-pre-wrap">{property.displayValue}</dd>
          {property.priceMinor > 0 ? (
            <span className="tabular-nums"> {t("properties.surcharge", { amount: money(property.price) })}</span>
          ) : null}
        </div>
      ))}
    </dl>
  );
}
