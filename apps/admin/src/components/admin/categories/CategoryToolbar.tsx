import React from "react";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Search, Trash2, Undo, X } from "lucide-react";
import { cn } from "@scalius/shared/utils";

interface CategoryToolbarProps {
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  localSearch: string;
  onLocalSearchChange: (value: string) => void;
  onSearch: (e?: React.SyntheticEvent) => void;
  hasActiveFilters: boolean;
  onClearFilters: () => void;
  selectedCount: number;
  showTrashed: boolean;
  isActionLoading: boolean;
  onBulkDelete: () => void;
  onBulkRestore: () => void;
}

export const CategoryToolbar = React.memo(function CategoryToolbar({
  searchInputRef,
  localSearch,
  onLocalSearchChange,
  onSearch,
  hasActiveFilters,
  onClearFilters,
  selectedCount,
  showTrashed,
  isActionLoading,
  onBulkDelete,
  onBulkRestore,
}: CategoryToolbarProps) {
  return (
    <div className="p-2 sm:p-3 space-y-2">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
        <div className="flex flex-1 items-center w-full sm:w-auto space-x-1.5">
          <div className="text-xs text-muted-foreground bg-muted/50 px-2 py-1 rounded-md border border-border/50 shrink-0">
            Press{" "}
            <kbd className="px-1.5 py-0.5 bg-background border border-border rounded text-xs font-mono">
              /
            </kbd>{" "}
            to search
          </div>
          <form
            onSubmit={onSearch}
            className="flex-1 sm:flex-initial sm:max-w-xs w-full"
          >
            <div className="relative">
              <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                ref={searchInputRef}
                type="search"
                placeholder="Search categories..."
                value={localSearch}
                onChange={(e) => onLocalSearchChange(e.target.value)}
                className="pl-7 h-7 w-full text-sm"
              />
            </div>
          </form>
          {hasActiveFilters && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-1.5 text-xs text-muted-foreground"
              onClick={onClearFilters}
            >
              <X className="h-3.5 w-3.5 mr-1" />
              Clear
            </Button>
          )}
        </div>
        <div
          className={cn(
            "transition-opacity duration-200 flex items-center gap-2",
            selectedCount > 0
              ? "opacity-100"
              : "opacity-0 pointer-events-none h-0 overflow-hidden sm:h-auto sm:opacity-100 sm:pointer-events-auto",
            selectedCount === 0 && "sm:min-w-[90px]",
          )}
        >
          {selectedCount > 0 ? (
            showTrashed ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-sm font-medium"
                  onClick={onBulkRestore}
                  disabled={isActionLoading}
                >
                  <Undo className="h-3.5 w-3.5 mr-1" />
                  Restore ({selectedCount})
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-sm font-medium text-destructive border-destructive hover:bg-destructive/10"
                  onClick={onBulkDelete}
                  disabled={isActionLoading}
                >
                  <Trash2 className="h-3.5 w-3.5 mr-1" />
                  Delete ({selectedCount})
                </Button>
              </>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-sm font-medium text-destructive border-destructive hover:bg-destructive/10"
                onClick={onBulkDelete}
                disabled={isActionLoading}
              >
                <Trash2 className="h-3.5 w-3.5 mr-1" />
                Trash ({selectedCount})
              </Button>
            )
          ) : (
            <div className="h-7" />
          )}
        </div>
      </div>
    </div>
  );
});
