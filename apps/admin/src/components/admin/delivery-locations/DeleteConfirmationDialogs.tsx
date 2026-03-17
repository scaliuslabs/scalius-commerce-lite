import { Button } from "../../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog";

interface DeleteConfirmationDialogsProps {
  activeTab: "city" | "zone" | "area";
  // Single delete
  isDeleteDialogOpen: boolean;
  onCloseDeleteDialog: () => void;
  onConfirmDelete: () => void;
  // Bulk delete
  isBulkDeleteDialogOpen: boolean;
  onCloseBulkDeleteDialog: (open: boolean) => void;
  selectedCount: number;
  onConfirmBulkDelete: () => void;
  // Clean all
  isCleanAllDialogOpen: boolean;
  onCloseCleanAllDialog: (open: boolean) => void;
  onConfirmCleanAll: () => void;
}

export function DeleteConfirmationDialogs({
  activeTab,
  isDeleteDialogOpen,
  onCloseDeleteDialog,
  onConfirmDelete,
  isBulkDeleteDialogOpen,
  onCloseBulkDeleteDialog,
  selectedCount,
  onConfirmBulkDelete,
  isCleanAllDialogOpen,
  onCloseCleanAllDialog,
  onConfirmCleanAll,
}: DeleteConfirmationDialogsProps) {
  return (
    <>
      {/* Single delete */}
      <Dialog open={isDeleteDialogOpen} onOpenChange={onCloseDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm Delete</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this {activeTab}?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCloseDeleteDialog}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={onConfirmDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk delete */}
      <Dialog
        open={isBulkDeleteDialogOpen}
        onOpenChange={onCloseBulkDeleteDialog}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm Bulk Delete</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete the selected{" "}
              {selectedCount} {activeTab}(s)? This action cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onCloseBulkDeleteDialog(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={onConfirmBulkDelete}
            >
              Delete {selectedCount} Item(s)
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Clean all */}
      <Dialog
        open={isCleanAllDialogOpen}
        onOpenChange={onCloseCleanAllDialog}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Confirm Permanent Deletion of All Locations
            </DialogTitle>
            <DialogDescription>
              Are you sure you want to permanently delete ALL cities, zones, and
              areas? This action is irreversible and all delivery location data
              will be lost forever.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onCloseCleanAllDialog(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={onConfirmCleanAll}
            >
              Yes, Delete All Data
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
