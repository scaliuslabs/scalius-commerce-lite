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
  /** Names of the fields the merchant changed and hasn't saved. */
  changedFields: string[];
  /** The merchant also has unsaved variant changes. */
  variantsChanged: boolean;
  /** Fields the other save changed too, found when applying; null until then. */
  overlap: string[] | null;
  /** Loads the other save and puts the merchant's changes back on top, unsaved. */
  onApplyMine: () => Promise<void>;
  /** Loads the other save and drops the merchant's changes. */
  onReloadLatest: () => Promise<void>;
  onProductUnavailable: () => void;
}

/**
 * Someone else saved (or deleted) the product; never save over their version.
 * The merchant's changes are named, and applied on top of the latest version
 * when the two saves touched different fields.
 */
export function ProductRevisionConflictDialog({
  open,
  conflict,
  isReloading,
  reloadError,
  onOpenChange,
  changedFields,
  variantsChanged,
  overlap,
  onApplyMine,
  onReloadLatest,
  onProductUnavailable,
}: ProductRevisionConflictDialogProps) {
  const t = useMessages(productMessages);
  const safeActionRef = useRef<HTMLButtonElement>(null);
  const deleted = conflict?.currentRevision === null;
  const mine = [...new Set([...changedFields, ...(variantsChanged ? [t("variants")] : [])])];
  const blocked = overlap !== null && overlap.length > 0;

  const run = (action: () => Promise<void>) => (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    void action();
  };

  return (
    <AlertDialog open={open && conflict !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          safeActionRef.current?.focus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{t(deleted ? "conflictDeletedTitle" : "conflictTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {deleted
              ? t("conflictDeletedBody")
              : blocked
                ? t("conflictOverlapBody", { fields: overlap.join(", ") })
                : mine.length
                  ? t("conflictMineBody", { fields: mine.join(", ") })
                  : t("conflictBody")}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {reloadError ? (
          <p role="alert" className="text-body text-destructive">
            {reloadError}
          </p>
        ) : null}

        <AlertDialogFooter>
          {deleted ? (
            <AlertDialogAction ref={safeActionRef} onClick={onProductUnavailable}>
              {t("backToProducts")}
            </AlertDialogAction>
          ) : (
            <>
              {blocked ? (
                <AlertDialogCancel ref={safeActionRef} disabled={isReloading}>{t("keepEditing")}</AlertDialogCancel>
              ) : (
                <AlertDialogCancel disabled={isReloading} onClick={run(onReloadLatest)}>
                  {mine.length ? t("discardMineLoadLatest") : t("loadLatest")}
                </AlertDialogCancel>
              )}
              <AlertDialogAction
                ref={blocked ? undefined : safeActionRef}
                onClick={run(blocked ? onReloadLatest : onApplyMine)}
                disabled={isReloading}
                aria-busy={isReloading}
                variant={blocked ? "destructive" : "default"}
              >
                {blocked ? t("loadLatest") : t("applyMine")}
              </AlertDialogAction>
            </>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
