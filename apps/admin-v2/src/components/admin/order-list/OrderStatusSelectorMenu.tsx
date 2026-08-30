import type { ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import {
  getAdminOrderCancellationBlockedReason,
  getAdminOrderStatusTransitions,
} from "@/lib/admin-order-status-policy";

export interface OrderStatusSelectorMenuProps {
  status: string;
  paymentStatus: string | null;
  paidAmount: number;
  orderId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStatusUpdate: (orderId: string, newStatus: string) => void;
  trigger: ReactNode;
}

export function OrderStatusSelectorMenu({
  status,
  paymentStatus,
  paidAmount,
  orderId,
  open,
  onOpenChange,
  onStatusUpdate,
  trigger,
}: OrderStatusSelectorMenuProps) {
  const paymentState = { paymentStatus, paidAmount };
  const transitions = getAdminOrderStatusTransitions(status, paymentState);
  const cancellationBlockedReason = getAdminOrderCancellationBlockedReason(
    status,
    paymentState,
  );

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        <DropdownMenuRadioGroup
          value={status}
          onValueChange={(newStatus) => onStatusUpdate(orderId, newStatus)}
        >
          {transitions.map((s) => (
            <DropdownMenuRadioItem
              key={s}
              value={s}
              className="cursor-pointer text-sm hover:bg-[var(--muted)]"
            >
              {s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}
            </DropdownMenuRadioItem>
          ))}
          {transitions.length === 0 && (
            <div className="px-2 py-1.5 text-sm text-muted-foreground">
              No transitions available (terminal state)
            </div>
          )}
          {cancellationBlockedReason && (
            <div className="border-t border-border px-2 py-2 text-xs text-muted-foreground">
              {cancellationBlockedReason}
            </div>
          )}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
