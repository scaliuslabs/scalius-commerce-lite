// Folder browser sidebar component

import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Folder, FolderPlus, Home, Trash2 } from "lucide-react";
import type { MediaFolder } from "../types";
import { cn } from "@scalius/shared/utils";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { useIsMobile } from "@/hooks/use-mobile";

// Generate consistent color for each folder based on ID
function getFolderColor(folderId: string): string {
  const colors = [
    "text-blue-500",
    "text-green-500",
    "text-purple-500",
    "text-orange-500",
    "text-pink-500",
    "text-cyan-500",
    "text-indigo-500",
    "text-rose-500",
    "text-amber-500",
    "text-emerald-500",
    "text-violet-500",
    "text-fuchsia-500",
    "text-lime-500",
    "text-teal-500",
    "text-sky-500",
  ];

  // Simple hash function to get consistent color index
  let hash = 0;
  for (let i = 0; i < folderId.length; i++) {
    hash = folderId.charCodeAt(i) + ((hash << 5) - hash);
  }
  const index = Math.abs(hash) % colors.length;
  return colors[index];
}

interface FolderBrowserProps {
  folders: MediaFolder[];
  currentFolderId: string | null;
  onFolderSelect: (folderId: string | null) => void;
  onFolderCreate: (
    name: string,
    parentId?: string | null,
  ) => Promise<MediaFolder | void>;
  onFolderDelete: (folderId: string) => Promise<void>;
  className?: string;
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
}

