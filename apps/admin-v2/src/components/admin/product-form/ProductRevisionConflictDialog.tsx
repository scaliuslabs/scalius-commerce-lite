import { useRef, type MouseEvent } from "react";
import { Loader2 } from "lucide-react";
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
  const keepDraftRef = useRef<HTMLButtonElement>(null);

  function handleReload(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    void onReloadLatest();
  }

  return (
    <AlertDialog open={open && conflict !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent
        className="max-w-md gap-3"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          keepDraftRef.current?.focus();
        }}
      >
        <AlertDialogHeader className="space-y-1.5">
          <AlertDialogTitle>This product changed elsewhere</AlertDialogTitle>
          <AlertDialogDescription>
            Your draft is still here, but it can&apos;t be saved over the newer
            version.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {conflict ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-md border bg-muted/30 px-3 py-2.5 text-xs">
            <dt className="font-medium text-foreground">Your draft</dt>
            <dd className="text-right text-muted-foreground">
              Revision {conflict.expectedRevision} · Not saved
            </dd>
            <dt className="font-medium text-foreground">Saved product</dt>
            <dd className="text-right text-muted-foreground">
              {conflict.currentRevision === null
                ? "No longer available"
                : `Revision ${conflict.currentRevision}`}
            </dd>
          </dl>
        ) : null}

        <p className="text-xs text-muted-foreground">
          {conflict?.currentRevision === null
            ? "This draft cannot be saved because the product no longer exists."
            : "Reloading replaces this draft with the latest saved product."}
        </p>

        {reloadError ? (
          <p
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
          >
            {reloadError}
          </p>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel
            ref={keepDraftRef}
            disabled={isReloading}
            onClick={onKeepDraft}
          >
            Keep draft
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={
              conflict?.currentRevision === null
                ? onProductUnavailable
                : handleReload
            }
            disabled={isReloading}
            aria-busy={isReloading}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {isReloading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : null}
            {isReloading
              ? "Reloading…"
              : conflict?.currentRevision === null
                ? "Return to products"
                : "Reload latest"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
