// Media filter and search bar component

import { useState } from "react";
import { Input } from "~/components/ui/input";
import { Button } from "~/components/ui/button";
import {
  Search,
  Trash2,
  FolderInput,
  CheckSquare,
  Square,
  Upload as UploadIcon,
  ArrowUpDown,
  Filter,
} from "lucide-react";
import type { MediaFilterOptions, MediaFolder } from "../types";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";

/** Sort presets map to sortBy + sortOrder params */
const SORT_OPTIONS = [
  { label: "Newest", value: "newest", sortBy: "createdAt" as const, sortOrder: "desc" as const },
  { label: "Oldest", value: "oldest", sortBy: "createdAt" as const, sortOrder: "asc" as const },
  { label: "Largest", value: "largest", sortBy: "size" as const, sortOrder: "desc" as const },
  { label: "Smallest", value: "smallest", sortBy: "size" as const, sortOrder: "asc" as const },
  { label: "Name A-Z", value: "name-asc", sortBy: "filename" as const, sortOrder: "asc" as const },
  { label: "Name Z-A", value: "name-desc", sortBy: "filename" as const, sortOrder: "desc" as const },
] as const;

const TYPE_OPTIONS = [
  { label: "All Files", value: "all", mimeType: undefined },
  { label: "Images", value: "images", mimeType: "image" },
  { label: "Videos", value: "videos", mimeType: "video" },
  { label: "Documents", value: "documents", mimeType: "application" },
] as const;

interface MediaFilterBarProps {
  filters: Partial<MediaFilterOptions>;
  onFiltersChange: (filters: Partial<MediaFilterOptions>) => void;
  selectionMode: boolean;
  selectedCount: number;
  totalCount: number;
  onToggleSelectionMode: () => void;
  onSelectAll?: () => void;
  onClearSelection?: () => void;
  onBulkDelete?: () => void;
  onAddSelected?: () => void;
  canAddSelected?: boolean;
  folders?: MediaFolder[];
  onMoveToFolder?: (folderId: string | null) => void;
  onUpload?: (files: FileList | null) => Promise<void>;
  isUploading?: boolean;
}

/** Derive the sort preset value from current filters */
function getSortValue(filters: Partial<MediaFilterOptions>): string {
  const match = SORT_OPTIONS.find(
    (o) => o.sortBy === filters.sortBy && o.sortOrder === filters.sortOrder,
  );
  return match?.value ?? "newest";
}

/** Derive the type filter value from current filters */
function getTypeValue(filters: Partial<MediaFilterOptions>): string {
  const match = TYPE_OPTIONS.find((o) => o.mimeType === filters.mimeType);
  return match?.value ?? "all";
}

