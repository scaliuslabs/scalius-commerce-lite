// src/components/admin/pages-list/components/PagePagination.tsx
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Pagination } from "../types";

interface PagePaginationProps {
  pagination: Pagination;
  goToPage: (page: number) => void;
  changePageSize: (limit: number) => void;
}

export function PagePagination({
  pagination,
  goToPage,
  changePageSize,
}: PagePaginationProps) {
  const { page, limit, total, totalPages } = pagination;

  return (
    <div className="flex items-center justify-between px-4 py-4 border-t">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span>
          Showing{" "}
          <span className="font-medium text-foreground">
            {(page - 1) * limit + 1}
          </span>{" "}
          to{" "}
          <span className="font-medium text-foreground">
            {Math.min(page * limit, total)}
          </span>{" "}
          of <span className="font-medium text-foreground">{total}</span> pages
        </span>
        <span className="mx-2">•</span>
        <div className="flex items-center gap-2">
          <span>Show</span>
          <Select
            value={String(limit)}
            onValueChange={(value) => changePageSize(Number(value))}
          >
            <SelectTrigger className="h-8 w-[70px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="10">10</SelectItem>
              <SelectItem value="20">20</SelectItem>
              <SelectItem value="50">50</SelectItem>
              <SelectItem value="100">100</SelectItem>
            </SelectContent>
          </Select>
          <span>per page</span>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => goToPage(page - 1)}
          disabled={page <= 1}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <div className="text-sm">
          Page <span className="font-medium">{page}</span> of{" "}
          <span className="font-medium">{totalPages}</span>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => goToPage(page + 1)}
          disabled={page >= totalPages}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
