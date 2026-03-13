// src/components/admin/pages-list/components/BulkActionDialog.tsx
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
import type { BulkAction } from "../types";

interface BulkActionDialogProps {
  bulkAction: BulkAction;
  setBulkAction: (action: BulkAction) => void;
  selectedIds: Set<string>;
  isBulkActionLoading: boolean;
  showTrashed: boolean;
  onPerformBulkAction: (action: BulkAction) => void;
}

export function BulkActionDialog({
  bulkAction,
  setBulkAction,
  selectedIds,
  isBulkActionLoading,
  onPerformBulkAction,
}: BulkActionDialogProps) {
  const getActionText = () => {
    switch (bulkAction) {
      case "trash":
        return {
          title: "Move pages to trash?",
          description: `${selectedIds.size} page(s) will be moved to trash and can be restored later.`,
          action: "Move to Trash",
        };
      case "delete":
        return {
          title: "Permanently delete pages?",
          description: `This action cannot be undone. ${selectedIds.size} page(s) will be permanently deleted.`,
          action: "Delete Permanently",
        };
      case "restore":
        return {
          title: "Restore pages?",
          description: `${selectedIds.size} page(s) will be restored from trash.`,
          action: "Restore",
        };
      case "publish":
        return {
          title: "Publish pages?",
          description: `${selectedIds.size} page(s) will be published and visible to the public.`,
          action: "Publish",
        };
      case "unpublish":
        return {
          title: "Unpublish pages?",
          description: `${selectedIds.size} page(s) will be unpublished and hidden from the public.`,
          action: "Unpublish",
        };
      default:
        return {
          title: "",
          description: "",
          action: "",
        };
    }
  };

  const actionText = getActionText();

  return (
    <AlertDialog
      open={bulkAction !== null}
      onOpenChange={(open) => !open && setBulkAction(null)}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{actionText.title}</AlertDialogTitle>
          <AlertDialogDescription>
            {actionText.description}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isBulkActionLoading}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              onPerformBulkAction(bulkAction);
              setBulkAction(null);
            }}
            disabled={isBulkActionLoading}
            className={
              bulkAction === "delete" || bulkAction === "trash"
                ? "bg-destructive hover:bg-destructive/90"
                : ""
            }
          >
            {actionText.action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
