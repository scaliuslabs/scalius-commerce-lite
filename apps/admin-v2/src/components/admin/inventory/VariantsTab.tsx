import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { RowLink } from "~/components/admin/data-table/RowLink";
import { FilterControl } from "~/components/admin/data-table/FilterControl";
import { FilteredEmptyState } from "~/components/admin/states";
import { Link } from "@tanstack/react-router";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef, Row } from "~/components/admin/data-table/table-config";
import { DataTable } from "~/components/admin/data-table/DataTable";
import { DataTableRowActions } from "~/components/admin/data-table/DataTableRowActions";
import { IdText } from "~/components/admin/data-table/cells";
import { sortHeader } from "~/components/admin/resource/columns";
import { DataTableToolbar, IndexBulkBar } from "~/components/admin/data-table/DataTableToolbar";
import { useServerTable } from "~/components/admin/data-table/useServerTable";
import { CheckboxHitArea, createSelectColumn } from "~/components/admin/data-table/columns/column-factories";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { useCatalogActionPermissions } from "~/hooks/use-catalog-action-permissions";
import { useCurrency } from "~/hooks/use-currency";
import { cn } from "@scalius/shared/utils";
import { inventoryQueryOptions, type InventoryVariant } from "~/lib/api-query-options/inventory";
import {
  hasSeveralLocations,
  inventoryLocationKeys,
  inventoryLocationsQueryOptions,
  variantInventoryLevelsQueryOptions,
} from "~/lib/api-query-options/inventory-locations";
import { DEFAULT_PAGE_SIZE, createDataSelector, readSavedPageSize } from "~/lib/list-helpers";
import { queryKeys } from "~/lib/query-keys";
import { formatNumber, useMessages } from "~/i18n";
import { inventoryMessages } from "~/i18n/inventory";
import { resourceMessages } from "~/i18n/resource";
import {
  STOCK_FILTERS,
  variantsQuery,
  type InventoryFilters,
  type InventoryFiltersChange,
  type StockFilter,
  type VariantSort,
} from "./inventory-search";

// The adjust and bulk cost dialogs load on the first Adjust or Edit cost, then stay mounted.
const AdjustStockDialog = lazy(() => import("./AdjustStockDialog").then((module) => ({ default: module.AdjustStockDialog })));
const BulkCostDialog = lazy(() => import("./BulkCostDialog").then((module) => ({ default: module.BulkCostDialog })));

const FILTER_LABEL = { all: "filterAll", low: "filterLow", out: "filterOut", reserved: "filterReserved" } as const;
const STATUS_HELP = { inStock: "inStockHelp", lowStock: "lowStockHelp", soldOut: "soldOutHelp" } as const;

const selectVariants = createDataSelector<InventoryVariant>("variants");

/**
 * The one stock-status mapping: label key + Badge variant. The alert level is
 * the variant's own, else the store level (0 turns it off).
 */
export function stockStatus(variant: Pick<InventoryVariant, "available" | "lowStockThreshold">, storeLevel: number | null) {
  const level = variant.lowStockThreshold ?? storeLevel;
  if (variant.available <= 0) return { key: "soldOut", badge: "destructive" } as const;
  if (level && variant.available <= level) return { key: "lowStock", badge: "warning" } as const;
  return { key: "inStock", badge: "success" } as const;
}

function VariantCell({ variant }: { variant: InventoryVariant }) {
  return <VariantName productId={variant.productId} productName={variant.productName} optionLabel={variant.optionLabel} />;
}

