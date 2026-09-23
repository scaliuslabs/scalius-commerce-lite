import { useMemo, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/lib/query-keys";
import { useMessages } from "~/i18n";
import { productMessages } from "~/i18n/products";

/**
 * Previous/next product, taken from the most recently loaded products list
 * page that contains this product. Hidden when no such list is cached.
 * Links go through the router, so the unsaved-changes guard still applies.
 */
export function ProductPager({ productId }: { productId: string }) {
  const t = useMessages(productMessages);
  const queryClient = useQueryClient();
  const siblings = useMemo(() => {
    const lists = queryClient
      .getQueryCache()
      .findAll({ queryKey: queryKeys.products.list() })
      .filter((query) => query.state.data !== undefined)
      .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt);
    for (const list of lists) {
      const ids = ((list.state.data as { products?: Array<{ id: string }> }).products ?? []).map((row) => row.id);
      const index = ids.indexOf(productId);
      if (index >= 0) return { previous: ids[index - 1] ?? null, next: ids[index + 1] ?? null };
    }
    return null;
  }, [productId, queryClient]);

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
