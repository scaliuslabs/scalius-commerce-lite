import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../../ui/alert-dialog";

interface DiscountDeleteDialogsProps {
  deleteConfirmation: string | null;
  permanentDeleteConfirmation: string | null;
  bulkActionConfirmation: "delete" | "restore" | null;
  showTrashed: boolean;
  selectedCount: number;
  onDeleteCancel: () => void;
  onDeleteConfirm: () => void;
  onPermanentDeleteCancel: () => void;
  onPermanentDeleteConfirm: () => void;
  onBulkCancel: () => void;
  onBulkConfirm: () => void;
}

export function DiscountDeleteDialogs({
  deleteConfirmation,
  permanentDeleteConfirmation,
  bulkActionConfirmation,
  showTrashed,
  selectedCount,
  onDeleteCancel,
  onDeleteConfirm,
  onPermanentDeleteCancel,
  onPermanentDeleteConfirm,
  onBulkCancel,
  onBulkConfirm,
}: DiscountDeleteDialogsProps) {
  return (
    <>
      <AlertDialog
        open={!!deleteConfirmation}
        onOpenChange={(open) => !open && onDeleteCancel()}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Move to Trash?</AlertDialogTitle>
            <AlertDialogDescription>
              This discount will be moved to the trash. You can restore it later
              from the trash view.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={onDeleteConfirm}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Move to Trash
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={!!permanentDeleteConfirmation && showTrashed}
        onOpenChange={(open) => !open && onPermanentDeleteCancel()}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Permanently?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. The discount will be permanently
              removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={onPermanentDeleteConfirm}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete Permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={!!bulkActionConfirmation}
        onOpenChange={(open) => !open && onBulkCancel()}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
            <AlertDialogDescription>
              {bulkActionConfirmation === "restore"
                ? `This will restore the selected ${selectedCount} discount(s).`
                : `This will ${showTrashed ? "permanently delete" : "move to trash"} the selected ${selectedCount} discount(s).`}
              {showTrashed && bulkActionConfirmation !== "restore"
                ? " This action cannot be undone."
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={onBulkConfirm}
              className={
                bulkActionConfirmation === "restore"
                  ? ""
                  : "bg-destructive text-destructive-foreground hover:bg-destructive/90"
              }
            >
              {bulkActionConfirmation === "restore"
                ? `Restore ${selectedCount} items`
                : showTrashed
                  ? `Delete ${selectedCount} items`
                  : `Move ${selectedCount} items to Trash`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
