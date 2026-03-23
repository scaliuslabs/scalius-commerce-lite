// src/components/admin/widget-list/components/WidgetDeleteDialog.tsx
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
import type { WidgetDeleteDialogProps } from "../types";

export function WidgetDeleteDialog({
  open,
  deleteDialog,
  showTrashed,
  isActionLoading,
  onOpenChange,
  onConfirm,
}: WidgetDeleteDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {showTrashed
              ? "Delete Widget Permanently?"
              : "Move Widget to Trash?"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {showTrashed
              ? "This action cannot be undone. The widget will be permanently removed from the system."
              : "This widget will be moved to the trash. You can restore it later if needed."}
            <br />
            <br />
            Widget: <strong>{deleteDialog?.name}</strong>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isActionLoading}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            disabled={isActionLoading}
            className={showTrashed ? "bg-destructive hover:bg-destructive/90" : ""}
          >
            {isActionLoading
              ? "Processing..."
              : showTrashed
                ? "Delete Permanently"
                : "Move to Trash"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

