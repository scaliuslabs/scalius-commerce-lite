import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { patchApiV1AdminInventoryAlerts } from "@scalius/api-client/sdk";
import type { ColumnDef, Row } from "~/components/admin/data-table/table-config";
import { DataTable } from "~/components/admin/data-table/DataTable";
import { DataTableToolbar } from "~/components/admin/data-table/DataTableToolbar";
import { useServerTable } from "~/components/admin/data-table/useServerTable";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { useCatalogActionPermissions } from "~/hooks/use-catalog-action-permissions";
import { apiData } from "~/lib/api";
import { inventoryQueryOptions, type InventoryAlert } from "~/lib/api-query-options/inventory";
import { createDataSelector } from "~/lib/list-helpers";
import { queryKeys } from "~/lib/query-keys";
import { formatDateTime, formatNumber, useMessages } from "~/i18n";
import { inventoryMessages } from "~/i18n/inventory";
import { resourceMessages } from "~/i18n/resource";
import { VariantName } from "./VariantsTab";
import {
  ALERT_FILTERS,
  alertsQuery,
  type AlertFilter,
  type InventoryFilters,
  type InventoryFiltersChange,
} from "./inventory-search";

const ALERT_LABEL = {
  active: "alertActive",
  acknowledged: "alertAcknowledged",
  resolved: "alertResolved",
  all: "alertAll",
} as const;
const ALERT_BADGE = { active: "warning", acknowledged: "secondary", resolved: "secondary" } as const;

const selectAlerts = createDataSelector<InventoryAlert>("alerts");

export function toDate(value: string | number): Date {
  return new Date(typeof value === "number" && value < 10_000_000_000 ? value * 1000 : value);
}

interface AlertsTabProps {
  filters: Pick<InventoryFilters, "q" | "alert">;
  onFiltersChange: InventoryFiltersChange;
  onReview: (sku: string) => void;
  onSetAlertLevels: () => void;
}

export function AlertsTab({ filters, onFiltersChange, onReview, onSetAlertLevels }: AlertsTabProps) {
  const t = useMessages(inventoryMessages);
  const r = useMessages(resourceMessages);
  const queryClient = useQueryClient();
  const { inventory: permissions } = useCatalogActionPermissions();
  const { q: search, alert: status } = filters;
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(50);
  useEffect(() => setPage(1), [search, status]);

  const acknowledge = useMutation({
    mutationFn: (variantId: string) => apiData(patchApiV1AdminInventoryAlerts({ body: { variantId } })),
    onSuccess: async () => {
      toast.success(t("markedSeen"));
      await queryClient.invalidateQueries({ queryKey: queryKeys.inventory.all });
    },
    onError: () => toast.error(r("actionFailed")),
  });

  const statusBadge = (alert: InventoryAlert) => {
    const value = alert.alertStatus as keyof typeof ALERT_BADGE;
    return ALERT_BADGE[value] ? <Badge variant={ALERT_BADGE[value]}>{t(ALERT_LABEL[value])}</Badge> : null;
  };

  const actions = (alert: InventoryAlert) => (
    <div className="flex justify-end gap-2">
      <Button type="button" variant="ghost" size="sm" onClick={() => onReview(alert.variantSku ?? alert.variantId)}>
        {t("review")}
      </Button>
      {alert.alertStatus === "active" && permissions.canAcknowledgeAlerts ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={acknowledge.isPending}
          onClick={() => acknowledge.mutate(alert.variantId)}
        >
          {t("markSeen")}
        </Button>
      ) : null}
    </div>
  );

  const name = (alert: InventoryAlert) => (
    <VariantName productId={alert.productId} productName={alert.productName} optionLabel={alert.variantLabel} />
  );

  const columns: ColumnDef<InventoryAlert, unknown>[] = [
    {
      id: "product",
      header: () => t("product"),
      cell: ({ row }) => (
        <div className="min-w-0">
          {name(row.original)}
          <span className="block break-all font-mono text-body text-muted-foreground">{row.original.variantSku}</span>
        </div>
      ),
    },
    {
      id: "available",
      header: () => <div className="text-right">{t("available")}</div>,
      cell: ({ row }) => <div className="text-right tabular-nums">{formatNumber(row.original.currentQty)}</div>,
    },
    {
      id: "threshold",
      header: () => <div className="text-right">{t("alertAt")}</div>,
      // Sold-out variants without an alert level are flagged with level 0.
      cell: ({ row }) => (
        <div className="text-right tabular-nums text-muted-foreground">
          {row.original.threshold > 0 ? formatNumber(row.original.threshold) : "—"}
        </div>
      ),
    },
    { id: "status", header: () => r("status"), cell: ({ row }) => statusBadge(row.original) },
    {
      id: "updated",
      header: () => r("updated"),
      cell: ({ row }) => (
        <span className="text-body text-muted-foreground">
          {formatDateTime(toDate(row.original.updatedAt), { dateStyle: "medium" })}
        </span>
      ),
    },
    { id: "actions", cell: ({ row }) => actions(row.original) },
  ];

  const { table, isFetching, isLoading, error, refetch } = useServerTable<InventoryAlert>({
    columns,
    queryOptions: inventoryQueryOptions(alertsQuery(filters, page, limit)),
    dataSelector: selectAlerts,
    currentPage: page,
    currentLimit: limit,
    onPaginationChange: (nextPage, nextLimit) => {
      setPage(nextPage);
      setLimit(nextLimit);
    },
    onSortingChange: () => undefined,
    enableRowSelection: false,
    enableSorting: false,
    defaultPageSize: 50,
  });

  const mobileCard = (row: Row<InventoryAlert>) => {
    const alert = row.original;
    return (
      <div className="space-y-2 px-3 py-2">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            {name(alert)}
            <p className="break-all font-mono text-body text-muted-foreground">{alert.variantSku}</p>
            <p className="text-body text-muted-foreground">{t("availableCount", { count: alert.currentQty })}</p>
          </div>
          {statusBadge(alert)}
        </div>
        {actions(alert)}
      </div>
    );
  };

  return (
    <DataTable
      variant="bare"
      getRowHref={(alert) => `/admin/products/${alert.productId}/edit`}
      table={table}
      isFetching={isFetching}
      isLoading={isLoading}
      error={error}
      onRetry={() => void refetch()}
      itemLabel={t("alertsItem")}
      pageSizeOptions={[20, 50, 100]}
      mobileCardRenderer={mobileCard}
      toolbar={<div className="px-2 pt-2"><DataTableToolbar
          searchValue={search}
          onSearchChange={(value) => onFiltersChange({ q: value })}
          searchPlaceholder={t("searchProducts")}
          filters={(
            <Select
              value={status}
              onValueChange={(value) => onFiltersChange({ alert: value as AlertFilter })}
            >
              <SelectTrigger className="w-auto min-w-40" aria-label={t("alertStatus")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ALERT_FILTERS.map((value) => (
                  <SelectItem key={value} value={value}>{t(ALERT_LABEL[value])}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        /></div>}
      emptyState={search || status !== "active"
        ? {
            title: r("noResults"),
            description: r("noResultsHint"),
            action: (
              <Button
                type="button"
                variant="outline"
                onClick={() => onFiltersChange({ q: "", alert: "active" })}
              >
                {t("clearFilters")}
              </Button>
            ),
          }
        : {
            title: t("noAlerts"),
            description: t("noAlertsHint"),
            action: <Button type="button" variant="outline" onClick={onSetAlertLevels}>{t("setAlertLevels")}</Button>,
          }}
    />
  );
}
