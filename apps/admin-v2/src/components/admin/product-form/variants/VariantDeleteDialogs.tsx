import { Loader2 } from "lucide-react";
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
} from "@/components/ui/alert-dialog";

interface VariantDeleteDialogsProps {
  /** Single variant delete */
  variantToDelete: string | null;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
  /** Bulk variant delete */
  isBulkDeleteDialogOpen: boolean;
  onCloseBulkDeleteDialog: (open: boolean) => void;
  selectedCount: number;
  onConfirmBulkDelete: () => void;
  /** Shared loading state */
  isLoading: boolean;
}

export function VariantDeleteDialogs({
  variantToDelete,
  onCancelDelete,
  onConfirmDelete,
  isBulkDeleteDialogOpen,
  onCloseBulkDeleteDialog,
  selectedCount,
  onConfirmBulkDelete,
  isLoading,
}: VariantDeleteDialogsProps) {
  return (
    <>
      <AlertDialog
        open={!!variantToDelete}
        onOpenChange={(open) => !open && onCancelDelete()}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you sure?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete the
              variant.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={onConfirmDelete}
              className={cn("bg-destructive hover:bg-destructive/90")}
            >
              {isLoading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={isBulkDeleteDialogOpen}
        onOpenChange={onCloseBulkDeleteDialog}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {selectedCount} variants?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This action is permanent and cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={onConfirmBulkDelete}
              className={cn("bg-destructive hover:bg-destructive/90")}
            >
              {isLoading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              Confirm Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
