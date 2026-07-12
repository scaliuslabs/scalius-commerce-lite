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

interface CategoryDeleteDialogProps {
  showTrashed: boolean;
  isOpen: boolean;
  isActionLoading: boolean;
  itemCount?: number;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

export function CategoryDeleteDialog({
  showTrashed,
  isOpen,
  isActionLoading,
  itemCount = 1,
  onOpenChange,
  onConfirm,
}: CategoryDeleteDialogProps) {
  return (
    <AlertDialog open={isOpen} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-sm">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2 text-base">
            {showTrashed ? (
              <>
                <AlertTriangle className="h-4 w-4 text-red-500" /> Delete permanently?
              </>
            ) : (
              <>
                <Trash2 className="h-4 w-4 text-amber-500" /> Move to Trash?
              </>
            )}
          </AlertDialogTitle>
          <AlertDialogDescription className="pt-1 text-xs">
            {showTrashed
              ? `This permanently deletes ${itemCount === 1 ? "this category" : `${itemCount} categories`} and cannot be undone. Categories still used by products or required by active collections will be blocked.`
              : `${itemCount === 1 ? "This category" : `${itemCount} categories`} will move to trash and can be restored. Move assigned products first.`}
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
            onClick={onConfirm}
            className={cn(
              "h-8 text-xs",
              showTrashed ? "bg-destructive hover:bg-destructive/90" : "",
            )}
            disabled={isActionLoading}
          >
            {isActionLoading ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : null}
            {showTrashed ? "Delete permanently" : "Move to trash"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
