import {
  ConfirmDialog,
  PermanentDeleteConfirmDialog,
  RestoreConfirmDialog,
} from "~/components/admin/shared/ConfirmDialog";
import type { ManagerCheckoutLanguage } from "./hooks/useLanguages";

interface LanguageActionsDialogProps {
  itemToSoftDelete: ManagerCheckoutLanguage | null;
  itemToPermanentlyDelete: ManagerCheckoutLanguage | null;
  itemToRestore: ManagerCheckoutLanguage | null;
  isActionLoading: boolean;
  onSoftDelete: (language: ManagerCheckoutLanguage) => void;
  onPermanentDelete: (language: ManagerCheckoutLanguage) => void;
  onRestore: (language: ManagerCheckoutLanguage) => void;
  onDismissSoftDelete: () => void;
  onDismissPermanentDelete: () => void;
  onDismissRestore: () => void;
}

export function LanguageActionsDialog({
  itemToSoftDelete,
  itemToPermanentlyDelete,
  itemToRestore,
  isActionLoading,
  onSoftDelete,
  onPermanentDelete,
  onRestore,
  onDismissSoftDelete,
  onDismissPermanentDelete,
  onDismissRestore,
}: LanguageActionsDialogProps) {
  return (
    <>
      <ConfirmDialog
        open={!!itemToSoftDelete}
        onOpenChange={(open) => !open && onDismissSoftDelete()}
        title="Move to Trash?"
        description={`Are you sure you want to move "${itemToSoftDelete?.name || "this language"}" to trash? It can be restored later.`}
        confirmLabel="Move to Trash"
        loadingLabel="Moving..."
        variant="destructive"
        isLoading={isActionLoading}
        onConfirm={() =>
          itemToSoftDelete && onSoftDelete(itemToSoftDelete)
        }
      />

      <PermanentDeleteConfirmDialog
        open={!!itemToPermanentlyDelete}
        onOpenChange={(open) => !open && onDismissPermanentDelete()}
        entityName="language"
        isLoading={isActionLoading}
        onConfirm={() =>
          itemToPermanentlyDelete &&
          onPermanentDelete(itemToPermanentlyDelete)
        }
      />

      <RestoreConfirmDialog
        open={!!itemToRestore}
        onOpenChange={(open) => !open && onDismissRestore()}
        entityName="language"
        isLoading={isActionLoading}
        onConfirm={() => itemToRestore && onRestore(itemToRestore)}
      />
    </>
  );
}
