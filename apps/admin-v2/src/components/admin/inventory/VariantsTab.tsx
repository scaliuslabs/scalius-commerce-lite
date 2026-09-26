import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { SelectionSheet } from "~/components/admin/shared/SelectionSheet";
import { Link } from "@tanstack/react-router";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef, Row } from "~/components/admin/data-table/table-config";
import { DataTable } from "~/components/admin/data-table/DataTable";
import { IdText, NameText } from "~/components/admin/data-table/cells";
import { sortHeader } from "~/components/admin/resource/columns";
import { DataTableToolbar } from "~/components/admin/data-table/DataTableToolbar";
import { useServerTable } from "~/components/admin/data-table/useServerTable";
import { createSelectColumn } from "~/components/admin/data-table/columns/column-factories";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { useCatalogActionPermissions } from "~/hooks/use-catalog-action-permissions";
import { useIsMobile } from "~/hooks/use-mobile";
import { cn } from "@scalius/shared/utils";
import { inventoryQueryOptions, type InventoryVariant } from "~/lib/api-query-options/inventory";
import { createDataSelector } from "~/lib/list-helpers";
import { queryKeys } from "~/lib/query-keys";
import { formatNumber, useMessages } from "~/i18n";
import { inventoryMessages } from "~/i18n/inventory";
import { resourceMessages } from "~/i18n/resource";
import { AdjustStockDialog } from "./AdjustStockDialog";
import {
  STOCK_FILTERS,
  variantsQuery,
  type InventoryFilters,
  type InventoryFiltersChange,
  type StockFilter,
  type VariantSort,
} from "./inventory-search";

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
        <button type="button" className="shrink-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <Badge variant={status.badge}>{t(status.key)}</Badge>
        </button>
      </TooltipTrigger>
      <TooltipContent>{t(STATUS_HELP[status.key])}</TooltipContent>
    </Tooltip>
  );
}

export function VariantName({ productId, productName, optionLabel }: {
  productId: string;
  productName: string | null;
  optionLabel: string | null;
}) {
  const t = useMessages(inventoryMessages);
  // The product on at most two lines, its option values muted on one (the whole value on hover).
  return (
    <NameText
      name={(
        <Link to="/admin/products/$productId/edit" params={{ productId }} className="hover:underline">
          {productName ?? t("unknownProduct")}
        </Link>
      )}
      detail={optionLabel ? <span title={optionLabel}>{optionLabel}</span> : null}
    />
  );
}

interface VariantsTabProps {
  filters: Pick<InventoryFilters, "q" | "stock">;
  onFiltersChange: InventoryFiltersChange;
  onSelectionChange: (variantIds: string[]) => void;
}

