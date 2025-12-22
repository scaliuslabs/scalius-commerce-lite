// Media filter and search bar component

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Search,
  Trash2,
  FolderInput,
  CheckSquare,
  Square,
  Upload as UploadIcon,
} from "lucide-react";
import type { MediaFilterOptions, MediaFolder } from "../types";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

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
    <div className="space-y-2">
      {/* Top bar with actions */}
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-2">
          {/* Upload Button */}
          {onUpload && (
            <Button
              variant="default"
              size="sm"
              onClick={handleUploadClick}
              disabled={isUploading}
              className="h-8"
              title="Upload files (Max 20 files, 10MB each)"
            >
              <UploadIcon className="h-3.5 w-3.5 mr-1.5" />
              Upload
            </Button>
          )}

          {/* Search Toggle */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setSearchExpanded(!searchExpanded)}
            className="h-8"
          >
            <Search className="h-3.5 w-3.5" />
          </Button>

          {/* Selection Mode Toggle - NO NESTED BUTTONS */}
          <Button
            variant={selectionMode ? "default" : "outline"}
            size="sm"
            onClick={onToggleSelectionMode}
            className="flex items-center gap-1.5 h-8"
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
                <Button
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

        <div className="flex items-center gap-1.5">
          {selectionMode && selectedCount > 0 && (
            <>
              {onMoveToFolder && folders.length > 0 && (
                <div className="flex items-center gap-1">
                  <Select
                    value={moveToFolderId}
                    onValueChange={setMoveToFolderId}
                  >
                    <SelectTrigger className="h-8 w-[140px] text-xs">
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
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleMoveToFolder}
                    disabled={!moveToFolderId}
                    className="h-8"
                  >
                    <FolderInput className="h-3.5 w-3.5" />
                  </Button>
                </div>
              )}
              {canAddSelected && onAddSelected && (
                <Button
                  variant="default"
                  size="sm"
                  onClick={onAddSelected}
                  className="h-8 text-xs"
                >
                  Add ({selectedCount})
                </Button>
              )}
              {onBulkDelete && (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={onBulkDelete}
                  className="h-8"
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
