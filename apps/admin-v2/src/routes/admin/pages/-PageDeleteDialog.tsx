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

interface PageDeleteDialogProps {
  showTrashed: boolean;
  itemCount?: number;
  isOpen: boolean;
  isActionLoading: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

export function PageDeleteDialog({
  showTrashed,
  itemCount = 1,
  isOpen,
  isActionLoading,
  onOpenChange,
  onConfirm,
}: PageDeleteDialogProps) {
  const multiple = itemCount > 1;
  return (
    <AlertDialog open={isOpen} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-sm">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2 text-base">
            {showTrashed ? (
              <>
                <AlertTriangle className="h-4 w-4 text-red-500" /> Delete {multiple ? "pages" : "page"} permanently?
              </>
            ) : (
              <>
                <Trash2 className="h-4 w-4 text-amber-500" /> Move {multiple ? "pages" : "page"} to trash?
              </>
            )}
          </AlertDialogTitle>
          <AlertDialogDescription className="pt-1 text-xs">
            {showTrashed
              ? `Permanently delete ${multiple ? `these ${itemCount} pages` : "this page"}. This cannot be undone.`
              : `Move ${multiple ? `these ${itemCount} pages` : "this page"} to trash. ${multiple ? "They" : "It"} can be restored later.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel
            disabled={isActionLoading}
            className="h-11 text-xs sm:h-8"
          >
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className={cn(
              "h-11 text-xs sm:h-8",
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
