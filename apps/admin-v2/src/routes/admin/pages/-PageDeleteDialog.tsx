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
  isOpen: boolean;
  isActionLoading: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

export function PageDeleteDialog({
  showTrashed,
  isOpen,
  isActionLoading,
  onOpenChange,
  onConfirm,
}: PageDeleteDialogProps) {
  return (
    <AlertDialog open={isOpen} onOpenChange={onOpenChange}>
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
              ? "This action cannot be undone. Are you sure you want to permanently delete this page?"
              : "Are you sure you want to move this page to the trash? It can be restored later."}
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
            {showTrashed ? "Delete Permanently" : "Move to Trash"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
