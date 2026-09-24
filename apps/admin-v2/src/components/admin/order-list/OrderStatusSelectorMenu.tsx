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
  getAdminOrderStatusOptions,
  type AdminOrderStatusBlock,
  type AdminOrderStatusFacts,
} from "@/lib/admin-order-status-policy";
import { useMessages } from "~/i18n";
import { orderMessages, orderStatusLabel } from "~/i18n/orders";
import { orderListMessages } from "~/i18n/order-list";

export interface OrderStatusSelectorMenuProps {
  status: string;
  facts: AdminOrderStatusFacts;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStatusUpdate: (newStatus: string) => void;
  trigger: ReactNode;
}

export function OrderStatusSelectorMenu({
  status,
  facts,
  open,
  onOpenChange,
  onStatusUpdate,
  trigger,
}: OrderStatusSelectorMenuProps) {
  const t = useMessages(orderListMessages);
  const to = useMessages(orderMessages);
  const options = getAdminOrderStatusOptions(status, facts);
  // A status that can't be chosen stays in the menu, greyed out, with the reason under it.
  const reason = (block: AdminOrderStatusBlock) => {
    switch (block.code) {
      case "cancel_needs_refund": return t("cancelNeedsRefund");
      case "with_courier": return t("statusBlock.withCourier");
      case "cash_not_collected": return t("statusBlock.cashFirst");
      case "money_due": return t("statusBlock.moneyDue");
    }
  };

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>{t("changeStatus")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={status}
          onValueChange={onStatusUpdate}
        >
          {options.map(({ status: next, block }) => (
            <DropdownMenuRadioItem key={next} value={next} disabled={block !== null}>
              {block ? (
                <span className="flex flex-col items-start">
                  <span>{orderStatusLabel(to, next)}</span>
                  <span className="text-muted-foreground">{reason(block)}</span>
                </span>
              ) : orderStatusLabel(to, next)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
