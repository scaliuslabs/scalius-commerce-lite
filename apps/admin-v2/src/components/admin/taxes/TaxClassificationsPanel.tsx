import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Loader2, ReceiptText } from "lucide-react";
import { toast } from "sonner";

import { EmptyState } from "~/components/admin/shell/EmptyState";
import { IndexFilters } from "~/components/admin/shell/IndexFilters";
import { IndexTable, type IndexTableColumn } from "~/components/admin/shell/IndexTable";
import { InlineHelp } from "~/components/admin/shell/InlineHelp";
import { StatusBadge } from "~/components/admin/shell/StatusBadge";
import { Button } from "~/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  updateTaxClassification,
  type TaxClassificationItem,
  type TaxClassificationKind,
  type TaxConfigurationPayload,
} from "~/lib/api-functions/taxes";
import { getServerFnError } from "~/lib/api-helpers";
import { taxClassificationsQueryOptions } from "~/lib/api-query-options/taxes";
import { queryKeys } from "~/lib/query-keys";
import type { TaxClassificationRouteState } from "./tax-classification-route-state";

const PAGE_SIZE = 25;
const INHERIT = "__inherit__";
/** The search lives in the URL, so it is committed on a pause, not per keystroke. */
const SEARCH_COMMIT_DELAY_MS = 350;

