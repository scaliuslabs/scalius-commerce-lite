import { useEffect, useId, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import { FieldError, InlineHelp } from "~/components/admin/shell";
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
import { Label } from "~/components/ui/label";
import { getServerFnError } from "~/lib/api-helpers";
import { createNavigationMenuAuthority } from "~/lib/api-functions/navigation-authority";

export interface NavigationCreateMenuDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (menuId: string) => void;
}

/** Creating a menu only needs a name; the handle is derived unless overridden. */
export function NavigationCreateMenuDialog({
  open,
  onOpenChange,
  onCreated,
}: NavigationCreateMenuDialogProps) {
  const fieldId = useId();
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [showErrors, setShowErrors] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName("");
    setHandle("");
    setShowErrors(false);
  }, [open]);

  const mutation = useMutation({
    mutationFn: async () => {
      const result = await createNavigationMenuAuthority({
        data: { name, ...(handle ? { handle } : {}) },
      });
      return result.menu.id;
    },
    onSuccess: (menuId) => {
      toast.success("Menu created");
      onOpenChange(false);
      onCreated(menuId);
    },
    onError: (error) =>
      toast.error("Menu was not created", {
        description: getServerFnError(error, "Menu was not created"),
      }),
  });

  const nameError = !name.trim() ? "Enter a name so you can find this menu later." : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create menu</DialogTitle>
          <DialogDescription>
            Customers see item labels, not this name.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor={`${fieldId}-name`}>Name</Label>
            <Input
              id={`${fieldId}-name`}
              value={name}
              maxLength={100}
              autoFocus
              aria-invalid={showErrors && Boolean(nameError)}
              onChange={(event) => setName(event.target.value)}
            />
            {showErrors && nameError ? <FieldError>{nameError}</FieldError> : null}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${fieldId}-handle`}>Handle</Label>
            <Input
              id={`${fieldId}-handle`}
              value={handle}
              maxLength={80}
              placeholder="Generated from name"
              aria-describedby={`${fieldId}-handle-help`}
              onChange={(event) => setHandle(event.target.value)}
            />
            <InlineHelp id={`${fieldId}-handle-help`}>
              Themes and integrations reference the menu by its handle.
            </InlineHelp>
          </div>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            className="min-h-11 sm:min-h-9"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            className="min-h-11 sm:min-h-9"
            disabled={mutation.isPending}
            onClick={() => {
              if (nameError) {
                setShowErrors(true);
                return;
              }
              mutation.mutate();
            }}
          >
            {mutation.isPending ? "Creating" : "Create menu"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default NavigationCreateMenuDialog;
