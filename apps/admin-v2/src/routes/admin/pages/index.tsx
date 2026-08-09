import { lazy, Suspense, useState, useMemo, useCallback } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Eye, EyeOff, FileText, Plus, RotateCcw, Trash2 } from "lucide-react";
import {
  createDataSelector,
} from "~/lib/list-helpers";
import { RouteErrorComponent } from "~/lib/route-error";
import { Button } from "~/components/ui/button";
import { useStorefrontUrl } from "~/hooks/use-storefront-url";
import { pagesQueryOptions } from "~/lib/api-query-options/pages";
import { warmRouteQuery } from "~/lib/route-query-warming";
import {
  useDeletePage,
  usePermanentDeletePage,
  useRestorePage,
  useBulkDeletePages,
  useBulkPublishPages,
  useBulkRestorePages,
  useBulkUnpublishPages,
} from "~/lib/api-mutations/pages";
import { DataTable } from "~/components/admin/data-table/DataTable";
import { DataTableToolbar } from "~/components/admin/data-table/DataTableToolbar";
import { useServerTable } from "~/components/admin/data-table/useServerTable";
import { getPageColumns } from "~/components/admin/data-table/columns/page-columns";
import type { Page } from "~/types/api-responses";
import type { PageRevisionClaim } from "~/lib/api-functions/pages";
import { usePermissions } from "~/contexts/PermissionContext";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Checkbox } from "~/components/ui/checkbox";
import { DataTableRowActions } from "~/components/admin/data-table/DataTableRowActions";
import { PagePublicationBadge } from "~/components/admin/pages/PagePublicationBadge";
import { getPagePublicationMode, isPageLive } from "~/lib/page-publication";
import { formatDate, formatDateShort } from "@scalius/shared/timestamps";
import type { Row } from "@/components/admin/data-table/table-config";
import {
  pageListQueryParams,
  validatePageSearch,
  type PageStatusFilter,
} from "./-page-list-state";

const PageDeleteDialog = lazy(() =>
  import("./-PageDeleteDialog").then((module) => ({
    default: module.PageDeleteDialog,
  })),
);

export const Route = createFileRoute("/admin/pages/")({
  validateSearch: validatePageSearch,
  loaderDeps: ({ search }) => search,
  staleTime: 1000 * 60 * 2,
  loader: async ({ context: { queryClient }, deps }) => {
    await warmRouteQuery(queryClient, pagesQueryOptions(pageListQueryParams(deps)));
  },
  head: ({ match }) => ({
    meta: [
      {
        title: `${match.search.trashed ? "Page trash" : "Pages"} | Scalius Admin`,
      },
    ],
  }),
  component: PagesPage,
  errorComponent: RouteErrorComponent,
});

function PagesPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const { getStorefrontPath } = useStorefrontUrl();
  const { hasPermission } = usePermissions();
  const showTrashed = search.trashed;
  const canCreate = hasPermission(PERMISSIONS.PAGES_CREATE);
  const canEdit = hasPermission(PERMISSIONS.PAGES_EDIT);
  const canDelete = hasPermission(PERMISSIONS.PAGES_DELETE);
  const canPublish = hasPermission(PERMISSIONS.PAGES_PUBLISH);

  // Mutations
  const deleteMutation = useDeletePage();
  const permanentDeleteMutation = usePermanentDeletePage();
  const restoreMutation = useRestorePage();
  const bulkDeleteMutation = useBulkDeletePages();
  const bulkRestoreMutation = useBulkRestorePages();
  const bulkPublishMutation = useBulkPublishPages();
  const bulkUnpublishMutation = useBulkUnpublishPages();

  // Delete confirmation state
  const [deleteClaim, setDeleteClaim] = useState<PageRevisionClaim | null>(null);
  const [bulkDeleteClaims, setBulkDeleteClaims] = useState<PageRevisionClaim[] | null>(null);

  // Column definitions
  const columns = useMemo(
    () =>
      getPageColumns({
        showTrashed,
        getStorefrontPath,
        canEdit,
        onEdit: canEdit
          ? (id) => void navigate({ to: "/admin/pages/$pageId/edit", params: { pageId: id } })
          : undefined,
        onDelete: canDelete ? (claim) => setDeleteClaim(claim) : undefined,
        onRestore: canEdit ? (claim) => restoreMutation.mutate(claim) : undefined,
        onPermanentDelete: canDelete ? (claim) => setDeleteClaim(claim) : undefined,
      }),
    [showTrashed, getStorefrontPath, canEdit, canDelete, navigate, restoreMutation],
  );

  // Data selector
  const dataSelector = useMemo(() => createDataSelector<Page>("pages"), []);

  const onPaginationChange = useCallback(
    (page: number, limit: number) => {
      void navigate({
        search: ((prev: Record<string, unknown>) => ({ ...prev, page, limit })) as never,
      });
    },
    [navigate],
  );

  const onSortingChange = useCallback(
    (sort: string, order: "asc" | "desc") => {
      void navigate({
        search: ((prev: Record<string, unknown>) => ({ ...prev, sort, order, page: 1 })) as never,
      });
    },
    [navigate],
  );

  const { table, isFetching, isLoading, selectedRows, selectedIds, clearSelection } =
    useServerTable({
      columns,
      queryOptions: pagesQueryOptions(pageListQueryParams(search)),
      dataSelector,
      currentPage: search.page,
      currentLimit: search.limit,
      currentSort: search.sort,
      currentOrder: search.order,
      onPaginationChange,
      onSortingChange,
    });

  const selectedClaims = selectedRows.map((page) => ({
    id: page.id,
    expectedRevision: page.revision,
  }));

  const isActionLoading =
    deleteMutation.isPending || permanentDeleteMutation.isPending || bulkDeleteMutation.isPending;

  const handleConfirmDelete = useCallback(() => {
    if (bulkDeleteClaims) {
      const claims = bulkDeleteClaims;
      setBulkDeleteClaims(null);
      bulkDeleteMutation.mutate(
        { pages: claims, permanent: showTrashed },
        { onSuccess: clearSelection },
      );
      return;
    }
    if (!deleteClaim) return;
    const claim = deleteClaim;
    setDeleteClaim(null);
    if (showTrashed) {
      permanentDeleteMutation.mutate(claim);
    } else {
      deleteMutation.mutate(claim);
    }
  }, [
    bulkDeleteClaims,
    bulkDeleteMutation,
    clearSelection,
    deleteClaim,
    deleteMutation,
    permanentDeleteMutation,
    showTrashed,
  ]);

  const isPageDeleteDialogOpen = !!deleteClaim || !!bulkDeleteClaims;

  const mobileCardRenderer = useCallback((row: Row<Page>) => {
    const page = row.original;
    const publicationMode = getPagePublicationMode(page);
    const claim = { id: page.id, expectedRevision: page.revision };
    return (
      <div className="flex items-start gap-3 p-3">
        <Checkbox
          checked={row.getIsSelected()}
          onCheckedChange={(value) => row.toggleSelected(Boolean(value))}
          aria-label={`Select ${page.title}`}
          className="mt-1"
        />
        <div className="min-w-0 flex-1">
          {canEdit && !showTrashed ? (
            <Link
              to="/admin/pages/$pageId/edit"
              params={{ pageId: page.id }}
              className="block truncate text-sm font-medium hover:underline"
            >
              {page.title}
            </Link>
          ) : <div className="truncate text-sm font-medium">{page.title}</div>}
          <div className="mt-0.5 truncate text-xs text-muted-foreground">/{page.slug}</div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <PagePublicationBadge page={page} />
            <span className="text-xs text-muted-foreground" suppressHydrationWarning>
              {publicationMode === "scheduled" && page.publishedAt
                ? `Publishes ${formatDate(page.publishedAt)}`
                : `Updated ${formatDateShort(page.updatedAt)}`}
            </span>
          </div>
        </div>
        <DataTableRowActions
          showTrashed={showTrashed}
          onView={!showTrashed && isPageLive(page)
            ? () => window.open(getStorefrontPath(`/${page.slug}`), "_blank")
            : undefined}
          onEdit={canEdit && !showTrashed
            ? () => void navigate({ to: "/admin/pages/$pageId/edit", params: { pageId: page.id } })
            : undefined}
          onDelete={canDelete && !showTrashed ? () => setDeleteClaim(claim) : undefined}
          onRestore={canEdit && showTrashed ? () => restoreMutation.mutate(claim) : undefined}
          onPermanentDelete={canDelete && showTrashed ? () => setDeleteClaim(claim) : undefined}
          menuLabel={`Actions for ${page.title}`}
        />
      </div>
    );
  }, [canDelete, canEdit, getStorefrontPath, navigate, restoreMutation, showTrashed]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            {showTrashed ? "Page trash" : "Pages"}
          </h1>
          {showTrashed ? (
            <p className="mt-0.5 text-sm text-muted-foreground">
              Restore pages or delete them permanently.
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Link
            to="/admin/pages"
            search={(showTrashed ? {} : { trashed: true }) as never}
          >
            <Button variant="outline" size="sm" className="h-11 sm:h-9">
              {showTrashed ? (
                <FileText className="mr-2 h-4 w-4" />
              ) : (
                <Trash2 className="mr-2 h-4 w-4" />
              )}
              {showTrashed ? "View pages" : "View trash"}
            </Button>
          </Link>
          {!showTrashed && canCreate && (
            <Link to="/admin/pages/new">
              <Button size="sm" className="h-11 sm:h-9">
                <Plus className="mr-2 h-4 w-4" />
                New page
              </Button>
            </Link>
          )}
        </div>
      </div>

      <DataTable
        table={table}
        isFetching={isFetching}
        isLoading={isLoading}
        itemLabel="pages"
        mobileCardRenderer={mobileCardRenderer}
        emptyState={{
          icon: FileText,
          title: showTrashed ? "Trash is empty" : "No pages found",
          description: showTrashed
            ? "Deleted pages will appear here."
            : "Create a page to add storefront content.",
        }}
        toolbar={
          <DataTableToolbar
            searchValue={search.search}
            onSearchChange={(value) =>
              void navigate({
                search: ((prev: Record<string, unknown>) => ({ ...prev, search: value, page: 1 })) as never,
              })
            }
            searchPlaceholder="Search pages…"
            filters={!showTrashed ? (
              <Select
                value={search.status ?? "all"}
                onValueChange={(value) => void navigate({
                  search: ((prev: Record<string, unknown>) => ({
                    ...prev,
                    status: value === "all" ? undefined : value as PageStatusFilter,
                    page: 1,
                  })) as never,
                })}
              >
                <SelectTrigger className="h-11 w-[150px] sm:h-9" aria-label="Filter pages by status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="draft">Draft</SelectItem>
                  <SelectItem value="scheduled">Scheduled</SelectItem>
                  <SelectItem value="published">Live</SelectItem>
                </SelectContent>
              </Select>
            ) : undefined}
            selectedCount={selectedIds.length}
            bulkActions={<>
              {showTrashed && canEdit ? (
                <Button variant="outline" size="sm" className="h-11 sm:h-9" onClick={() => bulkRestoreMutation.mutate(selectedClaims, { onSuccess: clearSelection })}>
                  <RotateCcw className="mr-2 h-4 w-4" /> Restore
                </Button>
              ) : null}
              {!showTrashed && canPublish ? (
                <>
                  <Button variant="outline" size="sm" className="h-11 sm:h-9" onClick={() => bulkPublishMutation.mutate(selectedClaims, { onSuccess: clearSelection })}>
                    <Eye className="mr-2 h-4 w-4" /> Publish now
                  </Button>
                  <Button variant="outline" size="sm" className="h-11 sm:h-9" onClick={() => bulkUnpublishMutation.mutate(selectedClaims, { onSuccess: clearSelection })}>
                    <EyeOff className="mr-2 h-4 w-4" /> Move to draft
                  </Button>
                </>
              ) : null}
              {canDelete ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-11 border-destructive text-destructive hover:bg-destructive/10 sm:h-9"
                  onClick={() => setBulkDeleteClaims(selectedClaims)}
                >
                  <Trash2 className="mr-2 h-4 w-4" /> {showTrashed ? "Delete" : "Trash"}
                </Button>
              ) : null}
            </>}
          />
        }
      />

      {isPageDeleteDialogOpen && (
        <Suspense fallback={null}>
          <PageDeleteDialog
            showTrashed={showTrashed}
            itemCount={bulkDeleteClaims?.length ?? 1}
            isOpen={isPageDeleteDialogOpen}
            isActionLoading={isActionLoading}
            onOpenChange={(open) => {
              if (!open) {
                setDeleteClaim(null);
                setBulkDeleteClaims(null);
              }
            }}
            onConfirm={handleConfirmDelete}
          />
        </Suspense>
      )}
    </div>
  );
}
