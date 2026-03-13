// src/components/admin/attributes-manager/components/AttributeToolbar.tsx
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Search, Plus, Trash2, Undo, XCircle } from "lucide-react";
import type { AttributeToolbarProps } from "../types";

export function AttributeToolbar({
  searchQuery,
  selectedCount,
  showTrashed,
  isActionLoading,
  onSearchChange,
  onBulkTrash,
  onBulkDelete,
  onBulkRestore,
  onCreateClick,
}: AttributeToolbarProps) {
  return (
    <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
      <div className="flex-1 w-full sm:w-auto">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search attributes by name or slug..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="pl-10 max-w-sm"
          />
        </div>
      </div>
      <div className="flex items-center gap-2">
        {selectedCount > 0 && (
          <div className="flex items-center gap-2 mr-2">
            <Badge variant="secondary">{selectedCount} selected</Badge>
            {showTrashed ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onBulkRestore}
                  disabled={isActionLoading}
                >
                  <Undo className="h-4 w-4 mr-2" />
                  Restore
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={onBulkDelete}
                  disabled={isActionLoading}
                >
                  <XCircle className="h-4 w-4 mr-2" />
                  Delete
                </Button>
              </>
            ) : (
              <Button
                variant="destructive"
                size="sm"
                onClick={onBulkTrash}
                disabled={isActionLoading}
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Trash
              </Button>
            )}
          </div>
        )}
        {!showTrashed && (
          <Button onClick={onCreateClick}>
            <Plus className="h-4 w-4 mr-2" />
            Add Attribute
          </Button>
        )}
      </div>
    </div>
  );
}
