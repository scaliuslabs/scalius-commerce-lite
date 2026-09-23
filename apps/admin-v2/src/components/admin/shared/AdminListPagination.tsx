import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "~/components/ui/button";
import { useMessages } from "~/i18n";
import { resourceMessages } from "~/i18n/resource";

export interface AdminListPaginationState {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/**
 * Previous/next for a server-paged list, as under the data tables: the range
 * on the left ("21–40 of 95"), arrow buttons on the right.
 */
export function AdminListPagination({
  pagination,
  onPageChange,
}: {
  pagination: AdminListPaginationState;
  onPageChange: (nextPage: number) => void;
}) {
  const t = useMessages(resourceMessages);
  const { total, page, limit, totalPages } = pagination;
  if (total === 0) return null;

  const start = (page - 1) * limit + 1;
  const end = Math.min(page * limit, total);
  return (
    <div className="flex items-center justify-between gap-2 border-t px-3 py-2 text-body text-muted-foreground">
      <span>{t("showing", { start, end, total })}</span>
      <nav aria-label={t("page", { page, pages: Math.max(1, totalPages) })} className="flex items-center gap-1">
        <Button
          variant="outline"
          size="icon"
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
          aria-label={t("previous")}
        >
          <ChevronLeft />
        </Button>
        <Button
          variant="outline"
          size="icon"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= totalPages}
          aria-label={t("next")}
        >
          <ChevronRight />
        </Button>
      </nav>
    </div>
  );
}
