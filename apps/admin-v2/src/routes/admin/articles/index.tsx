import { lazy, Suspense, useCallback, useMemo, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Eye, EyeOff, Newspaper, Plus, RotateCcw, Trash2 } from "lucide-react";
import type { Row } from "@/components/admin/data-table/table-config";
import { createDataSelector } from "~/lib/list-helpers";
import { RouteErrorComponent } from "~/lib/route-error";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { useStorefrontUrl } from "~/hooks/use-storefront-url";
import { pagesQueryOptions } from "~/lib/api-query-options/pages";
import { warmRouteQuery } from "~/lib/route-query-warming";
import {
  useBulkDeletePages,
  useBulkPublishPages,
  useBulkRestorePages,
  useBulkUnpublishPages,
  useDeletePage,
  usePermanentDeletePage,
  useRestorePage,
} from "~/lib/api-mutations/pages";
import { DataTable } from "~/components/admin/data-table/DataTable";
import { DataTableToolbar } from "~/components/admin/data-table/DataTableToolbar";
import { DataTableRowActions } from "~/components/admin/data-table/DataTableRowActions";
import { useServerTable } from "~/components/admin/data-table/useServerTable";
import { getPageColumns } from "~/components/admin/data-table/columns/page-columns";
import { PagePublicationBadge } from "~/components/admin/pages/PagePublicationBadge";
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
import { getPagePublicationMode, isPageLive } from "~/lib/page-publication";
import { formatDate, formatDateShort } from "@scalius/shared/timestamps";
import {
  pageListQueryParams,
  validatePageSearch,
  type PageStatusFilter,
} from "../pages/-page-list-state";

const PageDeleteDialog = lazy(() =>
  import("../pages/-PageDeleteDialog").then((module) => ({
    default: module.PageDeleteDialog,
  })),
);

export const Route = createFileRoute("/admin/articles/")({
  validateSearch: validatePageSearch,
  loaderDeps: ({ search }) => search,
  staleTime: 1000 * 60 * 2,
  loader: async ({ context: { queryClient }, deps }) => {
    await warmRouteQuery(
      queryClient,
      pagesQueryOptions({
        ...pageListQueryParams(deps),
        contentType: "article",
      }),
    );
  },
  head: ({ match }) => ({
    meta: [
      {
        title: `${match.search.trashed ? "Article trash" : "Articles"} | Scalius Admin`,
      },
    ],
  }),
  component: ArticlesPage,
  errorComponent: RouteErrorComponent,
});

function ArticlesPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const { getStorefrontPath } = useStorefrontUrl();
  const { hasPermission } = usePermissions();
  const showTrashed = search.trashed;
  const canCreate = hasPermission(PERMISSIONS.PAGES_CREATE);
  const canEdit = hasPermission(PERMISSIONS.PAGES_EDIT);
  const canDelete = hasPermission(PERMISSIONS.PAGES_DELETE);
  const canPublish = hasPermission(PERMISSIONS.PAGES_PUBLISH);

  const deleteMutation = useDeletePage("Article");
  const permanentDeleteMutation = usePermanentDeletePage("Article");
  const restoreMutation = useRestorePage("Article");
  const bulkDeleteMutation = useBulkDeletePages("articles");
  const bulkRestoreMutation = useBulkRestorePages("articles");
  const bulkPublishMutation = useBulkPublishPages("article", "articles");
  const bulkUnpublishMutation = useBulkUnpublishPages("article", "articles");
  const [deleteClaim, setDeleteClaim] = useState<PageRevisionClaim | null>(
    null,
  );
  const [bulkDeleteClaims, setBulkDeleteClaims] = useState<
    PageRevisionClaim[] | null
  >(null);

  const columns = useMemo(
    () =>
      getPageColumns({
        contentType: "article",
        showTrashed,
        getStorefrontPath,
        canEdit,
        onEdit: canEdit
          ? (id) =>
              void navigate({
                to: "/admin/articles/$articleId/edit",
                params: { articleId: id },
              })
          : undefined,
        onDelete: canDelete ? setDeleteClaim : undefined,
        onRestore: canEdit
          ? (claim) => restoreMutation.mutate(claim)
          : undefined,
        onPermanentDelete: canDelete ? setDeleteClaim : undefined,
      }),
    [
      canDelete,
      canEdit,
      getStorefrontPath,
      navigate,
      restoreMutation,
      showTrashed,
    ],
  );

  const queryParams = useMemo(
    () => ({
      ...pageListQueryParams(search),
      contentType: "article" as const,
    }),
    [search],
  );
  const dataSelector = useMemo(() => createDataSelector<Page>("pages"), []);
  const onPaginationChange = useCallback(
    (page: number, limit: number) => {
      void navigate({
        search: ((prev: Record<string, unknown>) => ({
          ...prev,
          page,
          limit,
        })) as never,
      });
    },
    [navigate],
  );
  const onSortingChange = useCallback(
    (sort: string, order: "asc" | "desc") => {
      void navigate({
        search: ((prev: Record<string, unknown>) => ({
          ...prev,
          sort,
          order,
          page: 1,
        })) as never,
      });
    },
    [navigate],
  );

  const {
    table,
    isFetching,
    isLoading,
    selectedRows,
    selectedIds,
    clearSelection,
  } = useServerTable({
    columns,
    queryOptions: pagesQueryOptions(queryParams),
    dataSelector,
    currentPage: search.page,
    currentLimit: search.limit,
    currentSort: search.sort,
    currentOrder: search.order,
    onPaginationChange,
    onSortingChange,
  });

  const selectedClaims = selectedRows.map((article) => ({
    id: article.id,
    expectedRevision: article.revision,
  }));
  const isActionLoading =
    deleteMutation.isPending ||
    permanentDeleteMutation.isPending ||
    bulkDeleteMutation.isPending;

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
    if (showTrashed) permanentDeleteMutation.mutate(claim);
    else deleteMutation.mutate(claim);
  }, [
    bulkDeleteClaims,
    bulkDeleteMutation,
    clearSelection,
    deleteClaim,
    deleteMutation,
    permanentDeleteMutation,
    showTrashed,
  ]);

  const mobileCardRenderer = useCallback(
    (row: Row<Page>) => {
      const article = row.original;
      const publicationMode = getPagePublicationMode(article);
      const claim = { id: article.id, expectedRevision: article.revision };
      return (
        <div className="flex items-start gap-3 p-3">
          <Checkbox
            checked={row.getIsSelected()}
            onCheckedChange={(value) => row.toggleSelected(Boolean(value))}
            aria-label={`Select ${article.title}`}
            className="mt-1"
          />
          <div className="min-w-0 flex-1">
            {canEdit && !showTrashed ? (
              <Link
                to="/admin/articles/$articleId/edit"
                params={{ articleId: article.id }}
                className="block truncate text-sm font-medium hover:underline"
              >
                {article.title}
              </Link>
            ) : (
              <div className="truncate text-sm font-medium">
                {article.title}
              </div>
            )}
            <div className="mt-0.5 truncate text-xs text-muted-foreground">
              /blog/{article.slug}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <PagePublicationBadge page={article} />
              <span
                className="text-xs text-muted-foreground"
                suppressHydrationWarning
              >
                {publicationMode === "scheduled" && article.publishedAt
                  ? `Publishes ${formatDate(article.publishedAt)}`
                  : `Updated ${formatDateShort(article.updatedAt)}`}
              </span>
            </div>
          </div>
          <DataTableRowActions
            showTrashed={showTrashed}
            onView={
              !showTrashed && isPageLive(article)
                ? () =>
                    window.open(
                      getStorefrontPath(`/blog/${article.slug}`),
                      "_blank",
                    )
                : undefined
            }
            onEdit={
              canEdit && !showTrashed
                ? () =>
                    void navigate({
                      to: "/admin/articles/$articleId/edit",
                      params: { articleId: article.id },
                    })
                : undefined
            }
            onDelete={
              canDelete && !showTrashed
                ? () => setDeleteClaim(claim)
                : undefined
            }
            onRestore={
              canEdit && showTrashed
                ? () => restoreMutation.mutate(claim)
                : undefined
            }
            onPermanentDelete={
              canDelete && showTrashed ? () => setDeleteClaim(claim) : undefined
            }
            menuLabel={`Actions for ${article.title}`}
          />
        </div>
      );
    },
    [
      canDelete,
      canEdit,
      getStorefrontPath,
      navigate,
      restoreMutation,
      showTrashed,
    ],
  );

  const dialogOpen = Boolean(deleteClaim || bulkDeleteClaims);
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            {showTrashed ? "Article trash" : "Articles"}
          </h1>
          {showTrashed ? (
            <p className="mt-0.5 text-sm text-muted-foreground">
              Restore articles or delete them permanently.
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Link
            to="/admin/articles"
            search={(showTrashed ? {} : { trashed: true }) as never}
          >
            <Button variant="outline" size="sm" className="h-11 sm:h-9">
              {showTrashed ? (
                <Newspaper className="mr-2 h-4 w-4" />
              ) : (
                <Trash2 className="mr-2 h-4 w-4" />
              )}
              {showTrashed ? "View articles" : "View trash"}
            </Button>
          </Link>
          {!showTrashed && canCreate ? (
            <Link to="/admin/articles/new">
              <Button size="sm" className="h-11 sm:h-9">
                <Plus className="mr-2 h-4 w-4" /> New article
              </Button>
            </Link>
          ) : null}
        </div>
      </div>

      <DataTable
        table={table}
        isFetching={isFetching}
        isLoading={isLoading}
        itemLabel="articles"
        mobileCardRenderer={mobileCardRenderer}
        emptyState={{
          icon: Newspaper,
          title: showTrashed ? "Trash is empty" : "No articles found",
          description: showTrashed
            ? "Deleted articles will appear here."
            : "Create an article to start your blog.",
        }}
        toolbar={
          <DataTableToolbar
            searchValue={search.search}
            onSearchChange={(value) =>
              void navigate({
                search: ((prev: Record<string, unknown>) => ({
                  ...prev,
                  search: value,
                  page: 1,
                })) as never,
              })
            }
            searchPlaceholder="Search articles…"
            filters={
              !showTrashed ? (
                <Select
                  value={search.status ?? "all"}
                  onValueChange={(value) =>
                    void navigate({
                      search: ((prev: Record<string, unknown>) => ({
                        ...prev,
                        status:
                          value === "all"
                            ? undefined
                            : (value as PageStatusFilter),
                        page: 1,
                      })) as never,
                    })
                  }
                >
                  <SelectTrigger
                    className="h-11 w-[150px] sm:h-9"
                    aria-label="Filter articles by status"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All statuses</SelectItem>
                    <SelectItem value="draft">Draft</SelectItem>
                    <SelectItem value="scheduled">Scheduled</SelectItem>
                    <SelectItem value="published">Live</SelectItem>
                  </SelectContent>
                </Select>
              ) : undefined
            }
            selectedCount={selectedIds.length}
            bulkActions={
              <>
                {showTrashed && canEdit ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-11 sm:h-9"
                    onClick={() =>
                      bulkRestoreMutation.mutate(selectedClaims, {
                        onSuccess: clearSelection,
                      })
                    }
                  >
                    <RotateCcw className="mr-2 h-4 w-4" /> Restore
                  </Button>
                ) : null}
                {!showTrashed && canPublish ? (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-11 sm:h-9"
                      onClick={() =>
                        bulkPublishMutation.mutate(selectedClaims, {
                          onSuccess: clearSelection,
                        })
                      }
                    >
                      <Eye className="mr-2 h-4 w-4" /> Publish now
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-11 sm:h-9"
                      onClick={() =>
                        bulkUnpublishMutation.mutate(selectedClaims, {
                          onSuccess: clearSelection,
                        })
                      }
                    >
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
                    <Trash2 className="mr-2 h-4 w-4" />{" "}
                    {showTrashed ? "Delete" : "Trash"}
                  </Button>
                ) : null}
              </>
            }
          />
        }
      />

      {dialogOpen ? (
        <Suspense fallback={null}>
          <PageDeleteDialog
            entityName="article"
            entityPlural="articles"
            showTrashed={showTrashed}
            itemCount={bulkDeleteClaims?.length ?? 1}
            isOpen={dialogOpen}
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
      ) : null}
    </div>
  );
}
