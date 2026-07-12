import type { ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import { getAdminOrderStatusTransitions } from "@/lib/admin-order-status-policy";

export interface OrderStatusSelectorMenuProps {
  status: string;
  orderId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStatusUpdate: (orderId: string, newStatus: string) => void;
  trigger: ReactNode;
}

export function OrderStatusSelectorMenu({
  status,
  orderId,
  open,
  onOpenChange,
  onStatusUpdate,
  trigger,
}: OrderStatusSelectorMenuProps) {
  const transitions = getAdminOrderStatusTransitions(status);

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
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
