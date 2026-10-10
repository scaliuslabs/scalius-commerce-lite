import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { toast } from "~/lib/toast";
import { Calendar as CalendarIcon, Download } from "lucide-react";
import type { DateRange } from "react-day-picker";
import { DataTable } from "~/components/admin/data-table/DataTable";
import { DataTableToolbar } from "~/components/admin/data-table/DataTableToolbar";
import { FilterControl } from "~/components/admin/data-table/FilterControl";
import { ListDate } from "~/components/admin/data-table/ListDate";
import { serverTableFeatures, useTable, type ColumnDef } from "~/components/admin/data-table/table-config";
import { FilteredEmptyState } from "~/components/admin/states";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { inventoryQueryOptions, type InventoryMovement } from "~/lib/api-query-options/inventory";
import { hasSeveralLocations, inventoryLocationsQueryOptions } from "~/lib/api-query-options/inventory-locations";
import { adminCalendarDateKey } from "~/lib/admin-time";
import { withDashboardBasePath } from "~/lib/dashboard-base-path";
import { formatDateOnly, parseDateOnly } from "~/lib/date-only";
import { cn } from "@scalius/shared/utils";
import { IdText } from "~/components/admin/data-table/cells";
import { formatDateTime, formatNumber, useMessages } from "~/i18n";
import { inventoryMessages } from "~/i18n/inventory";
import { toDate } from "./AlertsTab";
import { describeMovementNote } from "./movement-note";
import { formatOrderNumber } from "@scalius/shared/order-utils";
import {
  MOVEMENT_PAGE_SIZE,
  MOVEMENT_TYPES,
  movementsQuery,
  type InventoryFilters,
  type InventoryFiltersChange,
  type MovementFilter,
  type MovementType,
} from "./inventory-search";


type CounterChange = {
  label: "counterStock" | "onHand" | "committed" | "counterPreorder" | "onHandAtLocation" | "onHandAllLocations" | "committedAllLocations";
  location?: string;
  /** Before and after; unknown for a location the movement didn't record. */
  previous: number | null;
  next: number | null;
  /** Null on the store-wide line beside a location's change (the change is said once). */
  delta: number | null;
};

/**
 * The counts a movement changed, each naming its scope. With several
 * locations, on-hand moves at a location: that location's change (with its
 * before and after when the operation recorded them) comes first, then the
 * store total across all locations, labelled so. Committed stock is always
 * store-wide.
 */
