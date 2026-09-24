import type { ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import {
  getAdminOrderCancellationBlockedReason,
  getAdminOrderStatusTransitions,
} from "@/lib/admin-order-status-policy";
import { useMessages } from "~/i18n";
import { orderMessages, orderStatusLabel } from "~/i18n/orders";
import { orderListMessages } from "~/i18n/order-list";

export interface OrderStatusSelectorMenuProps {
  status: string;
  paymentStatus: string | null;
  paidAmount: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStatusUpdate: (newStatus: string) => void;
  trigger: ReactNode;
}

export function OrderStatusSelectorMenu({
  status,
  paymentStatus,
  paidAmount,
  open,
  onOpenChange,
  onStatusUpdate,
  trigger,
}: OrderStatusSelectorMenuProps) {
  const t = useMessages(orderListMessages);
  const to = useMessages(orderMessages);
  const paymentState = { paymentStatus, paidAmount };
  const transitions = getAdminOrderStatusTransitions(status, paymentState);
  const cancelNeedsRefund = getAdminOrderCancellationBlockedReason(status, paymentState) !== null;

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>{t("changeStatus")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={status}
          onValueChange={onStatusUpdate}
        >
          {transitions.map((next) => (
            <DropdownMenuRadioItem key={next} value={next}>
              {orderStatusLabel(to, next)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {cancelNeedsRefund ? (
          <p className="border-t px-2 py-2 text-body text-muted-foreground">{t("cancelNeedsRefund")}</p>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
