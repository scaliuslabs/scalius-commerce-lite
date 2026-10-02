import { Badge, type BadgeVariant } from "~/components/ui/badge";
import { useMessages } from "~/i18n";
import { purchasingMessages } from "~/i18n/purchasing";
import type { PurchaseOrderStatus, TransferStatus } from "~/lib/api-query-options/purchasing";

/**
 * The one status mapping (DESIGN.md "Status → badge variant"): a draft needs
 * the merchant's attention, what is on its way is info, a partial receipt a
 * warning, a finished one success, a cancelled one neutral.
 */
const PURCHASE_ORDER_STATUS = {
  draft: { badge: "attention", label: "status_draft" },
  ordered: { badge: "info", label: "status_ordered" },
  partially_received: { badge: "warning", label: "status_partially_received" },
  received: { badge: "success", label: "status_received" },
  cancelled: { badge: "secondary", label: "status_cancelled" },
} as const satisfies Record<PurchaseOrderStatus, { badge: BadgeVariant; label: string }>;

const TRANSFER_STATUS = {
  draft: { badge: "attention", label: "status_draft" },
  in_transit: { badge: "info", label: "status_in_transit" },
  partially_received: { badge: "warning", label: "status_partially_received" },
  received: { badge: "success", label: "status_received" },
  cancelled: { badge: "secondary", label: "status_cancelled" },
} as const satisfies Record<TransferStatus, { badge: BadgeVariant; label: string }>;

export function purchaseOrderStatus(status: PurchaseOrderStatus) {
  return PURCHASE_ORDER_STATUS[status];
}

export function transferStatus(status: TransferStatus) {
  return TRANSFER_STATUS[status];
}

/** Still expecting units: they can be received (and cancelled). */
export function isOpenPurchaseOrder(status: PurchaseOrderStatus): boolean {
  return status === "ordered" || status === "partially_received";
}

export function isOpenTransfer(status: TransferStatus): boolean {
  return status === "in_transit" || status === "partially_received";
}

export function PurchaseOrderStatusBadge({ status }: { status: PurchaseOrderStatus }) {
  const t = useMessages(purchasingMessages);
  const { badge, label } = purchaseOrderStatus(status);
  return <Badge variant={badge}>{t(label)}</Badge>;
}

export function TransferStatusBadge({ status }: { status: TransferStatus }) {
  const t = useMessages(purchasingMessages);
  const { badge, label } = transferStatus(status);
  return <Badge variant={badge}>{t(label)}</Badge>;
}
