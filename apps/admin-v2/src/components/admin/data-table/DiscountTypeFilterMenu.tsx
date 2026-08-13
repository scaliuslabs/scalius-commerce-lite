import type { ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface DiscountTypeFilterMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactNode;
  activeType: string | null;
  onTypeFilterChange: (type: string | null) => void;
}

export function DiscountTypeFilterMenu({
  open,
  onOpenChange,
  trigger,
  activeType,
  onTypeFilterChange,
}: DiscountTypeFilterMenuProps) {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup
          value={activeType || ""}
          onValueChange={(value) => onTypeFilterChange(value || null)}
        >
          <DropdownMenuRadioItem
            value=""
          >All Types</DropdownMenuRadioItem>
          <DropdownMenuRadioItem
            value="amount_off_products"
          >
            Amount Off Products
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem
            value="amount_off_order"
          >
            Amount Off Order
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem
            value="free_shipping"
          >
            Free Shipping
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
