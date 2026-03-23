import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Filter, X } from "lucide-react";
import { DataTableToolbar } from "./DataTableToolbar";
import { getTypeLabel } from "./columns/discount-columns";

interface DiscountTableToolbarProps {
  searchValue: string;
  onSearchChange: (value: string) => void;
  selectedCount: number;
  bulkActions?: ReactNode;
  actions?: ReactNode;
  activeType: string | null;
  onTypeFilterChange: (type: string | null) => void;
}

export function DiscountTableToolbar({
  searchValue,
  onSearchChange,
  selectedCount,
  bulkActions,
  actions,
  activeType,
  onTypeFilterChange,
}: DiscountTableToolbarProps) {
  const typeFilter = (
    <div className="flex items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="h-9">
            <Filter className="h-4 w-4 mr-1.5" />
            Type
            {activeType ? (
              <span className="ml-1.5 text-xs text-muted-foreground">(1)</span>
            ) : null}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuRadioGroup
            value={activeType || ""}
            onValueChange={(value) => onTypeFilterChange(value || null)}
          >
            <DropdownMenuRadioItem value="">All Types</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="amount_off_products">
              Amount Off Products
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="amount_off_order">
              Amount Off Order
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="free_shipping">
              Free Shipping
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {activeType ? (
        <Badge
          variant="secondary"
          className="rounded-md px-2 py-0.5 text-xs"
        >
          Type: {getTypeLabel(activeType)}
          <button
            onClick={() => onTypeFilterChange(null)}
            className="ml-1 rounded-full hover:bg-background p-0.5 focus:outline-none focus:ring-1 focus:ring-ring"
            aria-label="Clear type filter"
          >
            <X className="h-3 w-3" />
          </button>
        </Badge>
      ) : null}
    </div>
  );

  return (
    <DataTableToolbar
      searchValue={searchValue}
      onSearchChange={onSearchChange}
      searchPlaceholder="Search by code..."
      selectedCount={selectedCount}
      bulkActions={bulkActions}
      filters={typeFilter}
      actions={actions}
    />
  );
}
