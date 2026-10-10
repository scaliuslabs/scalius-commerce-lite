import { useMemo } from "react";
import { RowLink } from "~/components/admin/data-table/RowLink";
import { createDateColumn } from "~/components/admin/data-table/columns/column-factories";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeftRight } from "lucide-react";
import type { ColumnDef } from "~/components/admin/data-table/table-config";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { useCatalogActionPermissions } from "~/hooks/use-catalog-action-permissions";
import { formatNumber, useMessages } from "~/i18n";
import { purchasingMessages } from "~/i18n/purchasing";
import { inventoryLocationsQueryOptions } from "~/lib/api-query-options/inventory-locations";
import { transfersQueryOptions, type TransferSummary } from "~/lib/api-query-options/purchasing";
import { DocumentList } from "./DocumentList";
import { formatDay } from "./purchasing-format";
import { TRANSFER_TABS, transferListQuery, type TransferTab } from "./purchasing-list-state";
import { TransferStatusBadge } from "./purchasing-status";

const TAB_LABEL = {
  all: "tabAll",
  draft: "tabDraft",
  open: "tabInTransit",
  received: "tabReceived",
  cancelled: "tabCancelled",
} as const;

/** Products › Transfers: stock moving between locations, newest first. */
export function TransferList({ tab, onTabChange }: { tab: TransferTab; onTabChange: (tab: TransferTab) => void }) {
  const t = useMessages(purchasingMessages);
  const { inventory: { canManageOperations: canEdit } } = useCatalogActionPermissions();
  const locations = useQuery(inventoryLocationsQueryOptions());
  const activeCount = locations.data?.filter((location) => location.status === "active").length ?? 0;
  const oneLocation = locations.isSuccess && activeCount < 2;

  const columns = useMemo<ColumnDef<TransferSummary, unknown>[]>(() => [
    {
      id: "number",
      header: t("colTransfer"),
      meta: { primary: true, mobile: "primary", minWidth: 120 },
      cell: ({ row }) => (
        <RowLink
          to={`/admin/inventory/transfers/${row.original.id}`}
          className="whitespace-nowrap font-mono font-medium hover:underline"
        >
          {row.original.displayNumber}
        </RowLink>
      ),
    },
    {
      id: "route",
      header: t("colRoute"),
      meta: { mobile: "secondary", priority: 85, minWidth: 200 },
      cell: ({ row }) => {
        const route = t("route", { origin: row.original.origin.name, destination: row.original.destination.name });
        return <span className="block truncate" title={route}>{route}</span>;
      },
    },
    {
      id: "status",
      header: t("colStatus"),
      meta: { mobile: "status", priority: 90, minWidth: 130 },
      cell: ({ row }) => <TransferStatusBadge status={row.original.status} />,
    },
    {
      id: "units",
      header: t("colUnits"),
      meta: { numeric: true, priority: 60, minWidth: 90 },
      cell: ({ row }) => formatNumber(row.original.quantity),
    },
    {
      id: "inTransit",
      header: t("colInTransit"),
      meta: { numeric: true, mobile: "secondary", priority: 80, minWidth: 100 },
      cell: ({ row }) => row.original.inTransitQuantity > 0
        ? t("inTransitSummary", { count: row.original.inTransitQuantity })
        : <span className="text-muted-foreground">—</span>,
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
    createDateColumn("createdAt", t("colCreated"), { id: "created", sortable: false, priority: 30 }),
  ], [t]);

  const createButton = canEdit && !oneLocation ? (
    <Button asChild>
      <Link to="/admin/inventory/transfers/new">{t("createTransfer")}</Link>
    </Button>
  ) : null;

  return (
    <DocumentList<TransferSummary, TransferTab>
      title={t("transfers")}
      actions={createButton}
      notice={oneLocation ? (
        <Alert variant="info">
          <AlertDescription>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>{t("needTwoLocations")}</span>
              <Button asChild variant="outline" size="sm">
                <Link to="/admin/settings/locations">{t("addLocation")}</Link>
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}
      tabs={TRANSFER_TABS.map((value) => ({ value, label: t(TAB_LABEL[value]) }))}
      tab={tab}
      onTabChange={onTabChange}
      searchKey="transfers"
      searchPlaceholder={t("searchTransfers")}
      query={(term, page, limit) => transfersQueryOptions(transferListQuery(tab, term, page, limit))}
      dataKey="transfers"
      columns={columns}
      layoutKey="inventory-transfers"
      itemLabel={t("transfersItem")}
      rowHref={(row) => `/admin/inventory/transfers/${row.id}`}
      empty={{
        icon: ArrowLeftRight,
        title: t("emptyTransfersTitle"),
        description: t("emptyTransfersBody"),
        action: createButton ?? undefined,
      }}
    />
  );
}