/** The Available number opens its breakdown (on hand, committed) by click, tap or keyboard. */
function AvailableBreakdown({ variant, storeLevel, children }: {
  variant: InventoryVariant;
  storeLevel: number | null;
  children: ReactNode;
}) {
  const t = useMessages(inventoryMessages);
  const ownLevel = variant.lowStockThreshold;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="-my-3"
          aria-label={t("availableBreakdown", { count: variant.available })}
        >
          {children}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64">
        <dl className="space-y-2 text-body">
          {([
            ["onHand", variant.stock],
            ["committed", variant.reservedStock],
            ["available", variant.available],
          ] as const).map(([key, value]) => (
            <div key={key} className={cn("flex justify-between gap-4", key === "available" && "border-t pt-2")}>
              <dt className="text-muted-foreground">{t(key)}</dt>
              <dd className="font-medium tabular-nums">{formatNumber(value)}</dd>
            </div>
          ))}
        </dl>
        <p className="pt-3 text-body text-muted-foreground">{t("availableHelp")}</p>
        <p className="flex justify-between gap-4 border-t pt-2 mt-3 text-body">
          <span className="text-muted-foreground">{t("alertLevelShort")}</span>
          <span className="font-medium tabular-nums">
            {ownLevel === null
              ? storeLevel ? t("alertStoreLevel", { level: storeLevel }) : t("alertOff")
              : ownLevel === 0 ? t("alertOff") : formatNumber(ownLevel)}
          </span>
        </p>
      </PopoverContent>
    </Popover>
  );
}

function StockBadge({ variant, storeLevel }: { variant: InventoryVariant; storeLevel: number | null }) {
  const t = useMessages(inventoryMessages);
  const status = stockStatus(variant, storeLevel);
  // A focusable trigger so the one-line definition also opens from the keyboard.
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className="-my-3 inline-flex min-h-11 min-w-6 shrink-0 items-center rounded-md sm:min-h-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <Badge variant={status.badge}>{t(status.key)}</Badge>
        </button>
      </TooltipTrigger>
      <TooltipContent>{t(STATUS_HELP[status.key])}</TooltipContent>
    </Tooltip>
  );
}

/** Units on their way (open purchase orders, transfers in transit): not on hand, not for sale. */
function IncomingCell({ units }: { units: number }) {
  return <span className={cn("tabular-nums", units === 0 && "text-muted-foreground")}>{formatNumber(units)}</span>;
}

/** The SKU's unit cost, or a dash (named for screen readers) without one. */
function CostCell({ cost }: { cost: number | null }) {
  const t = useMessages(inventoryMessages);
  const { fmt } = useCurrency();
  if (cost === null) {
    return (
      <span className="text-muted-foreground">
        <span aria-hidden="true">—</span>
        <span className="sr-only">{t("noCost")}</span>
      </span>
    );
  }
  return <span className="tabular-nums">{fmt(cost)}</span>;
}

export function VariantName({ productId, productName, optionLabel }: {
  productId: string;
  productName: string | null;
  optionLabel: string | null;
}) {
  const t = useMessages(inventoryMessages);
  // The product and its option values each use one line, with the whole value on hover.
  return (
    <span className="block min-w-0">
      {/* One text line, not the table rule's 44px phone link: the whole phone card already opens the product. */}
      <RowLink to={`/admin/products/${productId}/edit`} title={productName ?? t("unknownProduct")} className="block min-h-0 truncate font-medium hover:underline">
        {productName ?? t("unknownProduct")}
      </RowLink>
      <span title={optionLabel ?? undefined} className="block h-lh truncate text-muted-foreground">{optionLabel}</span>
    </span>
  );
}

const ALL_LOCATIONS = "all";

interface VariantsTabProps {
  filters: Pick<InventoryFilters, "q" | "stock" | "location">;
  onFiltersChange: InventoryFiltersChange;
  onSelectionChange: (variantIds: string[]) => void;
}

