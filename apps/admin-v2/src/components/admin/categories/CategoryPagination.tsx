import React from "react";
import { Button } from "../../ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../ui/select";
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
import type { Pagination } from "./hooks/useCategoryList";

const PAGE_SIZES = [10, 20, 50, 100] as const;

interface CategoryPaginationProps {
  pagination: Pagination;
  selectedCount: number;
  isActionLoading: boolean;
  onPageChange: (page: number) => void;
  onLimitChange: (limit: number) => void;
}

export const CategoryPagination = React.memo(function CategoryPagination({
  pagination,
  selectedCount,
  isActionLoading,
  onPageChange,
  onLimitChange,
}: CategoryPaginationProps) {
  if (pagination.totalPages <= 1) return null;

  return (
    <div className="flex items-center justify-between p-2 sm:p-3 border-t">
      <div className="text-sm text-muted-foreground/80 hidden sm:block">
        {selectedCount > 0
          ? `${selectedCount} of ${pagination.total} row(s) selected.`
          : `Showing ${(pagination.page - 1) * pagination.limit + 1}-${Math.min(pagination.page * pagination.limit, pagination.total)} of ${pagination.total}`}
      </div>
      <div className="flex items-center space-x-2 lg:space-x-3">
        <div className="flex items-center space-x-1.5">
          <p className="text-sm font-medium text-muted-foreground/80 whitespace-nowrap">
            Rows
          </p>
          <Select
            value={pagination.limit.toString()}
            onValueChange={(value) => onLimitChange(Number(value))}
          >
            <SelectTrigger className="h-7 w-[60px] text-sm">
              <SelectValue placeholder={pagination.limit} />
            </SelectTrigger>
            <SelectContent className="rounded-xl bg-background">
              {PAGE_SIZES.map((pageSize) => (
                <SelectItem key={pageSize} value={pageSize.toString()}>
                  {pageSize}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex w-[90px] items-center justify-center text-sm font-medium text-muted-foreground/80">
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