export function VariantsTab({ filters, onFiltersChange, onSelectionChange }: VariantsTabProps) {
  const t = useMessages(inventoryMessages);
  const r = useMessages(resourceMessages);
  const queryClient = useQueryClient();
  const { inventory: permissions } = useCatalogActionPermissions();
  const isMobile = useIsMobile();
  const { q: search, stock: status } = filters;
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(50);
  const [sort, setSort] = useState<VariantSort>({ field: "available", order: "asc" });
  // Any filter or search change (typed, cleared or from another tab) starts at page 1.
  useEffect(() => setPage(1), [search, status]);
  // The last chosen variant stays set while the dialog closes, so its content never jumps.
  const [adjusting, setAdjusting] = useState<InventoryVariant | null>(null);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [adjustSession, setAdjustSession] = useState(0);
  const listQuery = inventoryQueryOptions(variantsQuery(filters, page, limit, sort));
  // The same cached query the table reads; it also carries the store alert level.
  const storeLevel = useQuery({ ...listQuery, placeholderData: keepPreviousData }).data?.defaultLowStockThreshold ?? null;

  const canAdjustStock = permissions.canAdjustStock;
  const adjustButton = useCallback((variant: InventoryVariant) => canAdjustStock ? (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label={t("adjustFor", {
        name: [variant.productName ?? variant.sku, variant.optionLabel].filter(Boolean).join(" · "),
      })}
      onClick={() => {
        setAdjusting(variant);
        setAdjustSession((session) => session + 1);
        setAdjustOpen(true);
      }}
    >
      {t("adjust")}
    </Button>
  ) : null, [canAdjustStock, t]);

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
      id: "status",
      header: r("status"),
      meta: { priority: 90, minWidth: 120 },
      cell: ({ row }) => <StockBadge variant={row.original} storeLevel={storeLevel} />,
      enableSorting: false,
    },
    {
      id: "actions",
      cell: ({ row }) => adjustButton(row.original),
      enableSorting: false,
    },
  ], [adjustButton, r, storeLevel, t]);

  const { table, isFetching, isLoading, error, refetch, selectedIds, clearSelection } = useServerTable<InventoryVariant>({
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
    defaultPageSize: 50,
  });

  const selectionKey = selectedIds.join(",");
  useEffect(() => {
    onSelectionChange(selectionKey ? selectionKey.split(",") : []);
  }, [onSelectionChange, selectionKey]);

  const filtered = Boolean(search) || status !== "all";
  const clearFilters = () => onFiltersChange({ q: "", stock: "all" });
  // Phones keep bulk selection through a bottom action bar (desktop uses the page header button).
  const showSelectionBar = isMobile && selectedIds.length > 0;

  const mobileCard = (row: Row<InventoryVariant>) => {
    const variant = row.original;
    return (
      <div className="flex items-start gap-3 px-3 py-2">
        <span className="flex h-5 items-center">
          <Checkbox
            checked={row.getIsSelected()}
            onCheckedChange={(checked) => row.toggleSelected(checked === true)}
            aria-label={r("select", { name: variant.sku })}
          />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <VariantCell variant={variant} />
          <IdText value={variant.sku} copy className="text-muted-foreground" />
          <div className="flex min-w-0 items-center gap-2">
            <StockBadge variant={variant} storeLevel={storeLevel} />
            <AvailableBreakdown variant={variant} storeLevel={storeLevel}>{t("availableCount", { count: variant.available })}</AvailableBreakdown>
          </div>
        </div>
        <div className="self-center">{adjustButton(variant)}</div>
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
        pageSizeOptions={[20, 50, 100]}
        mobileCardRenderer={mobileCard}
        layoutKey="inventory-variants"
        defaultSortLabel={false}
        toolbar={<div className="px-2 pt-2"><DataTableToolbar
            searchValue={search}
            onSearchChange={(value) => onFiltersChange({ q: value })}
            searchPlaceholder={t("searchVariants")}
            filters={(
              <SearchableSelect
                triggerClassName="w-auto min-w-40"
                ariaLabel={t("stockFilter")}
                value={status}
                onValueChange={(value) => onFiltersChange({ stock: value as StockFilter })}
                options={STOCK_FILTERS.map((value) => ({ value, label: t(FILTER_LABEL[value]) }))}
              />
            )}
          /></div>}
        emptyState={filtered
          ? {
              title: r("noResults"),
              description: r("noResultsHint"),
              action: <Button type="button" variant="outline" onClick={clearFilters}>{t("clearFilters")}</Button>,
            }
          : {
              title: t("noVariants"),
              description: t("noVariantsHint"),
              action: (
                <Button asChild>
                  <Link to="/admin/products/new">{t("addProduct")}</Link>
                </Button>
              ),
            }}
      />
      <AdjustStockDialog
        key={adjustSession}
        variant={adjusting}
        storeLevel={storeLevel}
        open={adjustOpen && permissions.canAdjustStock}
        onClose={() => setAdjustOpen(false)}
        onSaved={() => void queryClient.invalidateQueries({ queryKey: queryKeys.inventory.all })}
      />
      <SelectionSheet count={showSelectionBar ? selectedIds.length : 0} clearLabel={t("clearSelection")} onClear={clearSelection}>
        <Button asChild>
          <Link to="/admin/inventory/labels" search={{ variants: selectedIds.join(",") }}>{t("printLabels")}</Link>
        </Button>
      </SelectionSheet>
    </div>
  );
}
