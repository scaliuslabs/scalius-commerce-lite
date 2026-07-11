import { cn } from "@scalius/shared/utils";
import { AlertTriangle, Loader2, Trash2 } from "lucide-react";
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

interface ProductDeleteDialogProps {
  showTrashed: boolean;
  productToDelete: { id: string } | null;
  isBulkDeleteOpen: boolean;
  selectedCount: number;
  isActionLoading: boolean;
  onCloseSingle: () => void;
  onBulkOpenChange: (open: boolean) => void;
  onConfirmSingle: () => void;
  onConfirmBulk: () => void;
}

export function ProductDeleteDialog({
  showTrashed,
  productToDelete,
  isBulkDeleteOpen,
  selectedCount,
  isActionLoading,
  onCloseSingle,
  onBulkOpenChange,
  onConfirmSingle,
  onConfirmBulk,
}: ProductDeleteDialogProps) {
  const isSingleDialogOpen = !!productToDelete && !isBulkDeleteOpen;

  return (
    <>
      <AlertDialog
        open={isSingleDialogOpen}
        onOpenChange={(open) => {
          if (!open) onCloseSingle();
        }}
      >
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-base">
              {showTrashed ? (
                <>
                  <AlertTriangle className="h-4 w-4 text-red-500" /> Delete
                  Permanently?
                </>
              ) : (
                <>
                  <Trash2 className="h-4 w-4 text-amber-500" /> Move to Trash?
                </>
              )}
            </AlertDialogTitle>
            <AlertDialogDescription className="pt-1 text-xs">
              {showTrashed
                ? "This action cannot be undone. Are you sure you want to permanently delete this product?"
                : "Are you sure you want to move this product to the trash? It can be restored later."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={isActionLoading}
              className="h-8 text-xs"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={onConfirmSingle}
              className={cn(
                "h-8 text-xs",
                showTrashed ? "bg-destructive hover:bg-destructive/90" : "",
              )}
              disabled={isActionLoading}
            >
              {isActionLoading ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : null}
              {showTrashed ? "Delete Permanently" : "Move to Trash"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={isBulkDeleteOpen} onOpenChange={onBulkOpenChange}>
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-base">
              {showTrashed ? (
                <>
                  <AlertTriangle className="h-4 w-4 text-red-500" /> Delete
                  Selected Permanently?
                </>
              ) : (
                <>
                  <Trash2 className="h-4 w-4 text-amber-500" /> Move Selected
                  to Trash?
                </>
              )}
            </AlertDialogTitle>
            <AlertDialogDescription className="pt-1 text-xs">
              You are about to{" "}
              {showTrashed ? "permanently delete" : "move to trash"}{" "}
              {selectedCount} product(s).
              {showTrashed ? (
                <span className="font-medium text-destructive block mt-1 text-xs">
                  This action cannot be undone.
                </span>
              ) : (
                <span className="block mt-1 text-xs">
                  They can be restored later from the trash view.
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={isActionLoading}
              className="h-8 text-xs"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={onConfirmBulk}
              className={cn(
                "h-8 text-xs",
                showTrashed ? "bg-destructive hover:bg-destructive/90" : "",
              )}
              disabled={isActionLoading}
            >
              {isActionLoading ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : null}
              {showTrashed
                ? `Delete ${selectedCount}`
                : `Move ${selectedCount} to Trash`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
