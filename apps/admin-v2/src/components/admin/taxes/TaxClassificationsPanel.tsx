import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, ChevronLeft, ChevronRight, Loader2, Search } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  updateTaxClassification,
  type TaxClassificationItem,
  type TaxClassificationKind,
  type TaxConfigurationPayload,
} from "@/lib/api-functions/taxes";
import { getServerFnError } from "@/lib/api-helpers";
import { taxClassificationsQueryOptions } from "@/lib/api-query-options/taxes";
import { queryKeys } from "@/lib/query-keys";
import type { TaxClassificationRouteState } from "./tax-classification-route-state";

const PAGE_SIZE = 25;
const INHERIT = "__inherit__";

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
  const [searchDraft, setSearchDraft] = useState(search);
  const [savingId, setSavingId] = useState<string | null>(null);

  useEffect(() => setSearchDraft(search), [search]);

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
      toast.success("Tax classification updated");
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
    onRouteStateChange({ kind: nextKind, search: "", page: 1 });
  }

  function renderItemLink(item: TaxClassificationItem) {
    return (
      <Link
        to="/admin/products/$productId/edit"
        params={{ productId: item.productId }}
        aria-label={`Open ${item.label} in the product editor`}
        className="group inline-flex min-h-11 max-w-full items-center gap-1.5 font-medium text-foreground underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-0"
      >
        <span className="truncate">{item.label}</span>
        <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" aria-hidden="true" />
      </Link>
    );
  }

  function renderClassificationSelect(item: TaxClassificationItem) {
    return (
      <div className="flex items-center gap-2">
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
            className="min-h-11 min-w-0 flex-1 md:min-h-9"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={INHERIT}>
              {kind === "variant" ? "Inherit product/default" : "Inherit store default"}
            </SelectItem>
            {configuration.classes.map((taxClass) => (
              <SelectItem key={taxClass.id} value={taxClass.id}>
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
      </div>
    );
  }

  return (
    <Card>
      <CardHeader className="gap-4">
        <div>
          <CardTitle>Catalog classification</CardTitle>
          <CardDescription className="mt-1">
            A SKU class overrides its product class; a product class overrides the store default.
          </CardDescription>
        </div>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <Tabs value={kind} onValueChange={(value) => changeKind(value as TaxClassificationKind)}>
            <TabsList>
              <TabsTrigger value="product" className="min-h-11 md:min-h-9">Products</TabsTrigger>
              <TabsTrigger value="variant" className="min-h-11 md:min-h-9">SKUs</TabsTrigger>
            </TabsList>
          </Tabs>
          <form
            method="get"
            className="flex w-full max-w-md gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              onRouteStateChange({
                kind,
                search: searchDraft.trim(),
                page: 1,
              });
            }}
          >
            <Input
              value={searchDraft}
              maxLength={180}
              onChange={(event) => setSearchDraft(event.target.value)}
              placeholder={kind === "product" ? "Search product name or slug" : "Search product, SKU, or option"}
              aria-label="Search tax classifications"
              className="min-h-11 min-w-0 md:min-h-9"
            />
            <Button type="submit" variant="outline" aria-label="Search" className="min-h-11 min-w-11 md:min-h-10 md:min-w-10">
              <Search className="h-4 w-4" />
            </Button>
          </form>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {classificationQuery.isPending ? (
          <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : classificationQuery.isError ? (
          <div className="flex flex-col items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">
            <p>{getServerFnError(classificationQuery.error, "Classifications could not be loaded.")}</p>
            <Button type="button" variant="outline" className="min-h-11 md:min-h-9" onClick={() => void classificationQuery.refetch()}>
              Try again
            </Button>
          </div>
        ) : classificationQuery.data.items.length === 0 ? (
          <div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">No matching {kind === "product" ? "products" : "SKUs"}.</div>
        ) : (
          <div aria-busy={isTransitioning} className={isTransitioning ? "opacity-60" : undefined}>
            {isTransitioning ? (
              <p role="status" className="mb-2 text-xs text-muted-foreground">Loading classifications…</p>
            ) : null}

            <div className="space-y-2 md:hidden">
              {classificationQuery.data.items.map((item) => (
                <div key={`${item.kind}:${item.id}`} className="rounded-lg border bg-background p-3">
                  <div className="min-w-0">
                    {renderItemLink(item)}
                    {item.sku ? (
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">SKU {item.sku}</p>
                    ) : null}
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-2 border-t pt-3">
                    <span className="text-xs font-medium text-muted-foreground">Source</span>
                    {item.taxClassName ? (
                      <Badge variant="outline">Explicit · {item.taxClassName}</Badge>
                    ) : (
                      <Badge variant="secondary">
                        {kind === "variant" ? "Product / store default" : "Store default"}
                      </Badge>
                    )}
                  </div>
                  <div className="mt-3">
                    <p className="mb-1.5 text-xs font-medium text-muted-foreground">Assigned class</p>
                    {renderClassificationSelect(item)}
                  </div>
                </div>
              ))}
            </div>

            <div className="hidden md:block">
              <Table>
                <TableHeader><TableRow><TableHead>Catalog item</TableHead><TableHead>Current source</TableHead><TableHead className="w-[18rem]">Assigned class</TableHead></TableRow></TableHeader>
                <TableBody>
                  {classificationQuery.data.items.map((item) => (
                    <TableRow key={`${item.kind}:${item.id}`}>
                      <TableCell>
                        {renderItemLink(item)}
                        {item.sku ? <div className="text-xs text-muted-foreground">SKU {item.sku}</div> : null}
                      </TableCell>
                      <TableCell>
                        {item.taxClassName ? (
                          <Badge variant="outline">Explicit · {item.taxClassName}</Badge>
                        ) : (
                          <Badge variant="secondary">
                            {kind === "variant" ? "Product / store default" : "Store default"}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>{renderClassificationSelect(item)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}

        <div className="flex items-center justify-between border-t pt-4 text-sm text-muted-foreground">
          <span>{total.toLocaleString()} item{total === 1 ? "" : "s"}</span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" className="h-11 w-11 md:h-10 md:w-10" aria-label="Previous page" disabled={page <= 1 || classificationQuery.isFetching} onClick={() => onRouteStateChange({ kind, search, page: Math.max(1, page - 1) })}><ChevronLeft className="h-4 w-4" /></Button>
            <span>Page {page} of {totalPages}</span>
            <Button variant="outline" size="icon" className="h-11 w-11 md:h-10 md:w-10" aria-label="Next page" disabled={page >= totalPages || classificationQuery.isFetching} onClick={() => onRouteStateChange({ kind, search, page: Math.min(totalPages, page + 1) })}><ChevronRight className="h-4 w-4" /></Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
