// src/components/admin/attributes-manager/components/AttributeTable.tsx
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Loader2, ArrowUpDown, Tags, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { AttributeRow } from "./AttributeRow";
import type { AttributeTableProps } from "../types";

export function AttributeTable({
  attributes,
  selectedIds,
  savingStates,
  isActionLoading,
  isLoading,
  showTrashed,
  searchQuery,
  sortField,
  onSort,
  onUpdate,
  onDelete,
  onRestore,
  onViewValues,
  onEditValues,
  onToggleSelection,
  onToggleSelectAll,
  onCreateClick,
}: AttributeTableProps) {
  return (
    <div className="border rounded-lg overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">
              <Checkbox
                onCheckedChange={onToggleSelectAll}
                checked={
                  selectedIds.size > 0 && selectedIds.size === attributes.length
                }
              />
            </TableHead>
            <TableHead>
              <Button
                variant="ghost"
                size="sm"
                className="-ml-3 h-8"
                onClick={() => onSort("name")}
              >
                Attribute Name
                <ArrowUpDown
                  className={cn(
                    "ml-2 h-4 w-4",
                    sortField === "name"
                      ? "text-primary"
                      : "text-muted-foreground",
                  )}
                />
              </Button>
            </TableHead>
            <TableHead>
              <Button
                variant="ghost"
                size="sm"
                className="-ml-3 h-8"
                onClick={() => onSort("slug")}
              >
                Slug
                <ArrowUpDown
                  className={cn(
                    "ml-2 h-4 w-4",
                    sortField === "slug"
                      ? "text-primary"
                      : "text-muted-foreground",
                  )}
                />
              </Button>
            </TableHead>
            <TableHead>
              <Button
                variant="ghost"
                size="sm"
                className="-ml-3 h-8"
                onClick={() => onSort("filterable")}
              >
                Filterable
                <ArrowUpDown
                  className={cn(
                    "ml-2 h-4 w-4",
                    sortField === "filterable"
                      ? "text-primary"
                      : "text-muted-foreground",
                  )}
                />
              </Button>
            </TableHead>
            <TableHead className="text-center">Values Used</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading ? (
            <TableRow>
              <TableCell colSpan={6} className="h-24 text-center">
                <Loader2 className="h-6 w-6 animate-spin mx-auto text-primary" />
              </TableCell>
            </TableRow>
          ) : (
            <>
              {attributes.map((attribute) => (
                <AttributeRow
                  key={attribute.id}
                  attribute={attribute}
                  onUpdate={onUpdate}
                  onDelete={() => onDelete(attribute.id, attribute.name)}
                  onRestore={() => onRestore(attribute.id)}
                  onPermanentDelete={() =>
                    onDelete(attribute.id, attribute.name)
                  }
                  onToggleSelection={() => onToggleSelection(attribute.id)}
                  onViewValues={() =>
                    onViewValues(attribute.id, attribute.name)
                  }
                  onEditValues={() =>
                    onEditValues(attribute.id, attribute.name)
                  }
                  isSelected={selectedIds.has(attribute.id)}
                  isSaving={savingStates[attribute.id]}
                  isActionLoading={isActionLoading}
                  showTrashed={showTrashed}
                />
              ))}
            </>
          )}
          {!isLoading && attributes.length === 0 && (
            <TableRow>
              <TableCell
                colSpan={6}
                className="h-48 text-center text-muted-foreground"
              >
                <div className="flex flex-col items-center justify-center gap-3">
                  <Tags className="h-12 w-12 opacity-40" />
                  <div className="space-y-1">
                    <p className="font-medium text-lg">
                      {showTrashed
                        ? "Trash is empty"
                        : searchQuery
                          ? "No attributes found"
                          : "No attributes yet"}
                    </p>
                    <p className="text-sm">
                      {showTrashed
                        ? "Deleted attributes will appear here."
                        : searchQuery
                          ? "Try adjusting your search query."
                          : "Create your first attribute to get started."}
                    </p>
                  </div>
                  {!showTrashed && !searchQuery && (
                    <Button onClick={onCreateClick} className="mt-2">
                      <Plus className="h-4 w-4 mr-2" />
                      Add Attribute
                    </Button>
                  )}
                </div>
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
