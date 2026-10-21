// One content type's entries: title, status and when each changed. Entries
// open on their own page; a private type says the online store cannot show
// its entries yet.
import { RowLink } from "~/components/admin/data-table/RowLink";
import { useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { FileText } from "lucide-react";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { DataTableToolbar } from "~/components/admin/data-table/DataTableToolbar";
import { FilterControl } from "~/components/admin/data-table/FilterControl";
import { Input } from "~/components/ui/input";
import { DataTable } from "~/components/admin/data-table/DataTable";
import { ListDate } from "~/components/admin/data-table/ListDate";
import { serverTableFeatures, useTable, type ColumnDef } from "~/components/admin/data-table/table-config";
import { EmptyState } from "~/components/admin/states";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { StatusBadge } from "~/components/admin/resource/StatusBadge";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { useCurrency } from "~/hooks/use-currency";
import { usePermissions } from "~/contexts/PermissionContext";
import { useMessages, formatNumber } from "~/i18n";
import { objectMessages } from "~/i18n/objects";
import { OBJECT_RECORD_PAGE_SIZE, objectRecordsQueryOptions } from "~/lib/api-query-options/objects";
import { AppOwnerBadge } from "~/components/admin/apps/app-owner";
import { moneyMajor } from "~/components/admin/custom-fields/custom-field-draft";

export function ObjectRecordsList({ type }: { type: string }) {
  const t = useMessages(objectMessages);
  const permissions = usePermissions();
  const { fmt } = useCurrency();
  const [where, setWhere] = useState<Record<string, string>>({});
  const [page, setPage] = useState(1);
  const [offsets, setOffsets] = useState([0]);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const entries = useQuery({ ...objectRecordsQueryOptions(type, cursors[page - 1], where), placeholderData: keepPreviousData });
  const definition = entries.data?.type;
  const canEdit = permissions.hasPermission(PERMISSIONS.OBJECTS_EDIT) && definition?.admin === "edit";
  const rows = useMemo(() => entries.data?.records ?? [], [entries.data]);
  const total = entries.data?.total ?? 0;
  const indexedKeys = useMemo(() => [...new Set([...(definition?.indexes ?? []), ...(definition?.unique ?? [])].flat())].filter((key) => key !== definition?.display).slice(0, 5), [definition]);
  const filterKeys = [...new Set([...(definition?.indexes ?? [])].map((index) => typeof index === "string" ? index : index[0]!))].slice(0, 4);
  const filterFields = definition?.fields.filter((field) => filterKeys.includes(field.key)) ?? [];
  const firstFilter = filterFields[0];
  const changeFilter = (key: string, value: string) => {
    setWhere(value ? { [key]: value } : {});
    setPage(1);
    setCursors([undefined]);
    setOffsets([0]);
  };
  const clearFilters = () => { setWhere({}); setPage(1); setCursors([undefined]); setOffsets([0]); };
  const appOwned = definition?.owner === "app";
  const add = canEdit ? (
    <Button asChild>
      <Link to="/admin/objects/$type/records/new" params={{ type }}>{t("addEntry")}</Link>
    </Button>
  ) : null;
  const typeAction = (
    <Button asChild variant="outline">
      <Link to="/admin/objects/$type/settings" params={{ type }}>
        {canEdit && !appOwned ? t("editType") : t("viewType")}
      </Link>
    </Button>
  );

  const columns = useMemo<ColumnDef<(typeof rows)[number], unknown>[]>(() => [
    {
      id: "title",
      header: t("columnTitle"),
      meta: { primary: true, minWidth: 220, maxWidth: 480 },
      cell: ({ row }) => {
        const name = row.original.displayName || t("untitledEntry");
        return (
          <RowLink
            to={`/admin/objects/${encodeURIComponent(type)}/records/${encodeURIComponent(row.original.id)}`}
            title={name}
            className="block truncate font-medium text-foreground hover:underline"
          >
            {name}
          </RowLink>
        );
      },
    },
    ...indexedKeys.map((key): ColumnDef<(typeof rows)[number], unknown> => ({
      id: key,
      header: definition?.fields.find((field) => field.key === key)?.name ?? key,
      meta: { minWidth: 140, maxWidth: 260, priority: 40 },
      cell: ({ row }) => {
        const value = row.original.data[key];
        if (value === undefined || value === null) return "—";
        const fieldType = definition?.fields.find((field) => field.key === key)?.type;
        if (fieldType === "money") {
          const major = moneyMajor(value);
          return major === null ? "—" : fmt(major);
        }
        if ((fieldType === "date" || fieldType === "date_time") && typeof value === "string") return <ListDate value={value} />;
        if (typeof value === "boolean") return t(value ? "yes" : "no");
        if (typeof value === "number") return formatNumber(value);
        return <span className="block truncate" title={String(value)}>{String(value)}</span>;
      },
    })),
    {
      id: "status",
      header: t("columnStatus"),
      meta: { mobile: "status", priority: 80, minWidth: 110 },
      cell: ({ row }) => <StatusBadge status={row.original.status === "draft" ? "draft" : "active"}>{t(row.original.status)}</StatusBadge>,
    },
    {
      id: "updated",
      header: t("columnUpdated"),
      meta: { priority: 50, minWidth: 150 },
      cell: ({ row }) => <ListDate value={row.original.updatedAt} />,
    },
  ], [type, t, definition, indexedKeys, fmt]);
  const table = useTable({
    features: serverTableFeatures,
    data: rows,
    columns,
    getRowId: (row) => row.id,
    manualPagination: true,
    manualSorting: true,
    rowCount: total,
    pageCount: page + (entries.data?.nextCursor ? 1 : 0),
    state: { pagination: { pageIndex: page - 1, pageSize: OBJECT_RECORD_PAGE_SIZE }, sorting: [] },
    onPaginationChange: (updater) => {
      const next = typeof updater === "function" ? updater({ pageIndex: page - 1, pageSize: OBJECT_RECORD_PAGE_SIZE }) : updater;
      if (next.pageIndex >= page) {
        if (!entries.data?.nextCursor || entries.isPlaceholderData) return;
        setCursors((current) => [...current.slice(0, page), entries.data!.nextCursor!]);
        setOffsets((current) => [...current.slice(0, page), (current[page - 1] ?? 0) + rows.length]);
      }
      setPage(next.pageIndex + 1);
    },
  });
  const nothingYet = !entries.isPending && !entries.isError && total === 0 && Object.keys(where).length === 0;

  return (
    <div className="pb-8">
      <PageHeader
        backTo="/admin/objects"
        title={definition?.name ?? t("pageTitle")}
        status={appOwned ? <AppOwnerBadge namespace={definition?.namespace ?? ""} managedLabel={(app) => t("managedByAppName", { app })} /> : undefined}
        actions={definition ? <>{typeAction}{nothingYet ? null : add}</> : null}
      />
      <p className="mb-4 max-w-3xl text-body text-muted-foreground">{definition?.description || t("entriesHelp")}</p>
      {definition && !definition.storefront ? (
        <Alert variant="info" className="mb-4">
          <AlertDescription>
            <p>{t("privateNote")}</p>
            {canEdit && !appOwned ? (
              <Link to="/admin/objects/$type/settings" params={{ type }} className="text-link underline">
                {t("privateNoteAction")}
              </Link>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
      {nothingYet ? (
        <EmptyState icon={FileText} title={t("entriesEmptyTitle")} description={t("entriesEmptyBody")} action={add} help={false} />
      ) : (
        <DataTable
          variant="card"
          table={table}
          isLoading={entries.isPending}
          isFetching={entries.isFetching}
          error={entries.isError ? entries.error : undefined}
          onRetry={() => void entries.refetch()}
          what={t("columnTitle")}
          layoutKey="content-entries"
          density="compact"
          toolbar={firstFilter ? (
            <DataTableToolbar
              searchValue={where[firstFilter.key] ?? ""}
              onSearchChange={(value) => changeFilter(firstFilter.key, value)}
              searchPlaceholder={t("filterExact", { field: firstFilter.name })}
              filterCount={Object.keys(where).length}
              onClearFilters={clearFilters}
              filters={filterFields.slice(1).map((field) => (
                <FilterControl key={field.key} label={field.name}>
                  <Input value={where[field.key] ?? ""} onChange={(event) => changeFilter(field.key, event.target.value)} />
                </FilterControl>
              ))}
            />
          ) : undefined}
          defaultSortLabel={false}
          cursorPaging={{
            total, offset: offsets[page - 1] ?? 0,
            pageInfo: { hasNextPage: Boolean(entries.data?.nextCursor), hasPreviousPage: page > 1,
              startCursor: page > 1 ? cursors[page - 1]! : null, endCursor: entries.data?.nextCursor ?? null },
            onNext: () => table.nextPage(), onPrevious: () => table.previousPage(),
          }}
          pageSizeOptions={[OBJECT_RECORD_PAGE_SIZE]}
          getRowHref={(entry) => `/admin/objects/${encodeURIComponent(type)}/records/${encodeURIComponent(entry.id)}`}
        />
      )}
    </div>
  );
}
