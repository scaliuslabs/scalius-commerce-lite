import { useEffect, useMemo, useState } from "react";
import { RowLink } from "~/components/admin/data-table/RowLink";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { MoreHorizontal, UsersRound } from "lucide-react";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { DataTable } from "~/components/admin/data-table/DataTable";
import { DataTableToolbar } from "~/components/admin/data-table/DataTableToolbar";
import { localeWidth } from "~/components/admin/data-table/column-layout";
import { serverTableFeatures, useTable, type ColumnDef, type PaginationState } from "~/components/admin/data-table/table-config";
import { EmptyState, FilteredEmptyState } from "~/components/admin/states";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { usePermissions } from "~/contexts/PermissionContext";
import { customerSegmentsQueryOptions, type CustomerSegment } from "~/lib/api-query-options/customers";
import { useMessages } from "~/i18n";
import { customerSegmentMessages } from "~/i18n/customer-segments";
import { DeleteSegmentDialog, SegmentMemberCount, useSegmentExport } from "./segment-actions";
import { useListSearch } from "~/lib/list-search";
import { DEFAULT_PAGE_SIZE, readSavedPageSize } from "~/lib/list-helpers";
import { filterCustomerSegments } from "./segment-list-search";

/**
 * Customers → Segments: search saved segments and request their member counts.
 * The API caps metadata at 200 rows; only the current page is rendered.
 * Open one to change it; view its customers, export or delete it from its menu.
 */
export function SegmentList() {
  const t = useMessages(customerSegmentMessages);
  const navigate = useNavigate();
  const canEdit = usePermissions().hasPermission(PERMISSIONS.CUSTOMERS_EDIT);
  const segments = useQuery(customerSegmentsQueryOptions());
  const exporter = useSegmentExport();
  const [deleting, setDeleting] = useState<CustomerSegment | null>(null);
  const [term, setTerm] = useListSearch("segments");
  const [pagination, setPagination] = useState<PaginationState>(() => ({
    pageIndex: 0, pageSize: readSavedPageSize("segments") ?? DEFAULT_PAGE_SIZE,
  }));
  const rows = segments.data?.segments ?? [];
  const filtered = useMemo(() => filterCustomerSegments(segments.data?.segments ?? [], term), [segments.data, term]);
  const pageIndex = Math.min(pagination.pageIndex, Math.max(0, Math.ceil(filtered.length / pagination.pageSize) - 1));
  useEffect(() => {
    if (pagination.pageIndex !== pageIndex) setPagination((current) => ({ ...current, pageIndex }));
  }, [pageIndex, pagination.pageIndex]);
  const search = (value: string) => {
    setTerm(value);
    setPagination((current) => ({ ...current, pageIndex: 0 }));
  };
  const create = canEdit ? (
    <Button asChild>
      <Link to="/admin/customers/segments/new">{t("createSegment")}</Link>
    </Button>
  ) : null;

  const columns = useMemo<ColumnDef<CustomerSegment, unknown>[]>(() => [
    {
      id: "name",
      header: t("segment"),
      meta: { primary: true, minWidth: 240, maxWidth: 520 },
      cell: ({ row }) => {
        const segment = row.original;
        const note = segment.description
          || (segment.promotionCount === 1 ? t("usedByOne") : segment.promotionCount > 1 ? t("usedBy", { count: segment.promotionCount }) : "");
        return (
          <span className="block min-w-0">
            <RowLink
              to={`/admin/customers/segments/${segment.id}`}
              title={segment.name}
              className="block truncate font-medium text-foreground hover:underline"
            >
              {segment.name}
            </RowLink>
            {note ? <span title={note} className="block truncate text-muted-foreground">{note}</span> : null}
          </span>
        );
      },
    },
    {
      id: "customers",
      header: t("customers"),
      meta: { numeric: true, keep: true, minWidth: localeWidth({ en: 180, bn: 200 }) },
      cell: ({ row }) => <SegmentMemberCount segmentId={row.original.id} name={row.original.name} />,
    },
    {
      id: "actions",
      header: () => null,
      cell: ({ row }) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={t("actionsFor", { name: row.original.name })} title={t("actionsFor", { name: row.original.name })}>
              <MoreHorizontal aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => void navigate({ to: "/admin/customers", search: { segmentId: row.original.id } as never })}>
              {t("viewCustomers")}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={exporter.busy !== null} onSelect={() => void exporter.run(row.original.id)}>
              {t("export")}
            </DropdownMenuItem>
            {canEdit ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(row.original)}>
                  {t("delete")}
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
    // `exporter.busy` re-renders the menus; `t` follows the language.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [canEdit, exporter.busy, t]);
  const page = { ...pagination, pageIndex };
  const table = useTable({
    features: serverTableFeatures,
    data: filtered.slice(pageIndex * page.pageSize, (pageIndex + 1) * page.pageSize),
    columns,
    getRowId: (row) => row.id,
    manualPagination: true,
    manualSorting: true,
    enableRowSelection: false,
    rowCount: filtered.length,
    state: { pagination: page, sorting: [], rowSelection: {} },
    onPaginationChange: (updater) => setPagination(typeof updater === "function" ? updater(page) : updater),
  });
  const nothingYet = !segments.isPending && !segments.isError && rows.length === 0;

  return (
    <div className="pb-8">
      <PageHeader title={t("segments")} actions={nothingYet ? null : create} />
      {nothingYet ? (
        <EmptyState icon={UsersRound} title={t("emptyTitle")} description={t("emptyBody")} action={create} />
      ) : (
        <DataTable
          variant="card"
          table={table}
          isLoading={segments.isPending}
          isFetching={segments.isFetching}
          error={segments.isError ? segments.error : undefined}
          onRetry={() => void segments.refetch()}
          what={t("segments")}
          layoutKey="segments"
          defaultSortLabel={false}
          toolbar={<DataTableToolbar searchValue={term} onSearchChange={search} searchPlaceholder={t("searchSegments")} />}
          emptyState={<FilteredEmptyState onClearFilters={() => search("")} />}
          getRowHref={(segment) => `/admin/customers/segments/${segment.id}`}
        />
      )}
      <DeleteSegmentDialog segment={deleting} onOpenChange={(open) => { if (!open) setDeleting(null); }} />
    </div>
  );
}