export function VariantsTab({ filters, onFiltersChange, onSelectionChange }: VariantsTabProps) {
  const t = useMessages(inventoryMessages);
  const r = useMessages(resourceMessages);
  const queryClient = useQueryClient();
  const { inventory: permissions } = useCatalogActionPermissions();
  const { fmt } = useCurrency();
  const { q: search, stock: status } = filters;
  // Locations show only once a store has more than one.
  const { data: locations } = useQuery(inventoryLocationsQueryOptions());
  const severalLocations = hasSeveralLocations(locations);
  const activeLocations = useMemo(() => locations?.filter((location) => location.status === "active") ?? [], [locations]);
  const filterLocation = severalLocations
    ? activeLocations.find((location) => location.id === filters.location) ?? null
    : null;
  const locationId = filterLocation?.id ?? "";
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(() => readSavedPageSize("inventory-variants") ?? DEFAULT_PAGE_SIZE);
  const [sort, setSort] = useState<VariantSort>({ field: "available", order: "asc" });
  // Any filter or search change (typed, cleared or from another tab) starts at page 1.
  useEffect(() => setPage(1), [search, status, locationId]);
  // The last chosen variant stays set while the dialog closes, so its content never jumps.
  const [adjusting, setAdjusting] = useState<InventoryVariant | null>(null);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [adjustSession, setAdjustSession] = useState(0);
  const adjustOpener = useRef<HTMLElement | null>(null);
  // Bulk cost edit of the selected SKUs (products.edit plus "View product costs").
  const [costOpen, setCostOpen] = useState(false);
  const [costSession, setCostSession] = useState(0);
  const listQuery = inventoryQueryOptions(variantsQuery({ ...filters, location: locationId }, page, limit, sort));
  // The variant's per-location on-hand, for the dialog's location select.
  const levels = useQuery({
    ...variantInventoryLevelsQueryOptions(adjusting?.id ?? ""),
    enabled: severalLocations && adjustOpen && adjusting !== null,
  }).data;
  // The same cached query the table reads; it also carries the store alert level.
  const storeLevel = useQuery({ ...listQuery, placeholderData: keepPreviousData }).data?.defaultLowStockThreshold ?? null;

  const canAdjustStock = permissions.canAdjustStock;
  const showCosts = permissions.canViewCosts;
  const adjustActions = useCallback((variant: InventoryVariant) => canAdjustStock ? (
    <DataTableRowActions
      menuLabel={r("actionsFor", {
        name: [variant.productName ?? variant.sku, variant.optionLabel].filter(Boolean).join(" · "),
      })}
      extraActions={[{
        label: t("adjust"),
        onClick: (opener) => {
          adjustOpener.current = opener ?? null;
          setAdjusting(variant);
          setAdjustSession((session) => session + 1);
          setAdjustOpen(true);
        },
      }]}
    />
  ) : null, [canAdjustStock, r, t]);

  // Stable columns keep TanStack's cells, so rows re-render only when their variant changes.
  const columns = useMemo<ColumnDef<InventoryVariant, unknown>[]>(() => [
    createSelectColumn<InventoryVariant>({ getLabel: (row) => (row as InventoryVariant).sku }),
    {
      accessorKey: "productName",
      header: sortHeader(t("product")),
      meta: { primary: true, minWidth: 220 },
      cell: ({ row }) => <VariantCell variant={row.original} />,
    },
    {
      accessorKey: "sku",
      header: sortHeader(t("sku")),
      // Stock is picked by SKU: it outlasts the status badge when space runs out.
      meta: { priority: 92, minWidth: 150 },
      cell: ({ row }) => <IdText value={row.original.sku} copy className="text-muted-foreground" />,
    },
    ...(filterLocation ? [{
      // With a location filter, that location's on-hand sits beside the SKU's availability.
      id: "locationOnHand",
      accessorKey: "locationOnHand",
      header: t("onHandAt", { location: filterLocation.name }),
      meta: { numeric: true, priority: 93, minWidth: 110 },
      cell: ({ row }) => (
        <span className="tabular-nums">{formatNumber(row.original.locationOnHand ?? 0)}</span>
      ),
      enableSorting: false,
    } satisfies ColumnDef<InventoryVariant, unknown>] : []),
    {
      // "Available" is the one stock number; on hand and committed live in its breakdown.
      accessorKey: "available",
      header: sortHeader(t("available")),
      meta: { numeric: true, priority: 95, minWidth: 100 },
      cell: ({ row }) => (
        <AvailableBreakdown variant={row.original} storeLevel={storeLevel}>{formatNumber(row.original.available)}</AvailableBreakdown>
      ),
    },
    {
      // Open purchase orders and transfers on their way (to the location filter, if any).
      accessorKey: "incoming",
      header: t("incoming"),
      meta: { numeric: true, priority: 80, minWidth: 100 },
      cell: ({ row }) => <IncomingCell units={row.original.incoming ?? 0} />,
      enableSorting: false,
    },
    // What each unit cost: only with "View product costs" (the API leaves it out otherwise).
    ...(showCosts ? [{
      accessorKey: "cost",
      header: t("cost"),
      meta: { numeric: true, priority: 75, minWidth: 110 },
      cell: ({ row }) => <CostCell cost={row.original.cost ?? null} />,
      enableSorting: false,
    } satisfies ColumnDef<InventoryVariant, unknown>] : []),
    {
      id: "status",
      header: r("status"),
      meta: { priority: 90, minWidth: 120 },
      cell: ({ row }) => <StockBadge variant={row.original} storeLevel={storeLevel} />,
      enableSorting: false,
    },
    {
      id: "actions",
      cell: ({ row }) => adjustActions(row.original),
      enableSorting: false,
    },
  ], [adjustActions, filterLocation, r, showCosts, storeLevel, t]);

  const { table, isFetching, isLoading, error, refetch, selectedIds, selectedRows, clearSelection } = useServerTable<InventoryVariant>({
    columns,
    queryOptions: listQuery,
    dataSelector: selectVariants,
    currentPage: page,
    currentLimit: limit,
    currentSort: sort.field,
    currentOrder: sort.order,
    onPaginationChange: (nextPage, nextLimit) => {
      setPage(nextPage);
      setLimit(nextLimit);
    },
    onSortingChange: (field, order) => {
      setSort(field ? { field: field as VariantSort["field"], order: order ?? "asc" } : { field: "available", order: "asc" });
      setPage(1);
    },
  });

  const selectionKey = selectedIds.join(",");
  useEffect(() => {
    onSelectionChange(selectionKey ? selectionKey.split(",") : []);
  }, [onSelectionChange, selectionKey]);

  const filtered = Boolean(search) || status !== "all";
  const clearFilters = () => onFiltersChange({ q: "", stock: "all" });
  const canEditCosts = permissions.canEditCosts;
  const openCostEdit = () => {
    setCostSession((session) => session + 1);
    setCostOpen(true);
  };

  const mobileCard = (row: Row<InventoryVariant>) => {
    const variant = row.original;
    return (
      <div className="flex items-start gap-3 px-3 py-2">
        <span className="flex h-lh items-center">
          <CheckboxHitArea>
            <Checkbox
              checked={row.getIsSelected()}
              onCheckedChange={(checked) => row.toggleSelected(checked === true)}
              aria-label={r("select", { name: variant.sku })}
            />
          </CheckboxHitArea>
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <VariantCell variant={variant} />
          <IdText value={variant.sku} copy className="text-muted-foreground" />
          <div className="flex min-w-0 items-center gap-2">
            <StockBadge variant={variant} storeLevel={storeLevel} />
            <AvailableBreakdown variant={variant} storeLevel={storeLevel}>{t("availableCount", { count: variant.available })}</AvailableBreakdown>
          </div>
          {filterLocation ? (
            <p className="text-body text-muted-foreground tabular-nums">
              {t("onHandAtCount", { count: variant.locationOnHand ?? 0, location: filterLocation.name })}
            </p>
          ) : null}
          <p className="text-body text-muted-foreground tabular-nums">
            {[
              (variant.incoming ?? 0) > 0 ? t("incomingCount", { count: variant.incoming }) : null,
              !showCosts ? null : variant.cost == null ? t("noCost") : t("costValue", { amount: fmt(variant.cost) }),
            ].filter(Boolean).join(" · ")}
          </p>
        </div>
        <div className="self-center">{adjustActions(variant)}</div>
      </div>
    );
  };

  return (
    <div>
      <DataTable
        variant="bare"
        getRowHref={(variant) => `/admin/products/${variant.productId}/edit`}
        table={table}
        isFetching={isFetching}
        isLoading={isLoading}
        error={error}
        onRetry={() => void refetch()}
        itemLabel={t("variantsItem")}
        what={t("variantsItem")}
        mobileCardRenderer={mobileCard}
        layoutKey="inventory-variants"
        defaultSortLabel={false}
        toolbar={<DataTableToolbar
            bulkBar={selectedIds.length > 0 ? (
              <IndexBulkBar
                status={r("selected", { count: selectedIds.length })}
                onClear={clearSelection}
                actions={(
                  <>
                    {canEditCosts ? <Button type="button" variant="outline" onClick={openCostEdit}>{t("editCost")}</Button> : null}
                    <Button asChild variant="outline">
                      <Link to="/admin/inventory/labels" search={{ variants: selectedIds.join(",") }}>{t("printLabels")}</Link>
                    </Button>
                  </>
                )}
              />
            ) : undefined}
            searchValue={search}
            onSearchChange={(value) => onFiltersChange({ q: value })}
            searchPlaceholder={t("searchVariants")}
            filterCount={(status !== "all" ? 1 : 0) + (locationId ? 1 : 0)}
            onClearFilters={() => onFiltersChange({ stock: "all", location: "" })}
            filters={(
              <>
                <FilterControl label={t("stockFilter")}>
                  <SearchableSelect
                    ariaLabel={t("stockFilter")}
                    value={status}
                    onValueChange={(value) => onFiltersChange({ stock: value as StockFilter })}
                    options={STOCK_FILTERS.map((value) => ({ value, label: t(FILTER_LABEL[value]) }))}
                  />
                </FilterControl>
                {severalLocations ? (
                  <FilterControl label={t("location")}>
                    <SearchableSelect
                      ariaLabel={t("location")}
                      value={locationId || ALL_LOCATIONS}
                      onValueChange={(value) => onFiltersChange({ location: value === ALL_LOCATIONS ? "" : value })}
                      options={[
                        { value: ALL_LOCATIONS, label: t("allLocations") },
                        ...activeLocations.map((location) => ({ value: location.id, label: location.name })),
                      ]}
                    />
                  </FilterControl>
                ) : null}
              </>
            )}
          />}
        emptyState={filtered
          ? <FilteredEmptyState onClearFilters={clearFilters} />
          : (
            <FilteredEmptyState
              title={t("noVariants")}
              description={t("noVariantsHint")}
            />
          )}
      />
      {adjustSession > 0 ? (
        <Suspense fallback={null}>
          <AdjustStockDialog
            key={adjustSession}
            variant={adjusting}
            storeLevel={storeLevel}
            locations={activeLocations}
            levels={levels}
            initialLocationId={locationId || null}
            open={adjustOpen && permissions.canAdjustStock}
            onClose={() => setAdjustOpen(false)}
            onCloseAutoFocus={(event) => {
              if (adjustOpener.current?.isConnected) {
                event.preventDefault();
                adjustOpener.current.focus();
              }
            }}
            onSaved={() => void Promise.all([
              queryClient.invalidateQueries({ queryKey: queryKeys.inventory.all }),
              queryClient.invalidateQueries({ queryKey: inventoryLocationKeys.all }),
            ])}
          />
        </Suspense>
      ) : null}
      {costSession > 0 ? (
        <Suspense fallback={null}>
          <BulkCostDialog
            key={costSession}
            variants={selectedRows}
            open={costOpen && canEditCosts}
            onClose={() => setCostOpen(false)}
            onSaved={() => void queryClient.invalidateQueries({ queryKey: queryKeys.inventory.all })}
            onReload={async () => (await queryClient.fetchQuery({ ...listQuery, staleTime: 0 })).variants ?? []}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
