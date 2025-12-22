// src/components/admin/collections-list/components/BulkActionDialog.tsx
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
import { cn } from "@/lib/utils";
import type { BulkActionDialogProps } from "../types";

export function BulkActionDialog({
  open,
  bulkAction,
  selectedCount,
  isActionLoading,
  onOpenChange,
  onConfirm,
}: BulkActionDialogProps) {
  const getActionText = () => {
    switch (bulkAction) {
      case "activate":
        return "activate";
      case "deactivate":
        return "deactivate";
      case "trash":
        return "move to trash";
      case "delete":
        return "permanently delete";
      case "restore":
        return "restore";
      default:
        return bulkAction;
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Confirm Bulk Action</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to {getActionText()} {selectedCount} selected
            collections?
            {bulkAction === "delete" && " This action cannot be undone."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className={cn(
              bulkAction === "delete" &&
                "bg-destructive hover:bg-destructive/90",
            )}
            disabled={isActionLoading}
          >
            Confirm
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
