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
  openerRef,
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
      <DialogContent
        className="max-w-3xl overflow-y-auto flex flex-col"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          requestAnimationFrame(() => {
            if (openerRef.current?.isConnected) openerRef.current.focus();
          });
        }}
      >
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex min-w-0 items-center gap-2 pr-8 [overflow-wrap:anywhere]">
            <Package className="h-5 w-5 shrink-0" />
            {attributeName} - Values & Usage
          </DialogTitle>
          <DialogDescription>
            View all unique values for this attribute and the products using
            them.
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 min-w-0 flex-1 grid-rows-[auto_auto_minmax(16rem,1fr)_auto] gap-4">
          {/* Statistics */}
          <p className="text-sm text-muted-foreground">
            Unique values: <span className="font-medium text-foreground">{isLoading || valuesQuery.isError ? "-" : totalValues}</span>
            {" · "}
            Products: <span className="font-medium text-foreground">{isLoading || valuesQuery.isError ? "-" : totalProducts}</span>
          </p>

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

          {/* Values Table */}
          <div className="border rounded-lg overflow-hidden min-h-0 min-w-0 flex flex-col">
            {isLoading ? (
              <div className="flex items-center justify-center flex-1">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
              </div>
            ) : valuesQuery.isError ? (
              <div className="flex min-h-0 flex-1 flex-col items-center overflow-auto px-6 py-4 text-center [justify-content:safe_center]">
                <AlertTriangle className="h-10 w-10 shrink-0 text-destructive/70 mb-2" />
                <p className="text-sm font-medium">Could not load attribute values</p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-3 shrink-0"
                  onClick={() => void valuesQuery.refetch()}
                >
                  <RefreshCw className="h-4 w-4 mr-2" />
                  Retry
                </Button>
              </div>
            ) : values.length > 0 ? (
              <div className="min-h-0 flex-1 overflow-auto">
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
                        <TableCell className="font-medium [overflow-wrap:anywhere]">
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
              <div className="flex min-h-0 flex-1 flex-col items-center overflow-auto p-4 text-center [justify-content:safe_center]">
                <Package className="h-10 w-10 shrink-0 opacity-40 mb-2" />
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
