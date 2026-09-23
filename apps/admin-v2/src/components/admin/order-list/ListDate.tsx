import { unixToDate } from "@scalius/shared/timestamps";
import { formatDateTime, useMessages } from "~/i18n";
import { orderListMessages } from "~/i18n/order-list";

type Timestamp = Date | string | number | null | undefined;

/** "Just now", "41m ago", "3h ago", then a short date: the Shopify list style. */
export function ListDate({ value, className }: { value: Timestamp; className?: string }) {
  const t = useMessages(orderListMessages);
  const date = unixToDate(value ?? null);
  if (!date) return <span className={className}>—</span>;
  const minutes = Math.floor((Date.now() - date.getTime()) / 60_000);
  const label =
    minutes < 0 || minutes >= 24 * 60
      ? formatDateTime(date, {
          month: "short",
          day: "numeric",
          year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
          hour: "numeric",
          minute: "2-digit",
        })
      : minutes < 1
        ? t("justNow")
        : minutes < 60
          ? t("minutesAgo", { count: minutes })
          : t("hoursAgo", { count: Math.floor(minutes / 60) });
  return (
    <span
      className={className}
      title={formatDateTime(date, { dateStyle: "full", timeStyle: "short" })}
    >
      {label}
    </span>
  );
}