export function TaxClassificationsPanel({
  configuration,
  canManage,
  routeState,
  onRouteStateChange,
}: {
  configuration: TaxConfigurationPayload;
  canManage: boolean;
  routeState: TaxClassificationRouteState;
  onRouteStateChange: (state: TaxClassificationRouteState) => void;
}) {
  const queryClient = useQueryClient();
  const { kind, page, search } = routeState;
  const [savingId, setSavingId] = useState<string | null>(null);

  function commitSearch(value: string) {
    const next = value.trim();
    if (next === search) return;
    onRouteStateChange({ kind, search: next, page: 1 });
  }

  const queryInput = { kind, page, limit: PAGE_SIZE, ...(search ? { search } : {}) };
  const classificationQuery = useQuery({
    ...taxClassificationsQueryOptions(queryInput),
    placeholderData: keepPreviousData,
  });
  const updateMutation = useMutation({
    mutationFn: (input: { item: TaxClassificationItem; taxClassId: string | null }) => {
      setSavingId(input.item.id);
      return updateTaxClassification({ data: {
        kind: input.item.kind,
        id: input.item.id,
        taxClassId: input.taxClassId,
        expectedVersion: input.item.version,
        expectedAggregateRevision: input.item.aggregateRevision,
      } });
    },
    onSuccess: async () => {
      toast.success("Saved");
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.settings.taxClassifications(),
        }),
        queryClient.invalidateQueries({ queryKey: queryKeys.products.all }),
      ]);
    },
    onError: (error) => toast.error(getServerFnError(error, "Classification changed in another tab.")),
    onSettled: () => setSavingId(null),
  });

  const total = classificationQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const isTransitioning = classificationQuery.isFetching
    && classificationQuery.isPlaceholderData;

  useEffect(() => {
    if (
      !classificationQuery.isPending
      && !classificationQuery.isPlaceholderData
      && page > totalPages
    ) {
      onRouteStateChange({ kind, search, page: totalPages });
    }
  }, [
    classificationQuery.isPending,
    classificationQuery.isPlaceholderData,
    kind,
    onRouteStateChange,
    page,
    search,
    totalPages,
  ]);

  function changeKind(nextKind: TaxClassificationKind) {
    if (nextKind === kind) return;
    onRouteStateChange({ kind: nextKind, search: "", page: 1 });
  }

  function renderItemLink(item: TaxClassificationItem) {
    return (
      <Link
        to="/admin/products/$productId/edit"
        params={{ productId: item.productId }}
        aria-label={`Open ${item.label} in the product editor`}
        className="group inline-flex min-h-11 max-w-full items-center gap-1.5 font-medium text-foreground underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0"
      >
        <span className="truncate">{item.label}</span>
        <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" aria-hidden="true" />
      </Link>
    );
  }

  const columns: IndexTableColumn<TaxClassificationItem>[] = [
    {
      id: "item",
      header: "Catalog item",
      mobileLabel: "Item",
      cell: (item) => (
        <span className="flex min-w-0 flex-col">
          {renderItemLink(item)}
          {item.sku ? (
            <span className="truncate text-xs text-muted-foreground">SKU {item.sku}</span>
          ) : null}
        </span>
      ),
    },
    {
      id: "source",
      header: "Current source",
      mobileLabel: "Source",
      cell: (item) => (
        item.taxClassName ? (
          <StatusBadge tone="info" dot={false} srLabel="Source:">
            Explicit · {item.taxClassName}
          </StatusBadge>
        ) : (
          <StatusBadge tone="neutral" dot={false} srLabel="Source:">
            {item.kind === "variant" ? "Product / store default" : "Store default"}
          </StatusBadge>
        )
      ),
    },
    {
      id: "assigned",
      header: "Assigned class",
      mobileLabel: "Assigned class",
      className: "sm:w-[18rem]",
      headerClassName: "sm:w-[18rem]",
      cell: (item) => (
        <span className="flex items-center gap-2">
          <Select
            value={item.taxClassId ?? INHERIT}
            disabled={!canManage || updateMutation.isPending || isTransitioning}
            onValueChange={(value) => updateMutation.mutate({
              item,
              taxClassId: value === INHERIT ? null : value,
            })}
          >
            <SelectTrigger
              aria-label={`Tax class for ${item.label}`}
              className="min-h-11 min-w-0 flex-1 sm:min-h-9"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={INHERIT} className="min-h-11 sm:min-h-9">
                {item.kind === "variant" ? "Inherit product/default" : "Inherit store default"}
              </SelectItem>
              {configuration.classes.map((taxClass) => (
                <SelectItem key={taxClass.id} value={taxClass.id} className="min-h-11 sm:min-h-9">
                  {taxClass.name}{taxClass.isExempt ? " · exempt" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {savingId === item.id ? (
            <span role="status" className="shrink-0">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              <span className="sr-only">Saving classification</span>
            </span>
          ) : null}
        </span>
      ),
    },
  ];

  const items = classificationQuery.data?.items ?? [];

  return (
    <div className="space-y-4">
      <InlineHelp>
        A SKU class overrides its product class, and a product class overrides the store
        default.
      </InlineHelp>

      <IndexFilters
        label="Filter catalog classification"
        searchValue={search}
        onSearchChange={commitSearch}
        searchDebounceMs={SEARCH_COMMIT_DELAY_MS}
        searchPlaceholder={kind === "product"
          ? "Search product name or slug"
          : "Search product, SKU, or option"}
        filters={[
          { id: "product", label: "Products" },
          { id: "variant", label: "SKUs" },
        ]}
        activeFilterId={kind}
        onFilterChange={(id) => changeKind(id as TaxClassificationKind)}
      />

      {classificationQuery.isError ? (
        <div
          role="alert"
          className="flex flex-col items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
        >
          <p>{getServerFnError(classificationQuery.error, "Classifications could not be loaded.")}</p>
          <Button
            type="button"
            variant="outline"
            className="min-h-11 sm:min-h-9"
            onClick={() => void classificationQuery.refetch()}
          >
            Try again
          </Button>
        </div>
      ) : (
        <div aria-busy={isTransitioning || undefined}>
          <IndexTable
            label="Catalog tax classification"
            items={items}
            columns={columns}
            getRowId={(item) => `${item.kind}:${item.id}`}
            loading={classificationQuery.isPending}
            loadingRowCount={6}
            empty={(
              <EmptyState
                icon={ReceiptText}
                heading={kind === "product" ? "No matching products" : "No matching SKUs"}
                body={search
                  ? "Change the search to find the catalog item you want to classify."
                  : "Catalog items appear here once products are published."}
                action={search ? {
                  label: "Clear search",
                  variant: "outline",
                  onClick: () => commitSearch(""),
                } : undefined}
              />
            )}
            pagination={{
              page,
              pageSize: PAGE_SIZE,
              total,
              disabled: classificationQuery.isFetching,
              itemLabel: kind === "product" ? "products" : "SKUs",
              onPageChange: (nextPage) => onRouteStateChange({
                kind,
                search,
                page: Math.min(totalPages, Math.max(1, nextPage)),
              }),
            }}
          />
        </div>
      )}
    </div>
  );
}
