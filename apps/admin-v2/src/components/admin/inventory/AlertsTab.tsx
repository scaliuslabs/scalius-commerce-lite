import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { patchApiV1AdminInventoryAlerts, putApiV1AdminInventoryDefaultAlertLevel } from "@scalius/api-client/sdk";
import type { ColumnDef, Row } from "~/components/admin/data-table/table-config";
import { DataTable } from "~/components/admin/data-table/DataTable";
import { DataTableToolbar } from "~/components/admin/data-table/DataTableToolbar";
import { useServerTable } from "~/components/admin/data-table/useServerTable";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import { NumberInput } from "~/components/ui/number-input";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import { NativeSelect } from "~/components/ui/native-select";
import { useCatalogActionPermissions } from "~/hooks/use-catalog-action-permissions";
import { apiData } from "~/lib/api";
import { inventoryQueryOptions, type InventoryAlert, type InventoryOverview } from "~/lib/api-query-options/inventory";
import { createDataSelector } from "~/lib/list-helpers";
import { queryKeys } from "~/lib/query-keys";
import { formatDateTime, formatNumber, useMessages } from "~/i18n";
import { inventoryMessages } from "~/i18n/inventory";
import { resourceMessages } from "~/i18n/resource";
import { VariantName } from "./VariantsTab";
import { IdText } from "~/components/admin/data-table/cells";
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

const ALERT_LEVEL_MAX = 1_000_000;

/** Shopify's store-wide low-stock level: one small popover, used by variants without their own level. */
function StoreAlertLevel({ level, canEdit, open, onOpenChange }: {
  level: number | null;
  canEdit: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useMessages(inventoryMessages);
  const r = useMessages(resourceMessages);
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<number | null>(level);
  const valid = draft === null || (Number.isSafeInteger(draft) && draft >= 0 && draft <= ALERT_LEVEL_MAX);
  const save = useMutation({
    mutationFn: (defaultLowStockThreshold: number | null) =>
      apiData(putApiV1AdminInventoryDefaultAlertLevel({ body: { defaultLowStockThreshold } })),
    onSuccess: async () => {
      toast.success(t("storeAlertLevelSaved"));
      onOpenChange(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys.inventory.all });
      await queryClient.invalidateQueries({ queryKey: ["home", "low-stock"] });
    },
    onError: () => toast.error(t("storeAlertLevelFailed")),
  });
  const label = t("storeAlertLevelValue", { level: level === null ? t("alertOff") : level });
  if (!canEdit) return <span className="text-body text-muted-foreground">{label}</span>;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setDraft(level);
        onOpenChange(next);
      }}
    >
      <PopoverTrigger asChild>
        <Button type="button" variant="outline">{label}</Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto max-w-sm">
        <form
          method="post"
          noValidate
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid && !save.isPending) save.mutate(draft);
          }}
        >
          <Label htmlFor="inventory-store-alert-level">{t("storeAlertLevel")}</Label>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-body">{t("alertWhen")}</span>
            <NumberInput
              id="inventory-store-alert-level"
              integer
              className="w-24"
              value={draft}
              aria-invalid={valid ? undefined : true}
              aria-describedby="inventory-store-alert-level-help"
              onValueChange={setDraft}
            />
            <span className="text-body">{t("alertOrFewer")}</span>
          </div>
          <p
            id="inventory-store-alert-level-help"
            className={valid ? "text-body text-muted-foreground" : "text-body text-destructive"}
          >
            {valid ? t("storeAlertLevelHelp") : t("alertLevelInvalid")}
          </p>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{r("cancel")}</Button>
            <Button type="submit" disabled={!valid || draft === level} loading={save.isPending}>{r("save")}</Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

interface AlertsTabProps {
  filters: Pick<InventoryFilters, "q" | "alert">;
  onFiltersChange: InventoryFiltersChange;
  onReview: (sku: string) => void;
}

export function AlertsTab({ filters, onFiltersChange, onReview }: AlertsTabProps) {
  const t = useMessages(inventoryMessages);
  const r = useMessages(resourceMessages);
  const queryClient = useQueryClient();
  const { inventory: permissions } = useCatalogActionPermissions();
  const { q: search, alert: status } = filters;
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(50);
  const [storeLevelOpen, setStoreLevelOpen] = useState(false);
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
      header: t("product"),
      meta: { primary: true, minWidth: 220 },
      cell: ({ row }) => name(row.original),
    },
    {
      id: "sku",
      header: t("sku"),
      meta: { priority: 70, minWidth: 150 },
      cell: ({ row }) => <IdText value={row.original.variantSku} copy className="text-muted-foreground" />,
    },
    {
      id: "available",
      header: t("available"),
      meta: { numeric: true, priority: 95, minWidth: 90 },
      cell: ({ row }) => formatNumber(row.original.currentQty),
    },
    {
      id: "threshold",
      header: t("alertAt"),
      meta: { numeric: true, priority: 60, minWidth: 90 },
      // The level that applies (the variant's own, else the store level); sold-out variants without one show 0.
      cell: ({ row }) => (
        <span className="text-muted-foreground">{row.original.threshold > 0 ? formatNumber(row.original.threshold) : "—"}</span>
      ),
    },
    { id: "status", header: r("status"), meta: { priority: 90, minWidth: 110 }, cell: ({ row }) => statusBadge(row.original) },
    {
      id: "updated",
      header: r("updated"),
      meta: { priority: 30, minWidth: 120 },
      cell: ({ row }) => (
        <span className="whitespace-nowrap text-body text-muted-foreground">
          {formatDateTime(toDate(row.original.updatedAt), { dateStyle: "medium" })}
        </span>
      ),
    },
    { id: "actions", cell: ({ row }) => actions(row.original) },
  ];

  const { table, rawData, isFetching, isLoading, error, refetch } = useServerTable<InventoryAlert>({
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

  const overview = rawData as InventoryOverview | undefined;

  const mobileCard = (row: Row<InventoryAlert>) => {
    const alert = row.original;
    return (
      <div className="space-y-2 px-3 py-2">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            {name(alert)}
            <IdText value={alert.variantSku} copy className="text-muted-foreground" />
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
      layoutKey="inventory-alerts"
      toolbar={<div className="px-2 pt-2"><DataTableToolbar
          searchValue={search}
          onSearchChange={(value) => onFiltersChange({ q: value })}
          searchPlaceholder={t("searchProducts")}
          filters={(
            <NativeSelect
              className="w-auto min-w-40"
              aria-label={t("alertStatus")}
              value={status}
              onValueChange={(value) => onFiltersChange({ alert: value as AlertFilter })}
            >
              {ALERT_FILTERS.map((value) => (
                <option key={value} value={value}>{t(ALERT_LABEL[value])}</option>
              ))}
            </NativeSelect>
          )}
          actions={overview ? (
            <StoreAlertLevel
              level={overview.defaultLowStockThreshold ?? null}
              canEdit={permissions.canAdjustStock}
              open={storeLevelOpen}
              onOpenChange={setStoreLevelOpen}
            />
          ) : null}
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
            action: permissions.canAdjustStock
              ? <Button type="button" variant="outline" onClick={() => setStoreLevelOpen(true)}>{t("setAlertLevels")}</Button>
              : undefined,
          }}
    />
  );
}
