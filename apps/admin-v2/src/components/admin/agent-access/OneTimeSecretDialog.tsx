import { useEffect, useState } from "react";
import { Check, Copy, KeyRound, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";

interface OneTimeSecretDialogProps {
  token: string | null;
  title?: string;
  onClose: () => void;
}

export function OneTimeSecretDialog({
  token,
  title = "Copy your token now",
  onClose,
}: OneTimeSecretDialogProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => setCopied(false), [token]);

  const copyToken = async () => {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      toast.success("Token copied");
    } catch {
      toast.error("Token could not be copied", {
        description: "Select the token and copy it manually before closing.",
      });
    }
  };

  return (
    <Dialog open={token !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="max-w-xl"
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5" aria-hidden="true" />
            {title}
          </DialogTitle>
          <DialogDescription>
            This is the last time Scalius displays the complete token.
          </DialogDescription>
        </DialogHeader>

        <Alert className="border-emerald-300 bg-emerald-50 text-emerald-950 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-100">
          <ShieldCheck aria-hidden="true" />
          <AlertTitle>Store it in the agent&apos;s secret manager</AlertTitle>
          <AlertDescription className="text-emerald-900/80 dark:text-emerald-100/75">
            Scalius stores a verifier, not this value. Closing this window clears
            the token from the page.
          </AlertDescription>
        </Alert>

        <div className="flex items-stretch gap-2">
          <Input
            value={token ?? ""}
            readOnly
            aria-label="New agent token"
            className="h-11 min-w-0 font-mono text-xs"
            onFocus={(event) => event.currentTarget.select()}
          />
          <Button
            type="button"
            variant="outline"
            className="h-11 shrink-0"
            onClick={() => void copyToken()}
          >
            {copied ? (
              <Check className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Copy className="h-4 w-4" aria-hidden="true" />
            )}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>

        <DialogFooter>
          <Button type="button" onClick={onClose} className="min-h-11 sm:min-h-9">
            I saved the token
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
