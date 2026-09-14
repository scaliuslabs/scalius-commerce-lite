import { useState } from "react";
import { Eraser, Loader2 } from "lucide-react";

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

import type { AgentClearableConnections } from "./types";

interface PurgeRevokedDialogProps {
  clearable: AgentClearableConnections | undefined;
  onConfirm: () => Promise<unknown> | unknown;
  disabled?: boolean;
  pending?: boolean;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function describeClearable(clearable: AgentClearableConnections): string {
  const parts: string[] = [];
  if (clearable.revoked > 0) parts.push(`${plural(clearable.revoked, "revoked connection")}`);
  if (clearable.expired > 0) parts.push(`${plural(clearable.expired, "expired connection")}`);
  return parts.join(" and ");
}

export function PurgeRevokedDialog({
  clearable,
  onConfirm,
  disabled = false,
  pending = false,
}: PurgeRevokedDialogProps) {
  const [open, setOpen] = useState(false);
  const total = clearable?.total ?? 0;
  const nothingToClear = clearable === undefined || total === 0;

  const confirm = async () => {
    try {
      await onConfirm();
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
          variant="outline"
          size="sm"
          className="min-h-11 sm:min-h-9"
          disabled={disabled || pending || nothingToClear}
          title={nothingToClear ? "There are no revoked or expired connections to clear" : undefined}
        >
          <Eraser className="h-4 w-4" aria-hidden="true" />
          Clear revoked
          {total > 0 ? <span className="tabular-nums text-muted-foreground">({total})</span> : null}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Permanently delete revoked and expired connections?</AlertDialogTitle>
          <AlertDialogDescription>
            {clearable && total > 0
              ? `${describeClearable(clearable)} will be permanently deleted, `
              : "Every revoked and expired connection will be permanently deleted, "}
            including their credentials, staged artifacts, pairing records, and
            audit history. Active and pending connections are not affected. This
            cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="min-h-11 sm:min-h-9">
            Keep history
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            className="min-h-11 sm:min-h-9"
            onClick={(event) => {
              event.preventDefault();
              void confirm();
            }}
            disabled={pending}
          >
            {pending ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : null}
            Delete permanently
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
