// src/components/admin/attributes-manager/components/BulkActionDialog.tsx
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
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Confirm Bulk Action</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to {bulkAction} {selectedCount} selected
            attributes?
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
