import { useMemo, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/lib/query-keys";
import { productsQueryOptions } from "@/lib/api-query-options/products";
import { useMessages } from "~/i18n";
import { productMessages } from "~/i18n/products";

/** The products list as it first opens, used when no list the merchant saw holds this product. */
const DEFAULT_LIST = { page: 1, limit: 50, sort: "updatedAt", order: "desc", view: "compact" } as const;

function neighbours(ids: string[], productId: string) {
  const index = ids.indexOf(productId);
  return index >= 0 ? { previous: ids[index - 1] ?? null, next: ids[index + 1] ?? null } : null;
}

/**
 * Previous/next product (Polaris Page pagination), taken from the most recently
 * loaded products list page that contains this product, so the list's filter
 * and sort are kept; opened directly, the default list is read instead.
 * Links go through the router, so the unsaved-changes guard still applies.
 */
export function ProductPager({ productId }: { productId: string }) {
  const t = useMessages(productMessages);
  const queryClient = useQueryClient();
  const cached = useMemo(() => {
    const lists = queryClient
      .getQueryCache()
      .findAll({ queryKey: queryKeys.products.list() })
      .filter((query) => query.state.data !== undefined)
      .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt);
    for (const list of lists) {
      const found = neighbours(((list.state.data as { products?: Array<{ id: string }> }).products ?? []).map((row) => row.id), productId);
      if (found) return found;
    }
    return null;
  }, [productId, queryClient]);
  const fallback = useQuery({ ...productsQueryOptions(DEFAULT_LIST), enabled: cached === null });
  const siblings = cached ?? neighbours((fallback.data?.products ?? []).map((row) => row.id), productId);

  if (!siblings) return null;
  return (
    <div className="flex items-center">
      <PagerButton productId={siblings.previous} label={t("previousProduct")}>
        <ChevronLeft className="h-4 w-4" />
      </PagerButton>
      <PagerButton productId={siblings.next} label={t("nextProduct")}>
        <ChevronRight className="h-4 w-4" />
      </PagerButton>
    </div>
  );
}

function PagerButton({ productId, label, children }: { productId: string | null; label: string; children: ReactNode }) {
  if (!productId) {
    return (
      <Button type="button" variant="ghost" size="icon" disabled aria-label={label}>
        {children}
      </Button>
    );
  }
  return (
    <Button variant="ghost" size="icon" asChild>
      <Link to="/admin/products/$productId/edit" params={{ productId }} aria-label={label}>
        {children}
      </Link>
    </Button>
  );
}
