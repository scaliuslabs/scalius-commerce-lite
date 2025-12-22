// src/components/admin/pages-list/components/PageTable.tsx
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ArrowUpDown, Loader2, FileText, PlusCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { PageRow } from "./PageRow";
import type { PageItem, SortField, SortOrder } from "../types";

interface PageTableProps {
  pages: PageItem[];
  isLoading: boolean;
  selectedIds: Set<string>;
  isActionLoading: boolean;
  showTrashed: boolean;
  sortField: SortField;
  sortOrder: SortOrder;
  searchQuery: string;
  onSort: (field: SortField) => void;
  onDelete: (id: string, title: string) => void;
  onRestore: (id: string) => void;
  onPermanentDelete: (id: string, title: string) => void;
  onToggleSelection: (id: string) => void;
  onToggleSelectAll: () => void;
}

export function PageTable({
  pages,
  isLoading,
  selectedIds,
  isActionLoading,
  showTrashed,
  sortField,
  searchQuery,
  onSort,
  onDelete,
  onRestore,
  onPermanentDelete,
  onToggleSelection,
  onToggleSelectAll,
}: PageTableProps) {
  return (
    <div className="border rounded-lg overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">
              <Checkbox
                onCheckedChange={onToggleSelectAll}
                checked={
                  selectedIds.size > 0 && selectedIds.size === pages.length
                }
              />
            </TableHead>
            <TableHead>
              <Button
                variant="ghost"
                size="sm"
                className="-ml-3 h-8"
                onClick={() => onSort("title")}
              >
                Title
                <ArrowUpDown
                  className={cn(
                    "ml-2 h-4 w-4",
                    sortField === "title"
                      ? "text-primary"
                      : "text-muted-foreground",
                  )}
                />
              </Button>
            </TableHead>
            <TableHead>Slug</TableHead>
            <TableHead>
              <Button
                variant="ghost"
                size="sm"
                className="-ml-3 h-8"
                onClick={() => onSort("sortOrder")}
              >
                Sort Order
                <ArrowUpDown
                  className={cn(
                    "ml-2 h-4 w-4",
                    sortField === "sortOrder"
                      ? "text-primary"
                      : "text-muted-foreground",
                  )}
                />
              </Button>
            </TableHead>
            <TableHead>Status</TableHead>
            <TableHead>
              <Button
                variant="ghost"
                size="sm"
                className="-ml-3 h-8"
                onClick={() => onSort("updatedAt")}
              >
                Last Updated
                <ArrowUpDown
                  className={cn(
                    "ml-2 h-4 w-4",
                    sortField === "updatedAt"
                      ? "text-primary"
                      : "text-muted-foreground",
                  )}
                />
              </Button>
            </TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading ? (
            <TableRow>
              <TableCell colSpan={7} className="h-24 text-center">
                <Loader2 className="h-6 w-6 animate-spin mx-auto text-primary" />
              </TableCell>
            </TableRow>
          ) : pages.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={7}
                className="h-48 text-center text-muted-foreground"
              >
                <div className="flex flex-col items-center justify-center gap-3">
                  <FileText className="h-12 w-12 opacity-40" />
                  <div className="space-y-1">
                    <p className="font-medium text-lg">
                      {searchQuery
                        ? "No pages found"
                        : showTrashed
                          ? "Trash is empty"
                          : "No pages yet"}
                    </p>
                    <p className="text-sm">
                      {searchQuery
                        ? "Try adjusting your search query."
                        : showTrashed
                          ? "Deleted pages will appear here."
                          : "Create your first page to get started."}
                    </p>
                  </div>
                  {!showTrashed && !searchQuery && (
                    <Button asChild className="mt-2">
                      <a href="/admin/pages/new">
                        <PlusCircle className="h-4 w-4 mr-2" />
                        Create Page
                      </a>
                    </Button>
                  )}
                </div>
              </TableCell>
            </TableRow>
          ) : (
            pages.map((page) => (
              <PageRow
                key={page.id}
                page={page}
                onDelete={onDelete}
                onRestore={onRestore}
                onPermanentDelete={onPermanentDelete}
                onToggleSelection={onToggleSelection}
                isSelected={selectedIds.has(page.id)}
                isActionLoading={isActionLoading}
                showTrashed={showTrashed}
              />
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
