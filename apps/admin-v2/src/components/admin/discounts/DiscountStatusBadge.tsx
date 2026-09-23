import { discountStatus, type DiscountStatus } from "./discount-form";
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

export function DiscountStatusBadge({
  discount,
}: {
  discount: Pick<DiscountRecord, "status" | "startsAtEpochSeconds" | "endsAtEpochSeconds">;
}) {
  const t = useMessages(discountsMessages);
  const status = discountStatus(discount);
  return <Badge variant={VARIANT[status]}>{t(STATUS_LABEL[status])}</Badge>;
}
