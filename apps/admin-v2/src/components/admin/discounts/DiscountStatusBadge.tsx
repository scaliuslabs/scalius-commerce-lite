import { discountStatus, limitReached, type DiscountStatus } from "./discount-form";
import { Badge, type BadgeVariant } from "~/components/ui/badge";
import { useMessages } from "~/i18n";
import { discountsMessages } from "~/i18n/discounts";
import type { DiscountRecord } from "~/lib/api-query-options/discounts";

const VARIANT: Record<DiscountStatus, BadgeVariant> = {
  active: "success",
  scheduled: "info",
  expired: "destructive",
  draft: "attention",
  inactive: "secondary",
};

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
  discount: Pick<DiscountRecord, "status" | "startsAtEpochSeconds" | "endsAtEpochSeconds" | "maxRedemptions" | "redemptionCount">;
}) {
  const t = useMessages(discountsMessages);
  const status = discountStatus(discount);
  return (
    <span className="inline-flex flex-wrap gap-1">
      <Badge variant={VARIANT[status]}>{t(STATUS_LABEL[status])}</Badge>
      {limitReached(discount) && status !== "expired" ? <Badge variant="warning">{t("limitReached")}</Badge> : null}
    </span>
  );
}
