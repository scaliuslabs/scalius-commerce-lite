import type { WarrantyClaimStatus } from "@scalius/shared/warranty";
import { Badge } from "~/components/ui/badge";
import { useMessages } from "~/i18n";
import { warrantyMessages } from "~/i18n/warranty";

const VARIANT = {
  open: "attention",
  in_progress: "info",
  resolved: "success",
  rejected: "outline",
} as const satisfies Record<WarrantyClaimStatus, string>;

/** Open / In progress / Resolved / Rejected, as text and colour. */
export function ClaimStatusBadge({ status }: { status: WarrantyClaimStatus }) {
  const t = useMessages(warrantyMessages);
  return <Badge variant={VARIANT[status] ?? "outline"}>{t(`status.${status}`)}</Badge>;
}
