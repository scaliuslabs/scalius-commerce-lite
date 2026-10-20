import { discountStatus, limitReached } from "./discount-form";
import { StatusBadge } from "~/components/admin/resource/StatusBadge";
import { Badge } from "~/components/ui/badge";
import { useMessages } from "~/i18n";
import { discountsMessages } from "~/i18n/discounts";
import type { DiscountRecord } from "~/lib/api-query-options/discounts";

export const STATUS_LABEL = {
  active: "statusActive",
  scheduled: "statusScheduled",
  expired: "statusExpired",
  draft: "statusDraft",
  inactive: "statusInactive",
} as const;

/** Status, plus "Limit reached" when a code's total uses are spent. */
export function DiscountStatusBadge({
  discount,
}: {
  discount: Pick<DiscountRecord, "status" | "startsAt" | "endsAt" | "maxRedemptions" | "redemptionCount">;
}) {
  const t = useMessages(discountsMessages);
  const status = discountStatus(discount);
  return (
    <span className="inline-flex flex-wrap gap-1">
      <StatusBadge status={status}>{t(STATUS_LABEL[status])}</StatusBadge>
      {limitReached(discount) && status !== "expired" ? <Badge variant="warning">{t("limitReached")}</Badge> : null}
    </span>
  );
}
