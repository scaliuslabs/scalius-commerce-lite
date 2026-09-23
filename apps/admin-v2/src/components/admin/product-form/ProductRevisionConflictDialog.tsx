import { useRef, type MouseEvent } from "react";
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
import type { ProductRevisionConflict } from "~/lib/admin-api-error";
import { useMessages } from "~/i18n";
import { productMessages } from "~/i18n/products";

interface ProductRevisionConflictDialogProps {
  open: boolean;
  conflict: ProductRevisionConflict | null;
  isReloading: boolean;
  reloadError: string | null;
  onOpenChange: (open: boolean) => void;
  onKeepDraft: () => void;
  onReloadLatest: () => Promise<void>;
  onProductUnavailable: () => void;
}

/** Someone else saved (or deleted) the product; never save over their version. */
export function ProductRevisionConflictDialog({
  open,
  conflict,
  isReloading,
  reloadError,
  onOpenChange,
  onKeepDraft,
  onReloadLatest,
  onProductUnavailable,
}: ProductRevisionConflictDialogProps) {
  const t = useMessages(productMessages);
  const keepDraftRef = useRef<HTMLButtonElement>(null);
  const deleted = conflict?.currentRevision === null;

  function handleReload(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    void onReloadLatest();
  }

  return (
    <AlertDialog open={open && conflict !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          keepDraftRef.current?.focus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{t(deleted ? "conflictDeletedTitle" : "conflictTitle")}</AlertDialogTitle>
          <AlertDialogDescription>{t(deleted ? "conflictDeletedBody" : "conflictBody")}</AlertDialogDescription>
        </AlertDialogHeader>

        {reloadError ? (
          <p role="alert" className="text-body text-destructive">
            {reloadError}
          </p>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel ref={keepDraftRef} disabled={isReloading} onClick={onKeepDraft}>
            {t("keepMyEdits")}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={deleted ? onProductUnavailable : handleReload}
            disabled={isReloading}
            aria-busy={isReloading}
            variant="destructive"
          >
            {t(deleted ? "backToProducts" : "loadLatest")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
