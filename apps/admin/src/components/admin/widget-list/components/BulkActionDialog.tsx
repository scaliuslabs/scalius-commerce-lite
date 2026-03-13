// src/components/admin/widget-list/components/BulkActionDialog.tsx
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
import type { BulkActionDialogProps } from "../types";

export function BulkActionDialog({
  open,
  bulkAction,
  selectedCount,
  isActionLoading,
  onOpenChange,
  onConfirm,
}: BulkActionDialogProps) {
  const getDialogContent = () => {
    switch (bulkAction) {
      case "trash":
        return {
          title: "Move Widgets to Trash?",
          description: `Are you sure you want to move ${selectedCount} widget(s) to trash? You can restore them later.`,
          confirmText: "Move to Trash",
          variant: "default" as const,
        };
      case "delete":
        return {
          title: "Delete Widgets Permanently?",
          description: `Are you sure you want to permanently delete ${selectedCount} widget(s)? This action cannot be undone.`,
          confirmText: "Delete Permanently",
          variant: "destructive" as const,
        };
      case "restore":
        return {
          title: "Restore Widgets?",
          description: `Are you sure you want to restore ${selectedCount} widget(s)?`,
          confirmText: "Restore",
          variant: "default" as const,
        };
      case "activate":
        return {
          title: "Activate Widgets?",
          description: `Are you sure you want to activate ${selectedCount} widget(s)?`,
          confirmText: "Activate",
          variant: "default" as const,
        };
      case "deactivate":
        return {
          title: "Deactivate Widgets?",
          description: `Are you sure you want to deactivate ${selectedCount} widget(s)?`,
          confirmText: "Deactivate",
          variant: "default" as const,
        };
      default:
        return {
          title: "Confirm Action",
          description: "Are you sure you want to proceed?",
          confirmText: "Confirm",
          variant: "default" as const,
        };
    }
  };

  const content = getDialogContent();

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{content.title}</AlertDialogTitle>
          <AlertDialogDescription>{content.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isActionLoading}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            disabled={isActionLoading}
            className={
              content.variant === "destructive"
                ? "bg-destructive hover:bg-destructive/90"
                : ""
            }
          >
            {isActionLoading ? "Processing..." : content.confirmText}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

