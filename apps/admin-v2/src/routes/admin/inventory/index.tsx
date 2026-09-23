import { createFileRoute, Link, stripSearchParams, useNavigate } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { Button } from "~/components/ui/button";
import { IndexTabs } from "~/components/admin/resource/IndexTabs";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { AlertsTab } from "~/components/admin/inventory/AlertsTab";
import { HistoryTab } from "~/components/admin/inventory/HistoryTab";
import { VariantsTab } from "~/components/admin/inventory/VariantsTab";
import {
  alertsQuery,
  INVENTORY_SEARCH_DEFAULTS,
  movementsQuery,
  validateInventorySearch,
  variantsQuery,
  type InventoryFiltersChange,
} from "~/components/admin/inventory/inventory-search";
import type { InventoryWorkspaceSection } from "~/components/admin/inventory-workspace";
import { inventoryQueryOptions } from "~/lib/api-query-options/inventory";
import { RouteErrorComponent } from "~/lib/route-error";
import { useMessages } from "~/i18n";
import { inventoryMessages } from "~/i18n/inventory";

export const Route = createFileRoute("/admin/inventory/")({
  validateSearch: validateInventorySearch,
  search: { middlewares: [stripSearchParams(INVENTORY_SEARCH_DEFAULTS)] },
  loaderDeps: ({ search }) => search,
  loader: ({ context: { queryClient }, deps }) => {
    if (typeof window === "undefined") return;
    const query = deps.section === "variants"
      ? variantsQuery(deps)
      : deps.section === "alerts" ? alertsQuery(deps) : movementsQuery(deps);
    void queryClient.prefetchQuery(inventoryQueryOptions(query));
  },
  head: () => ({ meta: [{ title: "Inventory | Scalius Admin" }] }),
  errorComponent: RouteErrorComponent,
  component: InventoryPage,
});

function InventoryPage() {
  const t = useMessages(inventoryMessages);
  const search = Route.useSearch();
  const navigate = useNavigate();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const printIds = search.section === "variants" ? selectedIds : [];

  // Switching tabs starts that tab with its default filters.
  const openTab = useCallback(
    (section: InventoryWorkspaceSection, q = "") => {
      void navigate({ to: "/admin/inventory", resetScroll: false, search: { ...INVENTORY_SEARCH_DEFAULTS, section, q } });
    },
    [navigate],
  );
  const updateFilters = useCallback<InventoryFiltersChange>(
    (patch) => {
      void navigate({
        to: "/admin/inventory",
        resetScroll: false,
        search: ((previous: Record<string, unknown>) => ({ ...previous, ...patch })) as never,
      });
    },
    [navigate],
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("title")}
        actions={(
          <Button asChild variant="outline">
            <Link
              to="/admin/inventory/labels"
              search={printIds.length > 0 ? { variants: printIds.join(",") } : {}}
            >
              {printIds.length > 0 ? t("printLabelsCount", { count: printIds.length }) : t("printLabels")}
            </Link>
          </Button>
        )}
      />
      <div className="overflow-clip rounded-xl bg-card shadow-card">
        <IndexTabs
          label={t("views")}
          value={search.section}
          onChange={(section) => openTab(section)}
          tabs={[
            { value: "variants", label: t("tabVariants") },
            { value: "alerts", label: t("tabLowStock") },
            { value: "movements", label: t("tabHistory") },
          ]}
        />
        {search.section === "variants" ? (
          <VariantsTab filters={search} onFiltersChange={updateFilters} onSelectionChange={setSelectedIds} />
        ) : search.section === "alerts" ? (
          <AlertsTab filters={search} onFiltersChange={updateFilters} onReview={(sku) => openTab("variants", sku)} />
        ) : (
          <HistoryTab filters={search} onFiltersChange={updateFilters} />
        )}
      </div>
    </div>
  );
}
