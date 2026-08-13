import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { KeyRound, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { getServerFnError } from "~/lib/api-helpers";

import { createAgentToken } from "./api";
import {
  defaultGrantSelection,
  GrantSelectionFields,
} from "./GrantSelectionFields";
import { OneTimeSecretDialog } from "./OneTimeSecretDialog";
import type { AgentGrantSelection } from "./types";

interface CreateTokenDialogProps {
  availablePermissions: string[];
  canManage: boolean;
  onCreated: () => Promise<unknown> | unknown;
}

export function CreateTokenDialog({
  availablePermissions,
  canManage,
  onCreated,
}: CreateTokenDialogProps) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [selection, setSelection] = useState<AgentGrantSelection>(() =>
    defaultGrantSelection(),
  );
  const [token, setToken] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: () =>
      createAgentToken({
        label: label.trim(),
        ...selection,
      }),
    onSuccess: async (result) => {
      setToken(result.token);
      setOpen(false);
      toast.success("Personal token created");
      await onCreated();
    },
    onError: (error) => {
      toast.error(getServerFnError(error, "Token could not be created"));
    },
  });

  const reset = () => {
    setLabel("");
    setSelection(defaultGrantSelection());
    createMutation.reset();
  };

  const closeSecret = () => {
    setToken(null);
    reset();
  };

  const canSubmit =
    label.trim().length > 0 &&
    selection.expiresInDays >= 1 &&
    selection.expiresInDays <= (selection.preset === "read" ? 365 : 90) &&
    (selection.preset !== "custom" || selection.permissions.length > 0);

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !createMutation.isPending) reset();
          setOpen(nextOpen);
        }}
      >
        <DialogTrigger asChild>
          <Button type="button" className="min-h-11 sm:min-h-9" disabled={!canManage}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Create token
          </Button>
        </DialogTrigger>
        <DialogContent className="max-h-[90svh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="h-5 w-5" aria-hidden="true" />
              Create personal token
            </DialogTitle>
            <DialogDescription>
              Use a named token for MCP clients, CI, or remote agents that accept
              a static Bearer credential.
            </DialogDescription>
          </DialogHeader>

          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (canSubmit) createMutation.mutate();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="agent-token-label">Name</Label>
              <Input
                id="agent-token-label"
                value={label}
                onChange={(event) => setLabel(event.currentTarget.value)}
                placeholder="Warehouse assistant"
                maxLength={80}
                autoComplete="off"
                required
                disabled={createMutation.isPending}
              />
              <p className="text-xs text-muted-foreground">
                Name the person, system, or machine that will hold this token.
              </p>
            </div>

            <GrantSelectionFields
              value={selection}
              availablePermissions={availablePermissions}
              onChange={setSelection}
              disabled={createMutation.isPending}
            />

            <DialogFooter className="gap-2 sm:gap-0">
              <Button
                type="button"
                variant="outline"
                className="min-h-11 sm:min-h-9"
                disabled={createMutation.isPending}
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className="min-h-11 sm:min-h-9"
                disabled={!canSubmit || createMutation.isPending}
              >
                {createMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <KeyRound className="h-4 w-4" aria-hidden="true" />
                )}
                Create token
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <OneTimeSecretDialog token={token} onClose={closeSecret} />
    </>
  );
}
