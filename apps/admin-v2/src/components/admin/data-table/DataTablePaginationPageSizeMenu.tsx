import type { ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface DataTablePaginationPageSizeMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactNode;
  pageSize: number;
  pageSizeOptions: number[];
  onPageSizeChange: (pageSize: number) => void;
}

export function DataTablePaginationPageSizeMenu({
  open,
  onOpenChange,
  trigger,
  pageSize,
  pageSizeOptions,
  onPageSizeChange,
}: DataTablePaginationPageSizeMenuProps) {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {pageSizeOptions.map((size) => (
          <DropdownMenuItem
            key={size}
            onClick={() => onPageSizeChange(size)}
            className={pageSize === size ? "bg-muted font-medium" : ""}
          >
            {size} per page
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
