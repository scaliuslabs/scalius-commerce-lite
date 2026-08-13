import { useId, useState } from "react";
import { Loader2, ShieldX } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";

interface RevokeDialogProps {
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: (reason: string) => Promise<unknown> | unknown;
  disabled?: boolean;
  pending?: boolean;
  triggerLabel?: string;
  triggerVariant?: "outline" | "destructive";
}

export function RevokeDialog({
  title,
  description,
  confirmLabel,
  onConfirm,
  disabled = false,
  pending = false,
  triggerLabel = "Revoke",
  triggerVariant = "outline",
}: RevokeDialogProps) {
  const reasonId = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");

  const confirm = async () => {
    try {
      await onConfirm(reason.trim());
      setReason("");
      setOpen(false);
    } catch {
      // The owning mutation presents the API error and keeps this dialog open.
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button
          type="button"
          variant={triggerVariant}
          size="sm"
          className="min-h-11 sm:min-h-9"
          disabled={disabled || pending}
        >
          <ShieldX className="h-4 w-4" aria-hidden="true" />
          {triggerLabel}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor={reasonId}>Reason (optional)</Label>
          <Textarea
            id={reasonId}
            value={reason}
            onChange={(event) => setReason(event.currentTarget.value)}
            maxLength={240}
            placeholder="Lost machine, retired integration, or access review"
            autoComplete="off"
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel className="min-h-11 sm:min-h-9">
            Keep access
          </AlertDialogCancel>
          <AlertDialogAction
            className="min-h-11 bg-destructive text-destructive-foreground hover:bg-destructive/90 sm:min-h-9"
            onClick={(event) => {
              event.preventDefault();
              void confirm();
            }}
            disabled={pending}
          >
            {pending ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : null}
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
