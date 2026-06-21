import {
  ConfirmDialog,
  PermanentDeleteConfirmDialog,
} from "@/components/admin/shared/ConfirmDialog";

interface VariantDeleteDialogsProps {
  /** Single variant delete */
  variantToDelete: string | null;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
  /** Bulk variant delete */
  isBulkDeleteDialogOpen: boolean;
  onCloseBulkDeleteDialog: (open: boolean) => void;
  selectedCount: number;
  onConfirmBulkDelete: () => void;
  /** Shared loading state */
  isLoading: boolean;
}

export function VariantDeleteDialogs({
  variantToDelete,
  onCancelDelete,
  onConfirmDelete,
  isBulkDeleteDialogOpen,
  onCloseBulkDeleteDialog,
  selectedCount,
  onConfirmBulkDelete,
  isLoading,
}: VariantDeleteDialogsProps) {
  return (
    <>
      <PermanentDeleteConfirmDialog
        open={!!variantToDelete}
        onOpenChange={(open) => !open && onCancelDelete()}
        entityName="option"
        isLoading={isLoading}
        onConfirm={onConfirmDelete}
      />

      <ConfirmDialog
        open={isBulkDeleteDialogOpen}
        onOpenChange={onCloseBulkDeleteDialog}
        title={`Delete ${selectedCount} options?`}
        description="This action is permanent and cannot be undone."
        confirmLabel="Confirm Delete"
        loadingLabel="Deleting..."
        variant="destructive"
        isLoading={isLoading}
        onConfirm={onConfirmBulkDelete}
      />
    </>
  );
}
