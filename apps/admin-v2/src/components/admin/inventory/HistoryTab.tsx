import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Download } from "lucide-react";
import { DataTableToolbar } from "~/components/admin/data-table/DataTableToolbar";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Skeleton } from "~/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { inventoryQueryOptions, type InventoryMovement } from "~/lib/api-query-options/inventory";
import { adminCalendarDateKey } from "~/lib/admin-time";
import { withDashboardBasePath } from "~/lib/dashboard-base-path";
import { cn } from "@scalius/shared/utils";
import { formatDateTime, formatNumber, useMessages } from "~/i18n";
import { inventoryMessages } from "~/i18n/inventory";
import { resourceMessages } from "~/i18n/resource";
import { toDate } from "./AlertsTab";
import { describeMovementNote } from "./movement-note";
import {
  MOVEMENT_TYPES,
  movementsQuery,
  type InventoryFilters,
  type InventoryFiltersChange,
  type MovementFilter,
  type MovementType,
} from "./inventory-search";


type CounterChange = {
  label: "counterStock" | "onHand" | "committed" | "counterPreorder";
  previous: number;
  next: number;
  delta: number;
};

function counterChanges(movement: InventoryMovement): CounterChange[] {
  if (movement.ledgerVersion !== 2) {
    return [{
      label: "counterStock",
      previous: movement.previousStock,
      next: movement.newStock,
      delta: movement.newStock - movement.previousStock,
    }];
  }
  const changes: CounterChange[] = [];
  if (movement.stockDelta) {
    changes.push({ label: "onHand", previous: movement.previousStock, next: movement.newStock, delta: movement.stockDelta });
  }
  if (movement.reservedStockDelta && movement.previousReservedStock != null && movement.newReservedStock != null) {
    changes.push({
      label: "committed",
      previous: movement.previousReservedStock,
      next: movement.newReservedStock,
      delta: movement.reservedStockDelta,
    });
  }
  if (movement.preorderStockDelta && movement.previousPreorderStock != null && movement.newPreorderStock != null) {
    changes.push({
      label: "counterPreorder",
      previous: movement.previousPreorderStock,
      next: movement.newPreorderStock,
      delta: movement.preorderStockDelta,
    });
  }
  return changes.length > 0
    ? changes
    : [{ label: "counterStock", previous: movement.previousStock, next: movement.newStock, delta: 0 }];
}

function MovementDetails({ movement }: { movement: InventoryMovement }) {
  const t = useMessages(inventoryMessages);
  const { labels, note } = describeMovementNote(movement);
  const parts = [
    movement.actorType === "system" ? t("automatic") : t("byName", { name: movement.actorName }),
    ...labels.map((label) => t(label)),
  ];
  return (
    <p className="truncate text-body text-muted-foreground">
      {parts.join(" · ")}
      {movement.orderId ? (
        <>
          {" · "}
          <Link to="/admin/orders/$orderId" params={{ orderId: movement.orderId }} className="hover:underline">
            {t("order", { id: movement.orderId })}
          </Link>
        </>
      ) : null}
      {note ? ` · “${note}”` : null}
    </p>
  );
}

interface HistoryTabProps {
  filters: Pick<InventoryFilters, "q" | "type" | "from" | "to">;
  onFiltersChange: InventoryFiltersChange;
}

