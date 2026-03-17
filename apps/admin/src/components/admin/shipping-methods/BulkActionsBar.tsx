import { Button } from "@/components/ui/button";
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
import { Trash2, Undo, AlertTriangle, Loader2 } from "lucide-react";
import { cn } from "@scalius/shared/utils";

interface BulkActionsBarProps {
  selectedCount: number;
  showTrashed: boolean;
  isActionLoading: boolean;
  isLoading: boolean;
  isConfirmBulkDeleteOpen: boolean;
  isConfirmBulkRestoreOpen: boolean;
  onOpenBulkDelete: () => void;
  onOpenBulkRestore: () => void;
  onCloseBulkDelete: () => void;
  onCloseBulkRestore: () => void;
  onBulkAction: (action: "trash" | "deletePermanent" | "restore") => void;
}

export function BulkActionsBar({
  selectedCount,
  showTrashed,
  isActionLoading,
  isLoading,
  isConfirmBulkDeleteOpen,
  isConfirmBulkRestoreOpen,
  onOpenBulkDelete,
  onOpenBulkRestore,
  onCloseBulkDelete,
  onCloseBulkRestore,
  onBulkAction,
}: BulkActionsBarProps) {
  return (
    <>
      <div
        className={cn(
          "transition-opacity duration-200 flex items-center gap-2",
          selectedCount > 0
            ? "opacity-100"
            : "opacity-0 pointer-events-none h-0 overflow-hidden sm:h-auto sm:opacity-100 sm:pointer-events-auto",
          selectedCount === 0 && "sm:min-w-[90px]",
        )}
      >
        {selectedCount > 0 ? (
          showTrashed ? (
            <>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={onOpenBulkRestore}
                disabled={isActionLoading || isLoading}
              >
                <Undo className="h-3.5 w-3.5 mr-1" /> Restore ({selectedCount})
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs text-destructive border-destructive hover:bg-destructive/10"
                onClick={onOpenBulkDelete}
                disabled={isActionLoading || isLoading}
              >
                <Trash2 className="h-3.5 w-3.5 mr-1" /> Delete ({selectedCount})
              </Button>
            </>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs text-destructive border-destructive hover:bg-destructive/10"
              onClick={onOpenBulkDelete}
              disabled={isActionLoading || isLoading}
            >
              <Trash2 className="h-3.5 w-3.5 mr-1" /> Trash ({selectedCount})
            </Button>
          )
        ) : (
          <div className="h-7" />
        )}
      </div>

      <AlertDialog open={isConfirmBulkDeleteOpen} onOpenChange={(open) => !open && onCloseBulkDelete()}>
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-base">
              {showTrashed ? (
                <>
                  <AlertTriangle className="h-4 w-4 text-red-500" /> Delete Selected Permanently?
                </>
              ) : (
                <>
                  <Trash2 className="h-4 w-4 text-amber-500" /> Move Selected to Trash?
                </>
              )}
            </AlertDialogTitle>
            <AlertDialogDescription className="pt-1 text-xs">
              You are about to {showTrashed ? "permanently delete" : "move to trash"}{" "}
              {selectedCount} method(s).
              {showTrashed && (
                <span className="font-medium text-destructive block mt-1 text-xs">
                  This action cannot be undone.
                </span>
              )}
              {!showTrashed && (
                <span className="block mt-1 text-xs">They can be restored later.</span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isActionLoading} className="h-8 text-xs">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => onBulkAction(showTrashed ? "deletePermanent" : "trash")}
              className={cn("h-8 text-xs", showTrashed && "bg-destructive hover:bg-destructive/90")}
              disabled={isActionLoading || selectedCount === 0}
            >
              {isActionLoading ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : null}{" "}
              {showTrashed ? `Delete ${selectedCount}` : `Move ${selectedCount} to Trash`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={isConfirmBulkRestoreOpen} onOpenChange={(open) => !open && onCloseBulkRestore()}>
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-base">
              <Undo className="h-4 w-4 text-green-500" /> Restore Selected Methods?
            </AlertDialogTitle>
            <AlertDialogDescription className="pt-1 text-xs">
              You are about to restore {selectedCount} method(s).
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isActionLoading} className="h-8 text-xs">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => onBulkAction("restore")}
              className="h-8 text-xs"
              disabled={isActionLoading || selectedCount === 0}
            >
              {isActionLoading ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : null}{" "}
              Restore {selectedCount} Methods
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
