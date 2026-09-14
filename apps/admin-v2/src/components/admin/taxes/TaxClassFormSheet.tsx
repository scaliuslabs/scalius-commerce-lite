import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { EditorSheet } from "~/components/admin/shell/EditorSheet";
import { FieldError } from "~/components/admin/shell/FieldError";
import { InlineHelp } from "~/components/admin/shell/InlineHelp";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import {
  createTaxClass,
  updateTaxClass,
  type TaxClassRecord,
} from "~/lib/api-functions/taxes";
import { getServerFnError } from "~/lib/api-helpers";
import { queryKeys } from "~/lib/query-keys";

export interface ClassDraft {
  name: string;
  description: string;
  isExempt: boolean;
}

export const EMPTY_CLASS_DRAFT: ClassDraft = {
  name: "",
  description: "",
  isExempt: false,
};

export interface ClassDraftIssues {
  name?: string;
}

export function classDraftIssues(draft: ClassDraft): ClassDraftIssues {
  return draft.name.trim() ? {} : { name: "Enter a name for this class." };
}

export function TaxClassFormSheet({
  open,
  onOpenChange,
  canManage,
  editing,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canManage: boolean;
  /** The saved class being edited, or null when creating one. */
  editing: TaxClassRecord | null;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<ClassDraft>(EMPTY_CLASS_DRAFT);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSubmitted(false);
    setDraft(
      editing
        ? {
            name: editing.name,
            description: editing.description ?? "",
            isExempt: editing.isExempt,
          }
        : EMPTY_CLASS_DRAFT,
    );
  }, [editing, open]);

  const issues = classDraftIssues(draft);
  const nameIssue = submitted ? issues.name : undefined;

  const saveMutation = useMutation({
    mutationFn: async () => {
      const update = {
        name: draft.name.trim(),
        description: draft.description.trim() || null,
        isExempt: draft.isExempt,
      };
      return editing
        ? updateTaxClass({ data: {
            id: editing.id,
            expectedVersion: editing.version,
            update,
          } })
        : createTaxClass({ data: update });
    },
    onSuccess: async () => {
      toast.success(editing ? "Tax class updated" : "Tax class created");
      onOpenChange(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys.settings.taxes() });
    },
    onError: (error) => toast.error(getServerFnError(error, "Tax class could not be saved.")),
  });

  function submit() {
    setSubmitted(true);
    if (issues.name) return;
    saveMutation.mutate();
  }

  return (
    <EditorSheet
      open={open}
      onOpenChange={onOpenChange}
      width="md"
      title={editing ? "Edit tax class" : "Add tax class"}
      description="Classes group products and SKUs under one merchant-defined tax treatment."
      onSubmit={submit}
      footer={(
        <>
          <Button
            type="button"
            variant="outline"
            className="min-h-11 sm:min-h-9"
            disabled={saveMutation.isPending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            className="min-h-11 sm:min-h-9 sm:min-w-32"
            disabled={!canManage || saveMutation.isPending || (submitted && Boolean(issues.name))}
          >
            {saveMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : null}
            {editing ? "Save class" : "Add class"}
          </Button>
        </>
      )}
    >
      <div className="space-y-1.5">
        <Label htmlFor="tax-class-name">Name</Label>
        <Input
          className="min-h-11 sm:min-h-9"
          id="tax-class-name"
          value={draft.name}
          maxLength={120}
          aria-invalid={nameIssue ? true : undefined}
          onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
          placeholder="Standard goods"
          disabled={!canManage}
        />
        <FieldError>{nameIssue}</FieldError>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="tax-class-description">Internal description</Label>
        <Textarea
          id="tax-class-description"
          value={draft.description}
          maxLength={500}
          aria-describedby="tax-class-description-help"
          onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
          placeholder="Where this class should be applied"
          disabled={!canManage}
        />
        <InlineHelp id="tax-class-description-help">
          Only staff see this. Buyers never see class names or descriptions.
        </InlineHelp>
      </div>

      <div className="rounded-lg border border-border p-3">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="tax-class-exempt">Exempt class</Label>
          <Switch
            className="relative after:absolute after:-inset-x-1.5 after:-inset-y-3"
            id="tax-class-exempt"
            checked={draft.isExempt}
            disabled={!canManage}
            onCheckedChange={(isExempt) => setDraft((current) => ({ ...current, isExempt }))}
          />
        </div>
        <InlineHelp className="mt-1">
          Anything in an exempt class resolves to zero tax at every destination.
        </InlineHelp>
      </div>
    </EditorSheet>
  );
}

export default TaxClassFormSheet;