export function FolderBrowser({
  folders,
  currentFolderId,
  onFolderSelect,
  onFolderCreate,
  onFolderDelete,
  className = "",
  isCollapsed = false,
  onToggleCollapse,
}: FolderBrowserProps) {
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [deleteDialogFolderId, setDeleteDialogFolderId] = useState<
    string | null
  >(null);
  const [folderSearch, setFolderSearch] = useState("");
  const isMobile = useIsMobile();
  const showCollapsed = isCollapsed && !isMobile;

  const filteredFolders = folders.filter((f) =>
    f.name.toLowerCase().includes(folderSearch.toLowerCase()),
  );

  const handleCreateFolder = async () => {
    if (!newFolderName.trim()) return;

    setIsCreating(true);
    try {
      await onFolderCreate(newFolderName.trim(), currentFolderId);
      setNewFolderName("");
      setShowCreateDialog(false);
    } catch {
      // Error is handled in the hook
    } finally {
      setIsCreating(false);
    }
  };

  const handleDeleteFolder = async () => {
    if (!deleteDialogFolderId) return;

    try {
      await onFolderDelete(deleteDialogFolderId);
      setDeleteDialogFolderId(null);
    } catch {
      // Error is handled in the hook
    }
  };

  return (
    <>
      <div
        className={cn(
          "relative flex h-auto max-h-64 min-w-0 flex-col border-b bg-muted/30 transition-all md:h-full md:max-h-none md:border-b-0 md:border-r",
          className,
          showCollapsed && "md:w-12",
        )}
      >
        {/* Collapse/Expand Toggle */}
        {onToggleCollapse && (
          <Button type="button"
            variant="ghost"
            size="icon"
            className="absolute -right-3 top-4 z-10 hidden h-6 w-6 rounded-full border bg-background shadow-sm md:inline-flex"
            onClick={onToggleCollapse}
          >
            {showCollapsed ? (
              <ChevronRight className="h-4 w-4" />
            ) : (
              <ChevronLeft className="h-4 w-4" />
            )}
          </Button>
        )}

        {!showCollapsed ? (
          <>
            <div className="p-3 border-b space-y-3 shrink-0">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-sm">Folders</h3>
              </div>
              <Button type="button"
                variant="outline"
                size="sm"
                className="w-full justify-start h-8"
                onClick={() => setShowCreateDialog(true)}
              >
                <FolderPlus className="mr-2 h-3.5 w-3.5" />
                New Folder
              </Button>
              <Input
                placeholder="Filter folders..."
                className="h-8 text-xs"
                value={folderSearch}
                onChange={(e) => setFolderSearch(e.target.value)}
              />
            </div>

            <div className="flex-1 overflow-hidden">
              <ScrollArea className="h-full">
                <div className="p-2 pb-4">
                  {/* All Files - shows files from all folders */}
                  {!folderSearch && (
                    <>
                      <Button type="button"
                        variant={
                          currentFolderId === "all" ? "secondary" : "ghost"
                        }
                        size="sm"
                        className="w-full justify-start mb-1 h-8 px-2"
                        onClick={() => onFolderSelect("all")}
                      >
                        <Home className="mr-2 h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">All Files</span>
                      </Button>

                      {/* Root folder - files not in any folder */}
                      <Button type="button"
                        variant={
                          currentFolderId === null ? "secondary" : "ghost"
                        }
                        size="sm"
                        className="w-full justify-start mb-1 h-8 px-2"
                        onClick={() => onFolderSelect(null)}
                      >
                        <Folder className="mr-2 h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">Uncategorized</span>
                      </Button>
                    </>
                  )}

                  {/* Folder list */}
                  {filteredFolders.map((folder) => (
                    <div
                      key={folder.id}
                      className="group flex items-center gap-1 mb-1 pr-1"
                    >
                      <Button type="button"
                        variant={
                          currentFolderId === folder.id ? "secondary" : "ghost"
                        }
                        size="sm"
                        className="flex-1 justify-start h-8 min-w-0 px-2"
                        onClick={() => onFolderSelect(folder.id)}
                      >
                        <Folder
                          className={cn(
                            "mr-2 h-3.5 w-3.5 shrink-0",
                            getFolderColor(folder.id),
                          )}
                        />
                        <span className="truncate text-left text-xs">
                          {folder.name}
                        </span>
                      </Button>
                      <Button type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity focus:opacity-100"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteDialogFolderId(folder.id);
                        }}
                        title="Delete Folder"
                      >
                        <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      </Button>
                    </div>
                  ))}

                  {filteredFolders.length === 0 && folderSearch && (
                    <div className="text-xs text-muted-foreground text-center py-4">
                      No folders found
                    </div>
                  )}
                </div>
              </ScrollArea>
            </div>
          </>
        ) : (
          <div className="p-2 flex flex-col items-center gap-2 pt-16">
            <Button type="button"
              variant={currentFolderId === "all" ? "secondary" : "ghost"}
              size="icon"
              className="h-9 w-9"
              onClick={() => onFolderSelect("all")}
              title="All Files"
            >
              <Home className="h-4 w-4" />
            </Button>
            <Button type="button"
              variant={currentFolderId === null ? "secondary" : "ghost"}
              size="icon"
              className="h-9 w-9"
              onClick={() => onFolderSelect(null)}
              title="Uncategorized"
            >
              <Folder className="h-4 w-4" />
            </Button>
            {folders.map((folder) => (
              <Button type="button"
                key={folder.id}
                variant={currentFolderId === folder.id ? "secondary" : "ghost"}
                size="icon"
                className="h-9 w-9"
                onClick={() => onFolderSelect(folder.id)}
                title={folder.name}
              >
                <Folder className={cn("h-4 w-4", getFolderColor(folder.id))} />
              </Button>
            ))}
            <Button type="button"
              variant="outline"
              size="icon"
              className="h-9 w-9 mt-2"
              onClick={() => setShowCreateDialog(true)}
              title="New Folder"
            >
              <FolderPlus className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>

      {/* Create folder dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create New Folder</DialogTitle>
            <DialogDescription>
              Enter a name for the new folder.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Input
              placeholder="Folder name"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  handleCreateFolder();
                }
              }}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button type="button"
              variant="outline"
              onClick={() => {
                setShowCreateDialog(false);
                setNewFolderName("");
              }}
            >
              Cancel
            </Button>
            <Button type="button"
              onClick={handleCreateFolder}
              disabled={!newFolderName.trim() || isCreating}
            >
              {isCreating ? "Creating..." : "Create Folder"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete folder confirmation */}
      <AlertDialog
        open={deleteDialogFolderId !== null}
        onOpenChange={(open) => !open && setDeleteDialogFolderId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Folder?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this folder? Files in this folder
              will be moved to the root. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteFolder}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
