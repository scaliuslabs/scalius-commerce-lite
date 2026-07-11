import { useEffect, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Loader2, Search } from "lucide-react";
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

const PAGE_SIZE = 25;
const INHERIT = "__inherit__";

export function TaxClassificationsPanel({
  configuration,
  canManage,
}: {
  configuration: TaxConfigurationPayload;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<TaxClassificationKind>("product");
  const [page, setPage] = useState(1);
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [savingId, setSavingId] = useState<string | null>(null);

  useEffect(() => setPage(1), [kind, search]);

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
          <Tabs value={kind} onValueChange={(value) => setKind(value as TaxClassificationKind)}>
            <TabsList>
              <TabsTrigger value="product">Products</TabsTrigger>
              <TabsTrigger value="variant">SKUs</TabsTrigger>
            </TabsList>
          </Tabs>
          <form
            method="get"
            className="flex w-full max-w-md gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              setSearch(searchDraft.trim());
            }}
          >
            <Input
              value={searchDraft}
              maxLength={180}
              onChange={(event) => setSearchDraft(event.target.value)}
              placeholder={kind === "product" ? "Search product name or slug" : "Search product, SKU, or option"}
              aria-label="Search tax classifications"
            />
            <Button type="submit" variant="outline" aria-label="Search">
              <Search className="h-4 w-4" />
            </Button>
          </form>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {classificationQuery.isPending ? (
          <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : classificationQuery.isError ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">
            {getServerFnError(classificationQuery.error, "Classifications could not be loaded.")}
          </div>
        ) : classificationQuery.data.items.length === 0 ? (
          <div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">No matching {kind === "product" ? "products" : "SKUs"}.</div>
        ) : (
          <Table>
            <TableHeader><TableRow><TableHead>Catalog item</TableHead><TableHead>Current source</TableHead><TableHead className="w-[18rem]">Assigned class</TableHead></TableRow></TableHeader>
            <TableBody>
              {classificationQuery.data.items.map((item) => (
                <TableRow key={`${item.kind}:${item.id}`}>
                  <TableCell>
                    <div className="font-medium">{item.label}</div>
                    <div className="text-xs text-muted-foreground">{item.sku ? `SKU ${item.sku}` : item.productId}</div>
                  </TableCell>
                  <TableCell>
                    {item.taxClassName ? <Badge variant="outline">Explicit · {item.taxClassName}</Badge> : <Badge variant="secondary">Inherited</Badge>}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Select
                        value={item.taxClassId ?? INHERIT}
                        disabled={!canManage || savingId === item.id}
                        onValueChange={(value) => updateMutation.mutate({
                          item,
                          taxClassId: value === INHERIT ? null : value,
                        })}
                      >
                        <SelectTrigger aria-label={`Tax class for ${item.label}`}><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value={INHERIT}>{kind === "variant" ? "Inherit product/default" : "Inherit store default"}</SelectItem>
                          {configuration.classes.map((taxClass) => (
                            <SelectItem key={taxClass.id} value={taxClass.id}>{taxClass.name}{taxClass.isExempt ? " · exempt" : ""}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {savingId === item.id ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" /> : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        <div className="flex items-center justify-between border-t pt-4 text-sm text-muted-foreground">
          <span>{total.toLocaleString()} item{total === 1 ? "" : "s"}</span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" aria-label="Previous page" disabled={page <= 1 || classificationQuery.isFetching} onClick={() => setPage((current) => Math.max(1, current - 1))}><ChevronLeft className="h-4 w-4" /></Button>
            <span>Page {page} of {totalPages}</span>
            <Button variant="outline" size="icon" aria-label="Next page" disabled={page >= totalPages || classificationQuery.isFetching} onClick={() => setPage((current) => Math.min(totalPages, current + 1))}><ChevronRight className="h-4 w-4" /></Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
