import { useMemo, useCallback } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { LayoutDashboard, Trash2 } from "lucide-react";
import { Button } from "~/components/ui/button";
import {
  DEFAULT_LIST_MAX_LIMIT,
  normalizeListPositiveInteger,
  normalizeSearchString,
  type SearchValidatorInput,
} from "~/lib/list-helpers";
import { widgetsQueryOptions } from "~/lib/api-query-options/widgets";
import { warmRouteQuery } from "~/lib/route-query-warming";
import {
  useDeleteWidget,
  usePermanentDeleteWidget,
  useRestoreWidget,
  useBulkDeleteWidgets,
} from "~/lib/api-mutations/widgets";
import {
  DataTable,
  DataTableToolbar,
  useServerTable,
} from "~/components/admin/data-table";
import { getWidgetColumns } from "~/components/admin/data-table/columns/widget-columns";
import type { Widget, WidgetListResponse } from "~/types/api-responses";
import { RouteErrorComponent } from "~/lib/route-error";

type WidgetTrashSearchParams = {
  page: number;
  limit: number;
  search: string;
};

function validateWidgetTrashSearch(
  search: SearchValidatorInput<WidgetTrashSearchParams>,
): WidgetTrashSearchParams {
  return {
    page: normalizeListPositiveInteger(search.page, 1),
    limit: normalizeListPositiveInteger(search.limit, 10, {
      max: DEFAULT_LIST_MAX_LIMIT,
    }),
    search: normalizeSearchString(search.search),
  };
}

export const Route = createFileRoute("/admin/widgets/trash")({
  validateSearch: validateWidgetTrashSearch,
  loaderDeps: ({ search }) => search,
  staleTime: 1000 * 60 * 2,
  loader: async ({ context: { queryClient }, deps }) => {
    await warmRouteQuery(queryClient, widgetsQueryOptions({
      showTrashed: true,
      search: deps.search || undefined,
    }));
  },
  head: () => ({ meta: [{ title: "Widget Trash | Scalius Admin" }] }),
  errorComponent: RouteErrorComponent,
  component: WidgetsTrashPage,
});

function WidgetsTrashPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();

  // Mutations
  const deleteMutation = useDeleteWidget();
  const permanentDeleteMutation = usePermanentDeleteWidget();
  const restoreMutation = useRestoreWidget();
  const bulkDeleteMutation = useBulkDeleteWidgets();

  const metadataRef = useMemo(
    () => ({
      collections: new Map<string, string>(),
      pages: new Map<string, string>(),
      products: new Map<string, string>(),
      categories: new Map<string, string>(),
    }),
    [],
  );

  // Column definitions
  const columns = useMemo(
    () =>
      getWidgetColumns({
        showTrashed: true,
        getCollectionName: (id) => metadataRef.collections.get(id) ?? null,
        getPageTitle: (id) => metadataRef.pages.get(id) ?? null,
        getProductName: (id) => metadataRef.products.get(id) ?? null,
        getCategoryName: (id) => metadataRef.categories.get(id) ?? null,
        onEdit: (id) =>
          void navigate({ to: `/admin/widgets/${id}` as string }),
        onDelete: (id) => deleteMutation.mutate(id),
        onRestore: (id) => restoreMutation.mutate(id),
        onPermanentDelete: (id) => permanentDeleteMutation.mutate(id),
        onCopyShortcode: () => {},
      }),
    [navigate, deleteMutation, permanentDeleteMutation, restoreMutation, metadataRef],
  );

  // Data selector — client-side pagination for widgets
  const dataSelector = useCallback(
    (raw: unknown) => {
      const r = raw as WidgetListResponse;
      const allWidgets = (r.widgets ?? []) as Widget[];
      metadataRef.collections = new Map(
        (r.availableCollections ?? []).map((collection) => [collection.id, collection.name]),
      );
      metadataRef.pages = new Map(
        (r.availablePages ?? []).map((page) => [page.id, page.title]),
      );
      metadataRef.products = new Map(
        (r.referencedProducts ?? []).map((product) => [product.id, product.name]),
      );
      metadataRef.categories = new Map(
        (r.referencedCategories ?? []).map((category) => [category.id, category.name]),
      );

      const filtered = search.search
        ? allWidgets.filter((w) =>
            w.name.toLowerCase().includes(search.search.toLowerCase()),
          )
        : allWidgets;

      const total = filtered.length;
      const totalPages = Math.max(1, Math.ceil(total / search.limit));
      const safePage = Math.min(search.page, totalPages);
      const sliced = filtered.slice(
        (safePage - 1) * search.limit,
        safePage * search.limit,
      );

      return {
        data: sliced,
        pagination: { total, page: safePage, limit: search.limit, totalPages },
      };
    },
    [search.search, search.page, search.limit, metadataRef],
  );

  const { table, isFetching, isLoading, selectedIds, clearSelection } =
    useServerTable({
      columns,
      queryOptions: widgetsQueryOptions({
        search: search.search || undefined,
        showTrashed: true,
      }) as never,
      dataSelector,
      currentPage: search.page,
      currentLimit: search.limit,
      onPaginationChange: (page, limit) =>
        void navigate({
          search: ((prev: Record<string, unknown>) => ({ ...prev, page, limit })) as never,
        }),
      onSortingChange: () => {},
    });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Widget Trash</h1>
          <p className="text-muted-foreground">
            View, restore, or permanently delete trashed widgets.
          </p>
        </div>
        <Link to="/admin/widgets">
          <Button variant="outline" size="sm">
            <LayoutDashboard className="mr-2 h-4 w-4" />
            View Active
          </Button>
        </Link>
      </div>

      <DataTable
        table={table}
        isFetching={isFetching}
        isLoading={isLoading}
        itemLabel="widgets"
        emptyState={{
          icon: LayoutDashboard,
          title: "Trash is empty",
          description: "Deleted widgets will appear here.",
        }}
        toolbar={
          <DataTableToolbar
            searchValue={search.search}
            onSearchChange={(value) =>
              void navigate({
                search: ((prev: Record<string, unknown>) => ({ ...prev, search: value, page: 1 })) as never,
              })
            }
            searchPlaceholder="Search trashed widgets..."
            selectedCount={selectedIds.length}
            bulkActions={
              <Button
                variant="outline"
                size="sm"
                className="text-destructive border-destructive hover:bg-destructive/10"
                onClick={() => {
                  bulkDeleteMutation.mutate(
                    {
                      ids: selectedIds,
                      permanent: true,
                    },
                    { onSuccess: clearSelection },
                  );
                }}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Delete ({selectedIds.length})
              </Button>
            }
          />
        }
      />
    </div>
  );
}