export function counterChanges(movement: InventoryMovement, severalLocations = false): CounterChange[] {
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
    if (severalLocations && movement.locationName) {
      changes.push({
        label: "onHandAtLocation",
        location: movement.locationName,
        previous: movement.locationPreviousStock ?? null,
        next: movement.locationNewStock ?? null,
        delta: movement.stockDelta,
      });
      changes.push({ label: "onHandAllLocations", previous: movement.previousStock, next: movement.newStock, delta: null });
    } else {
      changes.push({ label: "onHand", previous: movement.previousStock, next: movement.newStock, delta: movement.stockDelta });
    }
  }
  if (movement.reservedStockDelta && movement.previousReservedStock != null && movement.newReservedStock != null) {
    changes.push({
      label: severalLocations ? "committedAllLocations" : "committed",
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

/** Who did it, why, and on which document; where stock moved is on the change line. */
function MovementDetails({ movement }: { movement: InventoryMovement }) {
  const t = useMessages(inventoryMessages);
  const { labels, note, document, keys } = describeMovementNote(movement);
  const parts = [
    movement.actorType === "system" ? t("automatic") : t("byName", { name: movement.actorName }),
    ...labels.map((label) => t(label)),
    ...(document ? [t(document.label, { number: document.number })] : []),
    ...(keys ? [t(keys.label, { count: keys.count })] : []),
  ];
  const whole = [...parts, ...(note ? [`“${note}”`] : [])].join(" · ");
  return (
    <p title={whole} className="truncate text-body text-muted-foreground">
      {parts.join(" · ")}
      {movement.orderId ? (
        <>
          {" · "}
          <Link to="/admin/orders/$orderId" params={{ orderId: movement.orderId }} className="hover:underline">
            {t("order", { number: formatOrderNumber(movement.orderNumber, movement.orderId) })}
          </Link>
        </>
      ) : null}
      {note ? ` · “${note}”` : null}
    </p>
  );
}

interface HistoryTabProps {
  filters: Pick<InventoryFilters, "q" | "type" | "from" | "to" | "location">;
  onFiltersChange: InventoryFiltersChange;
}

const ALL_LOCATIONS = "all";

const DateRangePickerWithPresets = lazy(() =>
  import("~/components/admin/order-list/DateRangePickerWithPresets").then((module) => ({
    default: module.DateRangePickerWithPresets,
  })),
);

/** The same date range picker as Orders (presets, one calendar), loaded on first use. */
function HistoryDateFilter({ from, to, onChange }: {
  from: string;
  to: string;
  onChange: InventoryFiltersChange;
}) {
  const t = useMessages(inventoryMessages);
  const [loadPicker, setLoadPicker] = useState(false);
  const range: DateRange | undefined = from || to ? { from: parseDateOnly(from), to: parseDateOnly(to) } : undefined;
  const format = (date: Date) => formatDateTime(date, { dateStyle: "medium", timeZone: undefined });
  const label = !range?.from ? t("anyDate") : range.to ? `${format(range.from)} – ${format(range.to)}` : format(range.from);
  const trigger = (
    <Button id="inventory-history-date" type="button" variant="outline" className="w-full justify-start" aria-label={t("dateRangeLabel", { range: label })} onClick={() => setLoadPicker(true)}>
      <CalendarIcon className="h-4 w-4" />
      <span className="truncate" title={label}>{label}</span>
    </Button>
  );
  if (!loadPicker) return trigger;
  return (
    <Suspense fallback={trigger}>
      <DateRangePickerWithPresets
        date={range}
        setDate={(next) => onChange({ from: formatDateOnly(next?.from) ?? "", to: formatDateOnly(next?.to ?? next?.from) ?? "" })}
        trigger={trigger}
      />
    </Suspense>
  );
}

export function HistoryTab({ filters, onFiltersChange }: HistoryTabProps) {
  const t = useMessages(inventoryMessages);
  const { q: search, type, from: startDate, to: endDate } = filters;
  // Where stock moved shows (and filters) only once a store has more than one location.
  const { data: locations } = useQuery(inventoryLocationsQueryOptions(true));
  const severalLocations = hasSeveralLocations(locations);
  const locationId = severalLocations && locations?.some((location) => location.id === filters.location)
    ? filters.location
    : "";
  const [cursors, setCursors] = useState<string[]>([""]);
  const [exporting, setExporting] = useState(false);
  // Any filter or search change goes back to the first page.
  useEffect(() => setCursors([""]), [search, type, startDate, endDate, locationId]);

  const query = useQuery({
    ...inventoryQueryOptions(movementsQuery({ ...filters, location: locationId }, cursors.at(-1))),
    placeholderData: keepPreviousData,
  });
  const movements = query.data?.movements ?? [];
  const pageInfo = query.data?.pageInfo;
  const nextCursor = pageInfo?.hasMore ? pageInfo.nextCursor : null;
  const filtered = Boolean(search || startDate || endDate || type !== "all" || locationId);
  const filterCount = [type !== "all", Boolean(startDate || endDate), Boolean(locationId)].filter(Boolean).length;

  const columns = useMemo<ColumnDef<InventoryMovement, unknown>[]>(() => [
    {
      id: "product",
      header: t("product"),
      meta: { primary: true, minWidth: 240, maxWidth: 420 },
      cell: ({ row }) => {
        const movement = row.original;
        const name = `${movement.productName ?? t("unknownProduct")}${movement.optionLabel ? ` · ${movement.optionLabel}` : ""}`;
        return (
          <span className="block min-w-0">
            <span title={name} className="block truncate font-medium">{name}</span>
            <MovementDetails movement={movement} />
          </span>
        );
      },
    },
    {
      id: "type",
      header: t("changeType"),
      meta: { priority: 70, minWidth: 140 },
      cell: ({ row }) => (
        <Badge variant="outline">
          {MOVEMENT_TYPES.includes(row.original.type as MovementType)
            ? t(`type_${row.original.type as MovementType}`)
            : t("typeOther")}
        </Badge>
      ),
    },
    {
      id: "sku",
      header: t("sku"),
      meta: { priority: 40, minWidth: 120 },
      // A SKU without a code (removed long ago) shows no code, never part of its internal id.
      cell: ({ row }) => <IdText value={row.original.variantSku} copy />,
    },
    {
      id: "change",
      header: t("columnChange"),
      meta: { numeric: true, priority: 90, minWidth: 120 },
      cell: ({ row }) => {
        const changes = counterChanges(row.original, severalLocations);
        const main = changes.find((change) => change.delta !== null) ?? changes[0]!;
        const describe = (change: CounterChange) => [
          t(change.label, { location: change.location ?? "" }),
          change.delta !== null ? `${change.delta > 0 ? "+" : ""}${formatNumber(change.delta)}` : null,
          change.previous !== null && change.next !== null ? `${formatNumber(change.previous)} → ${formatNumber(change.next)}` : null,
        ].filter(Boolean).join(" ");
        return (
          <span className="block" title={changes.map(describe).join("\n")}>
            {main.delta !== null ? (
              <span className={cn("block font-medium", main.delta < 0 && "text-destructive")}>
                {main.delta > 0 ? "+" : ""}{formatNumber(main.delta)}
              </span>
            ) : null}
            {main.previous !== null && main.next !== null ? (
              <span className="block text-muted-foreground">{formatNumber(main.previous)} → {formatNumber(main.next)}</span>
            ) : null}
          </span>
        );
      },
    },
    {
      id: "date",
      header: t("date"),
      meta: { keep: true, minWidth: 150 },
      cell: ({ row }) => <ListDate value={toDate(row.original.createdAt)} />,
    },
  ], [severalLocations, t]);

  const table = useTable({
    features: serverTableFeatures,
    data: movements,
    columns,
    getRowId: (row) => row.id,
    manualPagination: true,
    manualSorting: true,
    rowCount: -1,
    state: { pagination: { pageIndex: cursors.length - 1, pageSize: MOVEMENT_PAGE_SIZE }, sorting: [] },
  });

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
          movementLocationId: locationId || undefined,
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
    <DataTable
      variant="bare"
      table={table}
      isLoading={query.isPending}
      isFetching={query.isFetching}
      error={query.isError ? query.error : undefined}
      onRetry={() => void query.refetch()}
      what={t("whatHistory")}
      defaultSortLabel={false}
      layoutKey="inventory-history"
      getRowHref={(movement) => (typeof movement.productId === "string" && movement.productId ? `/admin/products/${movement.productId}/edit` : undefined)}
      pageSizeOptions={[MOVEMENT_PAGE_SIZE]}
      cursorPaging={{
        total: null,
        offset: (cursors.length - 1) * MOVEMENT_PAGE_SIZE,
        pageInfo: {
          hasNextPage: Boolean(nextCursor),
          hasPreviousPage: cursors.length > 1,
          startCursor: cursors.length > 1 ? cursors.at(-1)! : null,
          endCursor: nextCursor,
        },
        onPrevious: () => setCursors((history) => history.slice(0, -1)),
        onNext: (cursor) => setCursors((history) => (history.at(-1) === cursor ? history : [...history, cursor])),
      }}
      toolbar={(
        <DataTableToolbar
          searchValue={search}
          onSearchChange={(value) => onFiltersChange({ q: value })}
          searchPlaceholder={t("searchProducts")}
          filterCount={filterCount}
          onClearFilters={() => onFiltersChange({ type: "all", from: "", to: "", location: "" })}
          filters={(
            <>
              <FilterControl label={t("changeType")}>
                <SearchableSelect
                  ariaLabel={t("changeType")}
                  value={type}
                  onValueChange={(value) => onFiltersChange({ type: value as MovementFilter })}
                  options={[{ value: "all", label: t("typeAll") }, ...MOVEMENT_TYPES.map((value) => ({ value, label: t(`type_${value}`) }))]}
                />
              </FilterControl>
              <div className="flex min-w-0 flex-col gap-1">
                <label htmlFor="inventory-history-date" className="text-body font-medium">{t("date")}</label>
                <HistoryDateFilter from={startDate} to={endDate} onChange={onFiltersChange} />
              </div>
              {severalLocations ? (
                <FilterControl label={t("location")}>
                  <SearchableSelect
                    ariaLabel={t("location")}
                    value={locationId || ALL_LOCATIONS}
                    onValueChange={(value) => onFiltersChange({ location: value === ALL_LOCATIONS ? "" : value })}
                    options={[
                      { value: ALL_LOCATIONS, label: t("allLocations") },
                      // Archived locations keep their history.
                      ...(locations ?? []).map((location) => ({
                        value: location.id,
                        label: location.status === "archived" ? t("locationArchived", { name: location.name }) : location.name,
                      })),
                    ]}
                  />
                </FilterControl>
              ) : null}
            </>
          )}
          extra={(
            <Button type="button" variant="outline" loading={exporting} onClick={() => void exportCsv()}>
              <Download />
              {t("export")}
            </Button>
          )}
        />
      )}
      emptyState={filtered ? (
        <FilteredEmptyState onClearFilters={() => onFiltersChange({ q: "", type: "all", from: "", to: "", location: "" })} />
      ) : (
        <FilteredEmptyState title={t("noHistory")} description={t("noHistoryHint")} />
      )}
    />
  );
}
