// Add or edit one warranty policy. An edit that changes any buyer-facing field
// makes the next revision (the API does it in one batch, guarded by the
// version this dialog opened with); orders keep the revision they bought.
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import {
  WARRANTY_DURATION_UNITS,
  WARRANTY_LIMITS,
  isWarrantyDurationValue,
  isWarrantyReplacementDays,
  type WarrantyDurationUnit,
  type WarrantyProvider,
} from "@scalius/shared/warranty";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { useDirtyDialogClose } from "~/components/admin/shared/use-dirty-dialog-close";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { NativeSelect } from "~/components/ui/native-select";
import { NumberInput } from "~/components/ui/number-input";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";
import { Textarea } from "~/components/ui/textarea";
import { useMessages } from "~/i18n";
import { warrantyMessages, type WarrantyMessageKey } from "~/i18n/warranty";
import { isAdminApiConflictError } from "~/lib/admin-api-error";
import { getServerFnError } from "~/lib/api-helpers";
import { useSaveWarrantyPolicy, type WarrantyPolicy, type WarrantyPolicyBody } from "../../warranty/warranty-api";
import { warrantySummary } from "../../warranty/warranty-format";

interface Draft {
  name: string;
  provider: WarrantyProvider;
  durationValue: number | null;
  durationUnit: WarrantyDurationUnit;
  replacementDays: number | null;
  terms: string;
}

type Errors = Partial<Record<"name" | "durationValue" | "replacementDays" | "terms", WarrantyMessageKey>>;

const EMPTY: Draft = { name: "", provider: "brand", durationValue: 1, durationUnit: "years", replacementDays: null, terms: "" };

function draftOf(policy: WarrantyPolicy | null): Draft {
  if (!policy) return EMPTY;
  return {
    name: policy.name,
    provider: policy.provider,
    durationValue: policy.durationValue,
    durationUnit: policy.durationUnit,
    replacementDays: policy.replacementDays,
    terms: policy.terms ?? "",
  };
}

const codePoints = (value: string) => [...value].length;

/** The request body, or the first problems to show at their fields. */
export function policyBody(draft: Draft): { body: WarrantyPolicyBody } | { errors: Errors } {
  const errors: Errors = {};
  const name = draft.name.trim();
  if (!name) errors.name = "nameRequired";
  else if (codePoints(name) > WARRANTY_LIMITS.nameLength) errors.name = "nameTooLong";
  if (!isWarrantyDurationValue(draft.durationValue)) errors.durationValue = "durationInvalid";
  if (draft.replacementDays !== null && !isWarrantyReplacementDays(draft.replacementDays)) errors.replacementDays = "replacementInvalid";
  const terms = draft.terms.trim();
  if (codePoints(terms) > WARRANTY_LIMITS.termsLength) errors.terms = "termsTooLong";
  if (Object.keys(errors).length > 0) return { errors };
  return {
    body: {
      name,
      provider: draft.provider,
      durationValue: draft.durationValue!,
      durationUnit: draft.durationUnit,
      replacementDays: draft.replacementDays,
      terms: terms || null,
    },
  };
}

