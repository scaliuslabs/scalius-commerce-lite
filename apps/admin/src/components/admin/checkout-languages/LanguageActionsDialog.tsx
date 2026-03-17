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
import { Archive, AlertTriangle, ArchiveRestore, Loader2 } from "lucide-react";
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
      <AlertDialog
        open={!!itemToSoftDelete}
        onOpenChange={(open) => !open && onDismissSoftDelete()}
      >
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-base">
              <Archive className="h-4 w-4 text-amber-500" /> Move to Trash?
            </AlertDialogTitle>
            <AlertDialogDescription className="pt-1 text-xs">
              Are you sure you want to move "
              {itemToSoftDelete?.name || "this language"}" to trash? It can be
              restored later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={isActionLoading}
              className="h-8 text-xs"
              onClick={onDismissSoftDelete}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => itemToSoftDelete && onSoftDelete(itemToSoftDelete)}
              className="h-8 text-xs bg-amber-500 hover:bg-amber-600 text-white"
              disabled={isActionLoading}
            >
              {isActionLoading ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : null}{" "}
              Move to Trash
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={!!itemToPermanentlyDelete}
        onOpenChange={(open) => !open && onDismissPermanentDelete()}
      >
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="h-4 w-4 text-red-500" /> Delete
              Permanently?
            </AlertDialogTitle>
            <AlertDialogDescription className="pt-1 text-xs">
              Are you sure you want to permanently delete "
              {itemToPermanentlyDelete?.name || "this language"}"? This action
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={isActionLoading}
              className="h-8 text-xs"
              onClick={onDismissPermanentDelete}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => itemToPermanentlyDelete && onPermanentDelete(itemToPermanentlyDelete)}
              className="h-8 text-xs bg-red-600 hover:bg-red-700 text-white"
              disabled={isActionLoading}
            >
              {isActionLoading ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : null}{" "}
              Delete Permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={!!itemToRestore}
        onOpenChange={(open) => !open && onDismissRestore()}
      >
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-base">
              <ArchiveRestore className="h-4 w-4 text-green-500" /> Restore
              Language?
            </AlertDialogTitle>
            <AlertDialogDescription className="pt-1 text-xs">
              Are you sure you want to restore "
              {itemToRestore?.name || "this language"}"?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={isActionLoading}
              className="h-8 text-xs"
              onClick={onDismissRestore}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => itemToRestore && onRestore(itemToRestore)}
              className="h-8 text-xs bg-green-600 hover:bg-green-700 text-white"
              disabled={isActionLoading}
            >
              {isActionLoading ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : null}{" "}
              Restore Language
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
