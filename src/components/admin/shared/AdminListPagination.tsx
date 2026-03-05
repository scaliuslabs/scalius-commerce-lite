import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";

export interface AdminListPaginationState {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

interface AdminListPaginationProps {
  pagination: AdminListPaginationState;
  itemLabel: string;
  onPageChange: (nextPage: number) => void;
  onLimitChange?: (nextLimit: number) => void;
  pageSizeOptions?: number[];
  showFirstLast?: boolean;
}

export function AdminListPagination({
  pagination,
  itemLabel,
  onPageChange,
  onLimitChange,
  pageSizeOptions = [10, 20, 50, 100],
  showFirstLast = false,
}: AdminListPaginationProps) {
  if (!pagination || pagination.total === 0) return null;

  const start = (pagination.page - 1) * pagination.limit + 1;
  const end = Math.min(pagination.page * pagination.limit, pagination.total);
  const canPrev = pagination.page > 1;
  const canNext = pagination.page < pagination.totalPages;

  return (
    <div className="flex flex-col gap-3 border-t px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-wrap items-center gap-3">
        <div className="text-sm text-muted-foreground">
          Showing{" "}
          <span className="font-medium text-foreground">{start}</span> to{" "}
          <span className="font-medium text-foreground">{end}</span> of{" "}
          <span className="font-medium text-foreground">{pagination.total}</span>{" "}
          {itemLabel}
        </div>
        {onLimitChange && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-8 px-2 text-xs text-foreground"
              >
                {pagination.limit} per page
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {pageSizeOptions.map((size) => (
                <DropdownMenuItem
                  key={size}
                  onClick={() => onLimitChange(size)}
                  className={
                    pagination.limit === size ? "bg-muted font-medium" : ""
                  }
                >
                  {size} per page
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <nav aria-label="Pagination" className="flex items-center gap-1.5">
        {showFirstLast && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onPageChange(1)}
            disabled={!canPrev}
            className="h-8 w-8 p-0"
            aria-label="First page"
          >
            <ChevronsLeft className="h-4 w-4" />
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={() => onPageChange(pagination.page - 1)}
          disabled={!canPrev}
          className="h-8 px-2.5 text-xs"
        >
          <ChevronLeft className="mr-1 h-4 w-4" />
          Previous
        </Button>
        <div className="min-w-[90px] text-center text-sm text-muted-foreground">
          Page <span className="font-medium text-foreground">{pagination.page}</span>{" "}
          of{" "}
          <span className="font-medium text-foreground">
            {pagination.totalPages}
          </span>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onPageChange(pagination.page + 1)}
          disabled={!canNext}
          className="h-8 px-2.5 text-xs"
        >
          Next
          <ChevronRight className="ml-1 h-4 w-4" />
        </Button>
        {showFirstLast && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onPageChange(pagination.totalPages)}
            disabled={!canNext}
            className="h-8 w-8 p-0"
            aria-label="Last page"
          >
            <ChevronsRight className="h-4 w-4" />
          </Button>
        )}
      </nav>
    </div>
  );
}
