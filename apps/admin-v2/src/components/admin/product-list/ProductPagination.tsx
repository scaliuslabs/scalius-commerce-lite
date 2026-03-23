import React from "react";
import { Button } from "../../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../../ui/tooltip";
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";
import type { Pagination } from "./hooks/useProductList";

const PAGE_SIZES = [10, 20, 50, 100] as const;

interface ProductPaginationProps {
  pagination: Pagination;
  selectedCount: number;
  isActionLoading: boolean;
  onPageChange: (page: number) => void;
  onLimitChange: (limit: number) => void;
}

export const ProductPagination = React.memo(function ProductPagination({
  pagination,
  selectedCount,
  isActionLoading,
  onPageChange,
  onLimitChange,
}: ProductPaginationProps) {
  if (pagination.totalPages <= 1) return null;

  return (
    <div className="flex items-center justify-between p-2 sm:p-3 border-t">
      <div className="text-xs text-muted-foreground hidden sm:block">
        {selectedCount > 0
          ? `${selectedCount} of ${pagination.total} row(s) selected.`
          : `Showing ${(pagination.page - 1) * pagination.limit + 1}-${Math.min(pagination.page * pagination.limit, pagination.total)} of ${pagination.total}`}
      </div>
      <div className="flex items-center space-x-2 lg:space-x-3">
        <div className="flex items-center space-x-1.5">
          <p className="text-xs font-medium text-muted-foreground whitespace-nowrap">
            Rows
          </p>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-1.5 text-xs"
              >
                {pagination.limit}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {PAGE_SIZES.map((pageSize) => (
                <DropdownMenuItem
                  key={pageSize}
                  onClick={() => onLimitChange(pageSize)}
                  className={
                    pagination.limit === pageSize
                      ? "bg-gray-100 font-medium dark:bg-gray-700"
                      : ""
                  }
                >
                  {pageSize} per page
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="flex w-[90px] items-center justify-center text-xs font-medium text-muted-foreground">
          Page {pagination.page} of {pagination.totalPages}
        </div>
        <div className="flex items-center space-x-0.5">
          <TooltipProvider delayDuration={100}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  className="h-7 w-7 p-0 hidden lg:flex"
                  onClick={() => onPageChange(1)}
                  disabled={pagination.page === 1 || isActionLoading}
                >
                  <span className="sr-only">First page</span>
                  <ChevronsLeft className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>First Page</p>
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  className="h-7 w-7 p-0"
                  onClick={() => onPageChange(pagination.page - 1)}
                  disabled={pagination.page === 1 || isActionLoading}
                >
                  <span className="sr-only">Previous page</span>
                  <ChevronLeft className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>Previous Page</p>
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  className="h-7 w-7 p-0"
                  onClick={() => onPageChange(pagination.page + 1)}
                  disabled={
                    pagination.page >= pagination.totalPages || isActionLoading
                  }
                >
                  <span className="sr-only">Next page</span>
                  <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>Next Page</p>
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  className="h-7 w-7 p-0 hidden lg:flex"
                  onClick={() => onPageChange(pagination.totalPages)}
                  disabled={
                    pagination.page >= pagination.totalPages || isActionLoading
                  }
                >
                  <span className="sr-only">Last page</span>
                  <ChevronsRight className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>Last Page</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>
    </div>
  );
});
