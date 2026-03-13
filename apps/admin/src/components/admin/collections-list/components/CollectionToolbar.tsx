// src/components/admin/collections-list/components/CollectionToolbar.tsx
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Search, Trash2, Undo, XCircle, Eye, EyeOff } from "lucide-react";
import type { CollectionToolbarProps } from "../types";

export function CollectionToolbar({
  searchQuery,
  selectedCount,
  showTrashed,
  isActionLoading,
  onSearchChange,
  onBulkTrash,
  onBulkDelete,
  onBulkRestore,
  onBulkActivate,
  onBulkDeactivate,
}: CollectionToolbarProps) {
  return (
    <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
      <div className="flex-1 w-full sm:w-auto">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search collections by name..."
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
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onBulkActivate}
                  disabled={isActionLoading}
                >
                  <Eye className="h-4 w-4 mr-2" />
                  Activate
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onBulkDeactivate}
                  disabled={isActionLoading}
                >
                  <EyeOff className="h-4 w-4 mr-2" />
                  Deactivate
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={onBulkTrash}
                  disabled={isActionLoading}
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Trash
                </Button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