export function MediaFilterBar({
  filters,
  onFiltersChange,
  selectionMode,
  selectedCount,
  totalCount,
  onToggleSelectionMode,
  onSelectAll,
  onBulkDelete,
  onAddSelected,
  canAddSelected = false,
  folders = [],
  onMoveToFolder,
  onUpload,
  isUploading = false,
}: MediaFilterBarProps) {
  const [moveToFolderId, setMoveToFolderId] = useState<string>("");
  const [searchExpanded, setSearchExpanded] = useState(false);

  const handleMoveToFolder = () => {
    if (onMoveToFolder) {
      onMoveToFolder(moveToFolderId === "root" ? null : moveToFolderId);
      setMoveToFolderId("");
    }
  };

  const handleUploadClick = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = "image/*";
    input.onchange = async (e) => {
      const target = e.target as HTMLInputElement;
      if (target.files && target.files.length > 0 && onUpload) {
        await onUpload(target.files);
      }
    };
    input.click();
  };

  return (
    <div className="min-w-0 space-y-2">
      {/* Top bar with actions */}
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {/* Upload Button */}
          {onUpload && (
            <Button type="button"
              variant="default"
              size="sm"
              onClick={handleUploadClick}
              disabled={isUploading}
              className="h-8 shrink-0"
              title="Upload files (Max 20 files, 10MB each)"
            >
              <UploadIcon className="h-3.5 w-3.5 mr-1.5" />
              Upload
            </Button>
          )}

          {/* Search Toggle */}
          <Button type="button"
            variant="outline"
            size="sm"
            onClick={() => setSearchExpanded(!searchExpanded)}
            className="h-8 shrink-0"
          >
            <Search className="h-3.5 w-3.5" />
          </Button>

          {/* Sort Dropdown */}
          <Select
            value={getSortValue(filters)}
            onValueChange={(value) => {
              const opt = SORT_OPTIONS.find((o) => o.value === value);
              if (opt) {
                onFiltersChange({ ...filters, sortBy: opt.sortBy, sortOrder: opt.sortOrder });
              }
            }}
          >
            <SelectTrigger className="h-8 min-w-[112px] flex-1 text-xs sm:w-[120px] sm:flex-none">
              <ArrowUpDown className="h-3 w-3 mr-1 shrink-0" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORT_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Type Filter */}
          <Select
            value={getTypeValue(filters)}
            onValueChange={(value) => {
              const opt = TYPE_OPTIONS.find((o) => o.value === value);
              onFiltersChange({ ...filters, mimeType: opt?.mimeType });
            }}
          >
            <SelectTrigger className="h-8 min-w-[112px] flex-1 text-xs sm:w-[120px] sm:flex-none">
              <Filter className="h-3 w-3 mr-1 shrink-0" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TYPE_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Selection Mode Toggle - NO NESTED BUTTONS */}
          <Button type="button"
            variant={selectionMode ? "default" : "outline"}
            size="sm"
            onClick={onToggleSelectionMode}
            className="h-8 shrink-0 items-center gap-1.5"
          >
            {selectionMode ? (
              <>
                <CheckSquare className="h-3.5 w-3.5" />
                <span className="text-xs">Exit</span>
              </>
            ) : (
              <>
                <Square className="h-3.5 w-3.5" />
                <span className="text-xs">Select</span>
              </>
            )}
          </Button>

          {selectionMode && (
            <>
              <span className="text-xs text-muted-foreground">
                {selectedCount > 0
                  ? `${selectedCount} selected`
                  : "None selected"}
              </span>
              {onSelectAll && selectedCount < totalCount && (
                <Button type="button"
                  variant="ghost"
                  size="sm"
                  onClick={onSelectAll}
                  className="h-8 text-xs"
                >
                  Select All
                </Button>
              )}
            </>
          )}
        </div>

        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {selectionMode && selectedCount > 0 && (
            <>
              {onMoveToFolder && folders.length > 0 && (
                <div className="flex min-w-0 flex-wrap items-center gap-1">
                  <Select
                    value={moveToFolderId}
                    onValueChange={setMoveToFolderId}
                  >
                    <SelectTrigger className="h-8 min-w-[132px] flex-1 text-xs sm:w-[140px] sm:flex-none">
                      <SelectValue placeholder="Move to..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="root">📁 Uncategorized</SelectItem>
                      {folders.map((folder) => (
                        <SelectItem key={folder.id} value={folder.id}>
                          📂 {folder.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleMoveToFolder}
                    disabled={!moveToFolderId}
                    className="h-8 shrink-0"
                  >
                    <FolderInput className="h-3.5 w-3.5" />
                  </Button>
                </div>
              )}
              {canAddSelected && onAddSelected && (
                <Button type="button"
                  variant="default"
                  size="sm"
                  onClick={onAddSelected}
                  className="h-8 shrink-0 text-xs"
                >
                  Add ({selectedCount})
                </Button>
              )}
              {onBulkDelete && (
                <Button type="button"
                  variant="destructive"
                  size="sm"
                  onClick={onBulkDelete}
                  className="h-8 shrink-0"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Expandable Search */}
      {searchExpanded && (
        <div className="relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
          <Input
            type="text"
            placeholder="Search files..."
            value={filters.search || ""}
            onChange={(e) =>
              onFiltersChange({ ...filters, search: e.target.value })
            }
            className="pl-9 h-8 text-sm"
            autoFocus
          />
        </div>
      )}
    </div>
  );
}
