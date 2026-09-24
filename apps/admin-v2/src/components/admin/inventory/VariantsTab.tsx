import { useEffect, useState, type ReactNode } from "react";
import { SelectionSheet } from "~/components/admin/shared/SelectionSheet";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { ColumnDef, Row } from "~/components/admin/data-table/table-config";
import { DataTable } from "~/components/admin/data-table/DataTable";
import { DataTableColumnHeader } from "~/components/admin/data-table/DataTableColumnHeader";
import { DataTableToolbar } from "~/components/admin/data-table/DataTableToolbar";
import { useServerTable } from "~/components/admin/data-table/useServerTable";
import { createSelectColumn } from "~/components/admin/data-table/columns/column-factories";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
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

/** The one stock-status mapping: label key + Badge variant. */
export function stockStatus(variant: Pick<InventoryVariant, "available" | "lowStockThreshold">) {
  if (variant.available <= 0) return { key: "soldOut", badge: "destructive" } as const;
  if (variant.lowStockThreshold && variant.available <= variant.lowStockThreshold) {
    return { key: "lowStock", badge: "warning" } as const;
  }
  return { key: "inStock", badge: "success" } as const;
}

function VariantCell({ variant }: { variant: InventoryVariant }) {
  return <VariantName productId={variant.productId} productName={variant.productName} optionLabel={variant.optionLabel} />;
}

/** The Available number opens its breakdown (on hand, committed) by click, tap or keyboard. */
function AvailableBreakdown({ variant, children }: { variant: InventoryVariant; children: ReactNode }) {
  const t = useMessages(inventoryMessages);
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
            {variant.lowStockThreshold === null ? t("alertOff") : formatNumber(variant.lowStockThreshold)}
          </span>
        </p>
      </PopoverContent>
    </Popover>
  );
}

function StockBadge({ variant }: { variant: InventoryVariant }) {
  const t = useMessages(inventoryMessages);
  const status = stockStatus(variant);
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
  return (
    <Link
      to="/admin/products/$productId/edit"
      params={{ productId }}
      className="flex min-w-0 gap-1 text-body font-medium hover:underline"
    >
      <span className="truncate">{productName ?? t("unknownProduct")}</span>
      {optionLabel ? (
        // The variant keeps its full width (up to half the row); only the product name is shortened.
        <span className="max-w-1/2 shrink-0 truncate font-normal text-muted-foreground">· {optionLabel}</span>
      ) : null}
    </Link>
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

  const adjustButton = (variant: InventoryVariant) => permissions.canAdjustStock ? (
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
  ) : null;

  const columns: ColumnDef<InventoryVariant, unknown>[] = [
    createSelectColumn<InventoryVariant>({ getLabel: (row) => (row as InventoryVariant).sku }),
    {
      accessorKey: "productName",
      header: ({ column }) => <DataTableColumnHeader column={column} title={t("product")} />,
      cell: ({ row }) => <VariantCell variant={row.original} />,
    },
    {
      accessorKey: "sku",
      header: ({ column }) => <DataTableColumnHeader column={column} title={t("sku")} />,
      cell: ({ row }) => <span className="font-mono text-body text-muted-foreground">{row.original.sku}</span>,
    },
    {
      // "Available" is the one stock number; on hand and committed live in its breakdown.
      accessorKey: "available",
      header: ({ column }) => (
        <div className="flex justify-end">
          <DataTableColumnHeader column={column} title={t("available")} />
        </div>
      ),
      cell: ({ row }) => (
        <div className="flex justify-end">
          <AvailableBreakdown variant={row.original}>{formatNumber(row.original.available)}</AvailableBreakdown>
        </div>
      ),
    },
    {
      id: "status",
      header: () => r("status"),
      cell: ({ row }) => <StockBadge variant={row.original} />,
      enableSorting: false,
    },
    {
      id: "actions",
      cell: ({ row }) => <div className="text-right">{adjustButton(row.original)}</div>,
      enableSorting: false,
    },
  ];

  const { table, isFetching, isLoading, error, refetch, selectedIds, clearSelection } = useServerTable<InventoryVariant>({
    columns,
    queryOptions: inventoryQueryOptions(variantsQuery(filters, page, limit, sort)),
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
      setSort({ field: field as VariantSort["field"], order });
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
          {/* The SKU is how stock is picked: shown whole, wrapping if it must. */}
          <p className="break-all font-mono text-body text-muted-foreground">{variant.sku}</p>
          <div className="flex min-w-0 items-center gap-2">
            <StockBadge variant={variant} />
            <AvailableBreakdown variant={variant}>{t("availableCount", { count: variant.available })}</AvailableBreakdown>
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
        toolbar={<div className="px-2 pt-2"><DataTableToolbar
            searchValue={search}
            onSearchChange={(value) => onFiltersChange({ q: value })}
            searchPlaceholder={t("searchVariants")}
            filters={(
              <Select
                value={status}
                onValueChange={(value) => onFiltersChange({ stock: value as StockFilter })}
              >
                <SelectTrigger className="w-auto min-w-40" aria-label={t("stockFilter")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STOCK_FILTERS.map((value) => (
                    <SelectItem key={value} value={value}>{t(FILTER_LABEL[value])}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
