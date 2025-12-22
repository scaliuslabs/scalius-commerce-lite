import { Button } from "../../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";

interface OrderListPaginationProps {
  pagination: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
  onPageChange: (newPage: number) => void;
  onLimitChange: (newLimit: number) => void;
}

export function OrderListPagination({
  pagination,
  onPageChange,
  onLimitChange,
}: OrderListPaginationProps) {
  if (pagination.total === 0) {
    return null; // Don't render pagination if there are no orders
  }

  return (
    <div className="flex items-center justify-between px-4 py-5">
      <div className="flex items-center gap-4">
        <div className="text-sm text-[var(--muted-foreground)]">
          Showing{" "}
          <span className="font-medium text-[var(--foreground)]">
            {(pagination.page - 1) * pagination.limit + 1}
          </span>{" "}
          to{" "}
          <span className="font-medium text-[var(--foreground)]">
            {Math.min(pagination.page * pagination.limit, pagination.total)}
          </span>{" "}
          of{" "}
          <span className="font-medium text-[var(--foreground)]">
            {pagination.total}
          </span>{" "}
          orders
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-8 px-2 text-xs border-[var(--border)] bg-[var(--card)] text-[var(--foreground)] hover:bg-[var(--muted)]"
            >
              {pagination.limit} per page
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {[5, 10, 20, 50, 100].map((limit) => (
              <DropdownMenuItem
                key={limit}
                onClick={() => onLimitChange(limit)}
                className={
                  pagination.limit === limit
                    ? "bg-[var(--muted)] font-medium"
                    : ""
                }
              >
                {limit} per page
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <nav aria-label="Pagination" className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => onPageChange(pagination.page - 1)}
          disabled={pagination.page === 1}
          className="h-9 px-3 text-sm border-[var(--border)] hover:bg-[var(--muted)] text-[var(--foreground)]"
        >
          Previous
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onPageChange(pagination.page + 1)}
          disabled={pagination.page === pagination.totalPages}
          className="h-9 px-3 text-sm border-[var(--border)] hover:bg-[var(--muted)] text-[var(--foreground)]"
        >
          Next
        </Button>
      </nav>
    </div>
  );
}