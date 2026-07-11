// src/components/admin/attributes-manager/components/AttributeValuesViewer.tsx
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { Input } from "~/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import {
  AlertTriangle,
  Loader2,
  Search,
  Package,
  RefreshCw,
  X,
} from "lucide-react";
import type { AttributeValuesViewerProps, AttributeValue } from "../types";
import { attributeValuesQueryOptions } from "~/lib/api-query-options/attributes";
import { useDebounce } from "~/hooks/use-debounce";
import { AdminListPagination } from "~/components/admin/shared/AdminListPagination";

const ATTRIBUTE_VALUES_PAGE_SIZE = 20;

export function AttributeValuesViewer({
  attributeId,
  attributeName,
  onClose,
}: AttributeValuesViewerProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const debouncedSearch = useDebounce(searchQuery.trim(), 300);

  const valuesQuery = useQuery({
    ...attributeValuesQueryOptions({
      attributeId: attributeId ?? undefined,
      page,
      limit: ATTRIBUTE_VALUES_PAGE_SIZE,
      search: debouncedSearch || undefined,
    }),
    enabled: Boolean(attributeId),
  });

  const values: AttributeValue[] = valuesQuery.data?.values ?? [];
  const isLoading = Boolean(attributeId) && valuesQuery.isPending;

  useEffect(() => {
    setSearchQuery("");
    setPage(1);
  }, [attributeId]);

  useEffect(() => {
    const totalPages = valuesQuery.data?.totalPages ?? 0;
    if (totalPages > 0 && page > totalPages) setPage(totalPages);
  }, [page, valuesQuery.data?.totalPages]);

  const totalValues = valuesQuery.data?.totalValues ?? 0;
  const totalProducts = valuesQuery.data?.totalProducts ?? 0;

  return (
    <Dialog open={!!attributeId} onOpenChange={onClose}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Package className="h-5 w-5" />
            {attributeName} - Values & Usage
          </DialogTitle>
          <DialogDescription>
            View all unique values for this attribute and the products using
            them.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 flex-1 overflow-hidden flex flex-col">
          {/* Statistics */}
          <div className="flex gap-3 shrink-0">
            <div className="flex-1 p-3 border rounded-lg">
              <div className="text-sm text-muted-foreground">Unique Values</div>
              <div className="text-2xl font-bold">
                {isLoading || valuesQuery.isError ? "-" : totalValues}
              </div>
            </div>
            <div className="flex-1 p-3 border rounded-lg">
              <div className="text-sm text-muted-foreground">
                Total Products
              </div>
              <div className="text-2xl font-bold">
                {isLoading || valuesQuery.isError ? "-" : totalProducts}
              </div>
            </div>
          </div>

          {/* Search */}
          <div className="relative shrink-0">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search values..."
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setPage(1);
              }}
              className="pl-10"
              aria-label="Search attribute values"
            />
          </div>

          {/* Values Table - Fixed height container */}
          <div className="border rounded-lg overflow-hidden flex-1 min-h-0 flex flex-col">
            {isLoading ? (
              <div className="flex items-center justify-center flex-1">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
              </div>
            ) : valuesQuery.isError ? (
              <div className="flex flex-col items-center justify-center flex-1 text-center px-6">
                <AlertTriangle className="h-10 w-10 text-destructive/70 mb-2" />
                <p className="text-sm font-medium">Could not load attribute values</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Retry to load the current page. An outage is never shown as an empty catalog.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() => void valuesQuery.refetch()}
                >
                  <RefreshCw className="h-4 w-4 mr-2" />
                  Retry
                </Button>
              </div>
            ) : values.length > 0 ? (
              <div className="flex-1 overflow-auto">
                <Table>
                  <TableHeader className="sticky top-0 bg-background z-10">
                    <TableRow>
                      <TableHead className="bg-muted/50">Value</TableHead>
                      <TableHead className="text-center bg-muted/50">
                        Products
                      </TableHead>
                      <TableHead className="bg-muted/50">
                        Example Products
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {values.map((item) => (
                      <TableRow key={item.value}>
                        <TableCell className="font-medium">
                          {item.value}
                        </TableCell>
                        <TableCell className="text-center">
                          <Badge variant="secondary">{item.productCount}</Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            {(item.sampleProducts || [])
                              .slice(0, 3)
                              .map((name, idx) => (
                                <Badge
                                  key={idx}
                                  variant="outline"
                                  className="text-xs"
                                >
                                  {name}
                                </Badge>
                              ))}
                            {(item.sampleProducts || []).length > 3 && (
                              <Badge variant="outline" className="text-xs">
                                +{(item.sampleProducts || []).length - 3} more
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center flex-1 text-center">
                <Package className="h-10 w-10 opacity-40 mb-2" />
                <p className="text-sm text-muted-foreground">
                  {searchQuery
                    ? "No values match your search"
                    : "No values found for this attribute"}
                </p>
              </div>
            )}
            {!valuesQuery.isError &&
              valuesQuery.data &&
              valuesQuery.data.totalValues > 0 && (
                <AdminListPagination
                  pagination={{
                    total: valuesQuery.data.totalValues,
                    page: valuesQuery.data.page,
                    limit: valuesQuery.data.limit,
                    totalPages: valuesQuery.data.totalPages,
                  }}
                  itemLabel="values"
                  onPageChange={setPage}
                />
              )}
          </div>

          <div className="flex justify-end shrink-0">
            <Button variant="outline" onClick={onClose}>
              <X className="h-4 w-4 mr-2" />
              Close
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
