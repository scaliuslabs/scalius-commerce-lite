import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ClipboardList } from "lucide-react";
import type { ColumnDef } from "~/components/admin/data-table/table-config";
import { Button } from "~/components/ui/button";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { useCatalogActionPermissions } from "~/hooks/use-catalog-action-permissions";
import { useCurrency } from "~/hooks/use-currency";
import { useMessages } from "~/i18n";
import { purchasingMessages } from "~/i18n/purchasing";
import { hasSeveralLocations, inventoryLocationsQueryOptions } from "~/lib/api-query-options/inventory-locations";
import {
  purchaseOrdersQueryOptions,
  purchasingKeys,
  supplierQueryOptions,
  type PurchaseOrderSummary,
} from "~/lib/api-query-options/purchasing";
import { FilterControl } from "~/components/admin/data-table/FilterControl";
import { DocumentList } from "./DocumentList";
import { formatDay } from "./purchasing-format";
import { PURCHASE_ORDER_TABS, purchaseOrderListQuery, type PurchaseOrderTab } from "./purchasing-list-state";
import { PurchaseOrderStatusBadge } from "./purchasing-status";
import { loadActiveSuppliers } from "./SupplierPicker";

const TAB_LABEL = {
  all: "tabAll",
  draft: "tabDraft",
  open: "tabOrdered",
  received: "tabReceived",
  cancelled: "tabCancelled",
} as const;

/** Products › Purchase orders: newest first, by status, searchable, filterable by supplier. */
export function PurchaseOrderList({ tab, supplierId, onTabChange, onSupplierChange }: {
  tab: PurchaseOrderTab;
  supplierId?: string;
  onTabChange: (tab: PurchaseOrderTab) => void;
  onSupplierChange: (supplierId: string | undefined) => void;
}) {
  const t = useMessages(purchasingMessages);
  const { fmt } = useCurrency();
  const { inventory: { canDraftPurchaseOrders: canCreate, canViewCosts } } = useCatalogActionPermissions();
  const severalLocations = hasSeveralLocations(useQuery(inventoryLocationsQueryOptions()).data);
  // The chosen supplier's name, for a filter opened from a link.
  const supplier = useQuery({ ...supplierQueryOptions(supplierId ?? ""), enabled: Boolean(supplierId) }).data;

  const columns = useMemo<ColumnDef<PurchaseOrderSummary, unknown>[]>(() => [
    {
      id: "number",
      header: t("colPurchaseOrder"),
      meta: { primary: true, mobile: "primary", minWidth: 140 },
      cell: ({ row }) => (
        <Link
          to="/admin/inventory/purchase-orders/$purchaseOrderId"
          params={{ purchaseOrderId: row.original.id }}
          className="whitespace-nowrap font-mono font-medium hover:underline"
        >
          {row.original.displayNumber}
        </Link>
      ),
    },
    {
      id: "supplier",
      header: t("colSupplier"),
      meta: { mobile: "secondary", priority: 80, minWidth: 160 },
      cell: ({ row }) => row.original.supplier
        ? <span className="block truncate" title={row.original.supplier.name}>{row.original.supplier.name}</span>
        : <span className="text-muted-foreground">{t("noSupplier")}</span>,
    },
    ...(severalLocations ? [{
      id: "destination",
      header: t("colDestination"),
      meta: { priority: 40, minWidth: 140 },
      cell: ({ row }) => <span className="block truncate" title={row.original.destination.name}>{row.original.destination.name}</span>,
    } satisfies ColumnDef<PurchaseOrderSummary, unknown>] : []),
    {
      id: "status",
      header: t("colStatus"),
      meta: { mobile: "status", priority: 90, minWidth: 150 },
      cell: ({ row }) => <PurchaseOrderStatusBadge status={row.original.status} />,
    },
    {
      id: "received",
      header: t("colReceived"),
      meta: { numeric: true, priority: 70, minWidth: 110 },
      cell: ({ row }) => t("receivedOf", { received: row.original.receivedQuantity, total: row.original.quantity }),
    },
    {
      id: "expected",
      header: t("colExpected"),
      meta: { priority: 50, minWidth: 130 },
      cell: ({ row }) => <span className="whitespace-nowrap text-muted-foreground">{formatDay(row.original.expectedOn) ?? "—"}</span>,
    },
    // What it cost: only with "View product costs".
    ...(canViewCosts ? [{
      id: "total",
      header: t("colTotal"),
      meta: { numeric: true, mobile: "secondary", priority: 85, minWidth: 120 },
      cell: ({ row }) => fmt(row.original.total ?? 0),
    } satisfies ColumnDef<PurchaseOrderSummary, unknown>] : []),
  ], [canViewCosts, fmt, severalLocations, t]);

  const createButton = canCreate ? (
    <Button asChild>
      <Link to="/admin/inventory/purchase-orders/new">{t("createPurchaseOrder")}</Link>
    </Button>
  ) : null;

  return (
    <DocumentList<PurchaseOrderSummary, PurchaseOrderTab>
      title={t("purchaseOrders")}
      actions={(
        <>
          <Button asChild variant="outline">
            <Link to="/admin/inventory/suppliers">{t("suppliers")}</Link>
          </Button>
          {createButton}
        </>
      )}
      tabs={PURCHASE_ORDER_TABS.map((value) => ({ value, label: t(TAB_LABEL[value]) }))}
      tab={tab}
      onTabChange={onTabChange}
      searchKey="purchaseOrders"
      searchPlaceholder={t("searchPurchaseOrders")}
      filters={(
        <FilterControl label={t("colSupplier")}>
        <SearchableSelect
          ariaLabel={t("supplierFilter")}
          value={supplierId ?? ""}
          selectedLabel={supplier?.name}
          placeholder={t("allSuppliers")}
          searchPlaceholder={t("searchSuppliersShort")}
          emptyMessage={t("noSuppliersFound")}
          clearable
          load={loadActiveSuppliers}
          queryKey={[...purchasingKeys.suppliers(), "picker"]}
          onValueChange={(value) => onSupplierChange(value || undefined)}
        />
        </FilterControl>
      )}
      filterCount={supplierId ? 1 : 0}
      onClearFilters={() => onSupplierChange(undefined)}
      query={(term, page, limit) => purchaseOrdersQueryOptions(purchaseOrderListQuery(tab, term, page, limit, supplierId))}
      dataKey="purchaseOrders"
      columns={columns}
      layoutKey="purchase-orders"
      itemLabel={t("purchaseOrdersItem")}
      rowHref={(row) => `/admin/inventory/purchase-orders/${row.id}`}
      empty={{
        icon: ClipboardList,
        title: t("emptyPurchaseOrdersTitle"),
        description: t("emptyPurchaseOrdersBody"),
        action: createButton ?? undefined,
      }}
    />
  );
}