export function WarrantyPolicyDialog({ policy, open, onOpenChange }: {
  /** null adds a policy. */
  policy: WarrantyPolicy | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useMessages(warrantyMessages);
  const [draft, setDraft] = useState<Draft>(() => draftOf(policy));
  const [errors, setErrors] = useState<Errors>({});
  const save = useSaveWarrantyPolicy();
  const reset = save.reset;

  useEffect(() => {
    if (!open) return;
    setDraft(draftOf(policy));
    setErrors({});
    reset();
  }, [open, policy, reset]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(policy));
  const { requestClose, discardDialog } = useDirtyDialogClose({ dirty, busy: save.isPending, onClose: () => onOpenChange(false) });
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    if (key in errors) setErrors((current) => ({ ...current, [key]: undefined }));
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (save.isPending) return;
    const result = policyBody(draft);
    if ("errors" in result) {
      setErrors(result.errors);
      const first = (["name", "durationValue", "replacementDays", "terms"] as const).find((field) => result.errors[field]);
      if (first) document.getElementById(`warranty-policy-${first}`)?.focus();
      return;
    }
    save.mutate(
      { id: policy?.id ?? null, version: policy?.version ?? null, body: result.body },
      {
        onSuccess: () => {
          toast.success(t(policy ? "saved" : "created"));
          onOpenChange(false);
        },
      },
    );
  };

  const serverError = save.error
    ? isAdminApiConflictError(save.error) ? t("conflict") : getServerFnError(save.error, t("saveFailed"))
    : null;
  const preview = isWarrantyDurationValue(draft.durationValue)
    ? warrantySummary(t, { ...draft, durationValue: draft.durationValue })
    : null;
  const describedBy = (field: keyof Errors, help: boolean) =>
    errors[field] ? `warranty-policy-${field}-error` : help ? `warranty-policy-${field}-help` : undefined;
  const fieldNote = (field: keyof Errors, help?: string) =>
    errors[field] ? (
      <p id={`warranty-policy-${field}-error`} className="text-body text-destructive">{t(errors[field]!)}</p>
    ) : help ? (
      <p id={`warranty-policy-${field}-help`} className="text-body text-muted-foreground">{help}</p>
    ) : null;

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : requestClose())}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t(policy ? "editTitle" : "addTitle")}</DialogTitle>
            {policy ? <DialogDescription>{t("editHelp")}</DialogDescription> : null}
          </DialogHeader>
          <form id="warranty-policy-form" method="post" noValidate className="space-y-4" onSubmit={submit}>
            {serverError ? <Alert variant="destructive"><AlertDescription>{serverError}</AlertDescription></Alert> : null}
            <div className="space-y-1.5">
              <Label htmlFor="warranty-policy-name">{t("name")}</Label>
              <Input
                id="warranty-policy-name"
                value={draft.name}
                maxLength={WARRANTY_LIMITS.nameLength * 2}
                aria-invalid={Boolean(errors.name)}
                aria-describedby={describedBy("name", true)}
                onChange={(event) => set("name", event.target.value)}
              />
              {fieldNote("name", t("nameHelp"))}
            </div>
            <fieldset className="space-y-2">
              <legend className="text-body font-medium">{t("provider")}</legend>
              <RadioGroup value={draft.provider} onValueChange={(value) => set("provider", value as WarrantyProvider)}>
                {(["brand", "store"] as const).map((provider) => (
                  <div key={provider} className="flex items-center gap-2">
                    <RadioGroupItem id={`warranty-policy-provider-${provider}`} value={provider} />
                    <Label htmlFor={`warranty-policy-provider-${provider}`}>{t(`provider.${provider}`)}</Label>
                  </div>
                ))}
              </RadioGroup>
            </fieldset>
            <div className="space-y-1.5">
              <Label htmlFor="warranty-policy-durationValue">{t("duration")}</Label>
              <div className="flex gap-2">
                <NumberInput
                  id="warranty-policy-durationValue"
                  integer
                  className="w-24"
                  value={draft.durationValue}
                  aria-invalid={Boolean(errors.durationValue)}
                  aria-describedby={describedBy("durationValue", false)}
                  onValueChange={(value) => set("durationValue", value)}
                />
                <NativeSelect
                  id="warranty-policy-durationUnit"
                  aria-label={t("duration")}
                  className="w-36"
                  value={draft.durationUnit}
                  onValueChange={(value) => set("durationUnit", value as WarrantyDurationUnit)}
                >
                  {WARRANTY_DURATION_UNITS.map((unit) => <option key={unit} value={unit}>{t(`unit.${unit}`)}</option>)}
                </NativeSelect>
              </div>
              {fieldNote("durationValue")}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="warranty-policy-replacementDays">{t("replacement")}</Label>
              <NumberInput
                id="warranty-policy-replacementDays"
                integer
                className="w-24"
                value={draft.replacementDays}
                aria-invalid={Boolean(errors.replacementDays)}
                aria-describedby={describedBy("replacementDays", true)}
                onValueChange={(value) => set("replacementDays", value)}
              />
              {fieldNote("replacementDays", t("replacementHelp"))}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="warranty-policy-terms">{t("terms")}</Label>
              <Textarea
                id="warranty-policy-terms"
                rows={5}
                value={draft.terms}
                aria-invalid={Boolean(errors.terms)}
                aria-describedby={describedBy("terms", true)}
                onChange={(event) => set("terms", event.target.value)}
              />
              {fieldNote("terms", t("termsHelp"))}
            </div>
            {preview ? <p className="rounded-lg bg-muted px-3 py-2 text-body">{preview}</p> : null}
          </form>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={save.isPending} onClick={requestClose}>{t("cancel")}</Button>
            <Button type="submit" form="warranty-policy-form" loading={save.isPending}>{t(policy ? "save" : "create")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog {...discardDialog} />
    </>
  );
}
