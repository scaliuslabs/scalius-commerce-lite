// src/components/admin/pages-list/components/PageToolbar.tsx
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Search, Trash2, RotateCw, FileCheck, FileX } from "lucide-react";
import type { BulkAction } from "../types";

interface PageToolbarProps {
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  selectedIds: Set<string>;
  showTrashed: boolean;
  setBulkAction: (action: BulkAction) => void;
  isActionLoading: boolean;
}

export function PageToolbar({
  searchQuery,
  setSearchQuery,
  selectedIds,
  showTrashed,
  setBulkAction,
  isActionLoading,
}: PageToolbarProps) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="relative flex-1 max-w-sm">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          type="search"
          placeholder="Search pages..."
          className="pl-8"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>

      {selectedIds.size > 0 && (
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">
            {selectedIds.size} selected
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" disabled={isActionLoading}>
                Bulk Actions
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {showTrashed ? (
                <>
                  <DropdownMenuItem onClick={() => setBulkAction("restore")}>
                    <RotateCw className="mr-2 h-4 w-4" />
                    Restore Selected
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => setBulkAction("delete")}
                    className="text-destructive"
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Delete Permanently
                  </DropdownMenuItem>
                </>
              ) : (
                <>
                  <DropdownMenuItem onClick={() => setBulkAction("publish")}>
                    <FileCheck className="mr-2 h-4 w-4" />
                    Publish Selected
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setBulkAction("unpublish")}>
                    <FileX className="mr-2 h-4 w-4" />
                    Unpublish Selected
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => setBulkAction("trash")}
                    className="text-destructive"
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Move to Trash
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </div>
  );
}
