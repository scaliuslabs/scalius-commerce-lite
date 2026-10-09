// Products › Price lists (docs/MARKETS-DESIGN.md D5), Medusa's price lists
// list: each list with its type, market, state, SKU count and schedule. A
// list opens on its own page; a new one starts as a draft.
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Tag } from "lucide-react";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { DataTable } from "~/components/admin/data-table/DataTable";
import { useStaticTable } from "~/components/admin/data-table/use-static-table";
import type { ColumnDef } from "~/components/admin/data-table/table-config";
import { EmptyState } from "~/components/admin/states";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { StatusBadge } from "~/components/admin/resource/StatusBadge";
import { Button } from "~/components/ui/button";
import { usePermissions } from "~/contexts/PermissionContext";
import { formatNumber, useMessages } from "~/i18n";
import { priceListMessages } from "~/i18n/price-lists";
import { priceListsQueryOptions, type PriceListSummary } from "~/lib/api-query-options/price-lists";
import { CreatePriceListDialog } from "./CreatePriceListDialog";
import { KIND_LABEL, scheduleText } from "./price-list-form";

export function PriceListsList() {
  const t = useMessages(priceListMessages);
  const canEdit = usePermissions().hasPermission(PERMISSIONS.PRODUCTS_EDIT);
  const lists = useQuery(priceListsQueryOptions());
  const [creating, setCreating] = useState(false);
  const rows = useMemo(() => lists.data ?? [], [lists.data]);
  const create = canEdit ? <Button onClick={() => setCreating(true)}>{t("create")}</Button> : null;

  const columns = useMemo<ColumnDef<PriceListSummary, unknown>[]>(() => [
    {
      id: "name",
      header: t("columnName"),
      meta: { primary: true, minWidth: 220, maxWidth: 420 },
      cell: ({ row }) => (
        <span className="block min-w-0">
          <Link
            to="/admin/price-lists/$priceListId"
            params={{ priceListId: row.original.id }}
            title={row.original.name}
            className="block truncate font-medium text-foreground hover:underline"
          >
            {row.original.name}
          </Link>
          {row.original.description ? <span title={row.original.description} className="block truncate text-muted-foreground">{row.original.description}</span> : null}
        </span>
      ),
    },
    {
      id: "status",
      header: t("columnStatus"),
      meta: { mobile: "status", priority: 90, minWidth: 110 },
      cell: ({ row }) => <StatusBadge status={row.original.state}>{t(row.original.state)}</StatusBadge>,
    },
    {
      id: "type",
      header: t("columnType"),
      meta: { priority: 60, minWidth: 180, maxWidth: 260 },
      cell: ({ row }) => {
        const list = row.original;
        const where = list.kind === "segment" && list.segmentName
          ? t("segmentOf", { segment: list.segmentName, market: list.marketName })
          : list.marketName;
        return (
          <span className="block min-w-0">
            <span className="block truncate">{t(KIND_LABEL[list.kind])}</span>
            <span title={where ?? undefined} className="block truncate text-muted-foreground">{where}</span>
          </span>
        );
      },
    },
    {
      id: "prices",
      header: t("columnPrices"),
      meta: { numeric: true, priority: 70, minWidth: 90 },
      cell: ({ row }) => formatNumber(row.original.variantCount),
    },
    {
      id: "schedule",
      header: t("columnSchedule"),
      meta: { priority: 40, minWidth: 180 },
      cell: ({ row }) => <span className="block truncate" title={scheduleText(row.original, t)}>{scheduleText(row.original, t)}</span>,
    },
  ], [t]);
  const { table } = useStaticTable(rows, columns);
  const nothingYet = !lists.isPending && !lists.isError && rows.length === 0;

  return (
    <div className="pb-8">
      <PageHeader title={t("pageTitle")} actions={nothingYet ? null : create} />
      <p className="mb-4 max-w-3xl text-body text-muted-foreground">{t("pageDescription")}</p>
      {nothingYet ? (
        <EmptyState icon={Tag} title={t("emptyTitle")} description={t("emptyBody")} action={create} />
      ) : (
        <DataTable
          variant="card"
          table={table}
          isLoading={lists.isPending}
          isFetching={lists.isFetching}
          error={lists.isError ? lists.error : undefined}
          onRetry={() => void lists.refetch()}
          what={t("pageTitle")}
          layoutKey="price-lists"
          defaultSortLabel={false}
          paginate={false}
          getRowHref={(list) => `/admin/price-lists/${list.id}`}
        />
      )}
      {canEdit ? <CreatePriceListDialog open={creating} onOpenChange={setCreating} /> : null}
    </div>
  );
}
