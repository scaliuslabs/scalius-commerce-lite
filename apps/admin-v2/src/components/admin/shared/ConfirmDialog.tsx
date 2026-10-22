import { lazy, Suspense, useState } from "react";
import { Loader2 } from "lucide-react";
import { typedConfirmMatches } from "./typed-confirm";

// Only permanent deletes ask for a typed name, so its field loads with them, not with every dialog.
const TypedConfirmField = lazy(() => import("./TypedConfirmField").then((module) => ({ default: module.TypedConfirmField })));
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
import { useMessages } from "~/i18n";
import { resourceMessages } from "~/i18n/resource";

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Names the object, as a question: "Delete “Cotton panjabi”?" */
  title: string;
  /** Leads with the consequence. */
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive by default: most confirmations guard something that can't be undone. */
  variant?: "destructive" | "default";
  /** While the action runs both buttons are disabled and the confirm button shows a spinner. */
  isLoading?: boolean;
  loadingLabel?: string;
  onConfirm: () => void;
  className?: string;
  /** For what cannot be undone: the confirm button enables once this is typed. */
  confirmPhrase?: string;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  variant = "destructive",
  isLoading = false,
  loadingLabel,
  onConfirm,
  className,
  confirmPhrase,
}: ConfirmDialogProps) {
  const t = useMessages(resourceMessages);
  const confirm = confirmLabel ?? t("confirm");
  const [typed, setTyped] = useState("");
  const confirmed = confirmPhrase === undefined || typedConfirmMatches(confirmPhrase, typed);
  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!next) setTyped(""); onOpenChange(next); }}>
      <AlertDialogContent className={className}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {confirmPhrase !== undefined ? (
          <Suspense fallback={null}>
            <TypedConfirmField phrase={confirmPhrase} value={typed} onChange={setTyped} disabled={isLoading} />
          </Suspense>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isLoading}>{cancelLabel ?? t("cancel")}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} variant={variant} disabled={isLoading || !confirmed}>
            {isLoading ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
            {isLoading ? (loadingLabel ?? confirm) : confirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
