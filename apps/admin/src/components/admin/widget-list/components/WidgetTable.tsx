// src/components/admin/widget-list/components/WidgetTable.tsx
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
import { Loader2, LayoutDashboard, Plus } from "lucide-react";
import { WidgetRow } from "./WidgetRow";
import type { WidgetTableProps } from "../types";

export function WidgetTable({
  widgets,
  collections,
  selectedIds,
  savingStates,
  isActionLoading,
  isLoading,
  showTrashed,
  searchQuery,
  onUpdate,
  onDelete,
  onRestore,
  onToggleSelection,
  onToggleSelectAll,
  onCreateClick,
  onCopyShortcode,
}: WidgetTableProps) {
  return (
    <div className="border rounded-lg overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">
              <Checkbox
                onCheckedChange={onToggleSelectAll}
                checked={
                  selectedIds.size > 0 && selectedIds.size === widgets.length
                }
              />
            </TableHead>
            <TableHead>Widget Name</TableHead>
            <TableHead>Placement</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-center">Order</TableHead>
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
              {widgets.map((widget) => (
                <WidgetRow
                  key={widget.id}
                  widget={widget}
                  collections={collections}
                  onUpdate={onUpdate}
                  onDelete={() => onDelete(widget.id, widget.name)}
                  onRestore={() => onRestore(widget.id)}
                  onPermanentDelete={() => onDelete(widget.id, widget.name)}
                  onToggleSelection={() => onToggleSelection(widget.id)}
                  onCopyShortcode={() => onCopyShortcode(widget.id)}
                  isSelected={selectedIds.has(widget.id)}
                  isSaving={savingStates[widget.id]}
                  isActionLoading={isActionLoading}
                  showTrashed={showTrashed}
                />
              ))}
            </>
          )}
          {!isLoading && widgets.length === 0 && (
            <TableRow>
              <TableCell
                colSpan={6}
                className="h-48 text-center text-muted-foreground"
              >
                <div className="flex flex-col items-center justify-center gap-3">
                  <LayoutDashboard className="h-12 w-12 opacity-40" />
                  <div className="space-y-1">
                    <p className="font-medium text-lg">
                      {searchQuery
                        ? "No widgets found"
                        : showTrashed
                          ? "Trash is empty"
                          : "No widgets yet"}
                    </p>
                    <p className="text-sm">
                      {searchQuery
                        ? "Try adjusting your search query."
                        : showTrashed
                          ? "Deleted widgets will appear here."
                          : "Create your first widget to get started."}
                    </p>
                  </div>
                  {!searchQuery && !showTrashed && (
                    <Button onClick={onCreateClick} className="mt-2">
                      <Plus className="h-4 w-4 mr-2" />
                      New Widget
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

