import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Plus, TicketPercent } from "lucide-react";

import {
  PromotionList,
  type PromotionStatusFilter,
} from "~/components/admin/promotion/PromotionList";
import { Button } from "~/components/ui/button";
import { usePermissions } from "~/contexts/PermissionContext";
import { useCurrency } from "~/hooks/use-currency";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { promotionListQueryOptions } from "~/lib/api-query-options/promotions";
import { RouteErrorComponent } from "~/lib/route-error";

const STATUS_FILTERS = new Set<PromotionStatusFilter>([
  "draft",
  "active",
  "paused",
  "archived",
]);

interface PromotionListSearch {
  q?: string;
  status?: PromotionStatusFilter;
}

export function validatePromotionListSearch(
  search: Record<string, unknown>,
): PromotionListSearch {
  const q = typeof search.q === "string" ? search.q.trim().slice(0, 120) : "";
  const status = typeof search.status === "string"
    && STATUS_FILTERS.has(search.status as PromotionStatusFilter)
    ? search.status as PromotionStatusFilter
    : undefined;
  return {
    ...(q ? { q } : {}),
    ...(status ? { status } : {}),
  };
}

export const Route = createFileRoute("/admin/promotions/")({
  validateSearch: validatePromotionListSearch,
  loader: async ({ context: { queryClient } }) => {
    await queryClient.ensureQueryData(promotionListQueryOptions({ limit: 90 }));
  },
  head: () => ({ meta: [{ title: "Promotions | Scalius Admin" }] }),
  errorComponent: RouteErrorComponent,
  component: PromotionsPage,
});

function PromotionsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { symbol } = useCurrency();
  const { hasPermission } = usePermissions();
  const canCreate = hasPermission(ADMIN_PERMISSIONS.DISCOUNTS_CREATE);
  const { data: promotions } = useSuspenseQuery(
    promotionListQueryOptions({ limit: 90 }),
  );

  function updateSearch(values: Partial<PromotionListSearch>) {
    void navigate({
      search: (previous) => ({ ...previous, ...values }),
      replace: true,
    });
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-center gap-2">
          <TicketPercent className="size-5" />
          <h1 className="text-2xl font-bold tracking-tight">Promotions</h1>
        </div>
        {canCreate ? (
          <Button asChild size="sm" className="h-11 w-full sm:h-9 sm:w-auto">
            <Link to="/admin/promotions/new"><Plus className="mr-2 size-4" />Create promotion</Link>
          </Button>
        ) : null}
      </header>

      <PromotionList
        promotions={promotions}
        search={search.q ?? ""}
        status={search.status}
        currencySymbol={symbol}
        canCreate={canCreate}
        onSearchChange={(q) => updateSearch({ q: q || undefined })}
        onStatusChange={(status) => updateSearch({ status })}
      />
    </div>
  );
}