export function HistoryTab({ filters, onFiltersChange }: HistoryTabProps) {
  const t = useMessages(inventoryMessages);
  const r = useMessages(resourceMessages);
  const { q: search, type, from: startDate, to: endDate } = filters;
  const [cursors, setCursors] = useState<string[]>([""]);
  const [exporting, setExporting] = useState(false);
  // Any filter or search change goes back to the first page.
  useEffect(() => setCursors([""]), [search, type, startDate, endDate]);

  const query = useQuery({
    ...inventoryQueryOptions(movementsQuery(filters, cursors.at(-1))),
    placeholderData: keepPreviousData,
  });
  const movements = query.data?.movements ?? [];
  const pageInfo = query.data?.pageInfo;
  const nextCursor = pageInfo?.hasMore ? pageInfo.nextCursor : null;
  const filtered = Boolean(search || startDate || endDate || type !== "all");

  const exportCsv = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const response = await fetch(withDashboardBasePath("/api/v1/admin/inventory/movements/export"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          search,
          movementType: type,
          movementStartDate: startDate || undefined,
          movementEndDate: endDate || undefined,
          maxRows: 5_000,
        }),
      });
      if (!response.ok) throw new Error("export failed");
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = `inventory-movements-${adminCalendarDateKey()}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch {
      toast.error(t("exportFailed"));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="p-3">
      <DataTableToolbar
        searchValue={search}
        onSearchChange={(value) => onFiltersChange({ q: value })}
        searchPlaceholder={t("searchProducts")}
        filters={(
          <>
            <Select
              value={type}
              onValueChange={(value) => onFiltersChange({ type: value as MovementFilter })}
            >
              <SelectTrigger className="w-auto min-w-40" aria-label={t("changeType")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("typeAll")}</SelectItem>
                {MOVEMENT_TYPES.map((value) => (
                  <SelectItem key={value} value={value}>{t(`type_${value}`)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              type="date"
              className="w-40"
              aria-label={t("fromDate")}
              max={endDate || undefined}
              value={startDate}
              onChange={(event) => onFiltersChange({ from: event.target.value })}
            />
            <Input
              type="date"
              className="w-40"
              aria-label={t("toDate")}
              min={startDate || undefined}
              value={endDate}
              onChange={(event) => onFiltersChange({ to: event.target.value })}
            />
          </>
        )}
        actions={(
          <Button type="button" variant="outline" size="sm" disabled={exporting} onClick={() => void exportCsv()}>
            <Download />
            {exporting ? t("exporting") : t("export")}
          </Button>
        )}
      />

      <div className={cn("-mx-3 border-y", query.isFetching && movements.length > 0 && "opacity-60")} aria-busy={query.isFetching}>
        {query.isError ? (
          <div className="space-y-3 p-6 text-center">
            <p className="text-body text-destructive">{r("loadFailed")}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => void query.refetch()}>{r("retry")}</Button>
          </div>
        ) : query.isLoading ? (
          <ul role="status" aria-label={t("loading")} className="divide-y">
            {[0, 1, 2, 3, 4].map((row) => (
              <li key={row} className="space-y-1 px-3 py-2">
                <Skeleton className="h-5 w-2/3" />
                <Skeleton className="h-5 w-1/2" />
              </li>
            ))}
          </ul>
        ) : movements.length === 0 ? (
          <div className="p-6 text-center">
            <p className="text-body font-medium">{filtered ? r("noResults") : t("noHistory")}</p>
            <p className="text-body text-muted-foreground">{filtered ? r("noResultsHint") : t("noHistoryHint")}</p>
            {filtered ? (
              <Button
                type="button"
                variant="outline"
                className="mt-4"
                onClick={() => onFiltersChange({ q: "", type: "all", from: "", to: "" })}
              >
                {t("clearFilters")}
              </Button>
            ) : null}
          </div>
        ) : (
          <ul className="divide-y">
            {movements.map((movement) => (
              <li key={movement.id} className="flex flex-col gap-1 px-3 py-2 sm:flex-row sm:items-start sm:gap-3">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <Badge variant="outline" className="shrink-0">
                      {MOVEMENT_TYPES.includes(movement.type as MovementType)
                        ? t(`type_${movement.type as MovementType}`)
                        : movement.type}
                    </Badge>
                    <span className="text-body font-medium">
                      {movement.productName ?? t("unknownProduct")}
                      {movement.optionLabel ? (
                        <span className="font-normal text-muted-foreground"> · {movement.optionLabel}</span>
                      ) : null}
                    </span>
                    <span className="break-all font-mono text-body text-muted-foreground">
                      {movement.variantSku ?? movement.variantId.slice(0, 8)}
                    </span>
                  </div>
                  <MovementDetails movement={movement} />
                </div>
                <div className="shrink-0 space-y-1 sm:text-right">
                  {counterChanges(movement).map((change) => (
                    <p key={change.label} className="text-body tabular-nums">
                      <span className="text-muted-foreground">{t(change.label)} </span>
                      <span className={cn("font-medium", change.delta < 0 && "text-destructive")}>
                        {change.delta > 0 ? "+" : ""}{formatNumber(change.delta)}
                      </span>
                      <span className="text-muted-foreground"> ({formatNumber(change.previous)} → {formatNumber(change.next)})</span>
                    </p>
                  ))}
                  <p className="text-body text-muted-foreground">
                    {formatDateTime(toDate(movement.createdAt), { dateStyle: "medium", timeStyle: "short" })}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 pt-3">
        <span className="text-body text-muted-foreground">{t("historyPage", { page: cursors.length })}</span>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={cursors.length <= 1 || query.isFetching}
            onClick={() => setCursors((history) => history.slice(0, -1))}
          >
            {r("previous")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!nextCursor || query.isFetching}
            onClick={() => nextCursor && setCursors((history) => history.at(-1) === nextCursor ? history : [...history, nextCursor])}
          >
            {r("next")}
          </Button>
        </div>
      </div>
    </div>
  );
}
