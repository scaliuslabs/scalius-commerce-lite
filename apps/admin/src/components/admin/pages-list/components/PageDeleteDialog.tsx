// src/components/admin/pages-list/components/PageDeleteDialog.tsx
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface PageDeleteDialogProps {
  pageToDelete: { id: string; title: string } | null;
  setPageToDelete: (page: { id: string; title: string } | null) => void;
  showTrashed: boolean;
  isActionLoading: boolean;
  onDeleteConfirm: () => void;
}

export function PageDeleteDialog({
  pageToDelete,
  setPageToDelete,
  showTrashed,
  isActionLoading,
  onDeleteConfirm,
}: PageDeleteDialogProps) {
  return (
    <AlertDialog
      open={pageToDelete !== null}
      onOpenChange={(open) => !open && setPageToDelete(null)}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {showTrashed ? "Permanently delete page?" : "Move page to trash?"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {showTrashed ? (
              <>
                This action cannot be undone. The page "
                <span className="font-semibold">{pageToDelete?.title}</span>"
                will be permanently deleted.
              </>
            ) : (
              <>
                The page "
                <span className="font-semibold">{pageToDelete?.title}</span>"
                will be moved to trash and can be restored later.
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isActionLoading}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={onDeleteConfirm}
            disabled={isActionLoading}
            className="bg-destructive hover:bg-destructive/90"
          >
            {showTrashed ? "Delete Permanently" : "Move to Trash"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
