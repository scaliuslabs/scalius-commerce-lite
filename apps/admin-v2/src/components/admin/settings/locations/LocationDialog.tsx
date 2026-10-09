// Add or edit one inventory location. An edit is guarded by the version the
// dialog opened with; a stale save says so instead of overwriting.
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "~/lib/toast";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { useDirtyDialogClose } from "~/components/admin/shared/use-dirty-dialog-close";
import { useSubmitOnce } from "~/components/admin/shared/use-submit-once";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { useMessages } from "~/i18n";
import { settingsLocationsMessages, type SettingsLocationsMessageKey } from "~/i18n/settings-locations";
import { isAdminApiConflictError } from "~/lib/admin-api-error";
import { getServerFnError } from "~/lib/api-helpers";
import {
  useSaveInventoryLocation,
  type InventoryLocation,
  type InventoryLocationBody,
} from "~/lib/api-query-options/inventory-locations";
import { Field } from "~/components/ui/field";

const KINDS = ["warehouse", "store", "other"] as const;
type Kind = (typeof KINDS)[number];
const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

interface Draft {
  name: string;
  code: string;
  kind: Kind;
  addressLine1: string;
  addressLine2: string;
  city: string;
  postalCode: string;
  phone: string;
}

type Errors = Partial<Record<"name" | "code", SettingsLocationsMessageKey>>;

function draftOf(location: InventoryLocation | null): Draft {
  return {
    name: location?.name ?? "",
    code: location?.code ?? "",
    kind: location?.kind ?? "warehouse",
    addressLine1: location?.addressLine1 ?? "",
    addressLine2: location?.addressLine2 ?? "",
    city: location?.city ?? "",
    postalCode: location?.postalCode ?? "",
    phone: location?.phone ?? "",
  };
}

/** The request body, or the problems to show at their fields. */
export function locationBody(draft: Draft): { body: InventoryLocationBody } | { errors: Errors } {
  const errors: Errors = {};
  const name = draft.name.trim();
  const code = draft.code.trim();
  if (!name) errors.name = "nameRequired";
  if (!code) errors.code = "codeRequired";
  else if (!CODE_PATTERN.test(code) || code.length > 24) errors.code = "codeInvalid";
  if (Object.keys(errors).length > 0) return { errors };
  const optional = (value: string) => value.trim() || null;
  return {
    body: {
      name,
      code,
      kind: draft.kind,
      addressLine1: optional(draft.addressLine1),
      addressLine2: optional(draft.addressLine2),
      city: optional(draft.city),
      postalCode: optional(draft.postalCode),
      phone: optional(draft.phone),
    },
  };
}

export function LocationDialog({ location, open, onOpenChange }: {
  /** null adds a location. */
  location: InventoryLocation | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useMessages(settingsLocationsMessages);
  const [draft, setDraft] = useState<Draft>(() => draftOf(location));
  const [errors, setErrors] = useState<Errors>({});
  const save = useSaveInventoryLocation();
  const submitOnce = useSubmitOnce();
  const reset = save.reset;

  useEffect(() => {
    if (!open) return;
    setDraft(draftOf(location));
    setErrors({});
    reset();
  }, [open, location, reset]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(location));
  const { requestClose, discardDialog } = useDirtyDialogClose({ dirty, busy: save.isPending, onClose: () => onOpenChange(false) });
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    if (key in errors) setErrors((current) => ({ ...current, [key]: undefined }));
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = locationBody(draft);
    if ("errors" in result) {
      setErrors(result.errors);
      const first = (["name", "code"] as const).find((field) => result.errors[field]);
      if (first) document.getElementById(`inventory-location-${first}`)?.focus();
      return;
    }
    // One request at a time: a double click must not create the location twice.
    submitOnce(async () => {
      await save.mutateAsync({ id: location?.id ?? null, version: location?.version ?? null, body: result.body });
      toast.success(t(location ? "saved" : "created"));
      onOpenChange(false);
    });
  };

  // A 409 is either a code another location uses (shown at the field) or a stale version.
  const conflict = save.error !== null && isAdminApiConflictError(save.error);
  const codeTaken = conflict && /code/i.test(getServerFnError(save.error, ""));
  const serverError = save.error && !codeTaken
    ? conflict ? t("conflict") : getServerFnError(save.error, t("saveFailed"))
    : null;
  const text = (field: Exclude<keyof Draft, "kind">, label: SettingsLocationsMessageKey, options: { help?: string; maxLength: number; type?: string }) => {
    const error = field === "name"
      ? errors.name
      : field === "code" ? errors.code ?? (codeTaken && draft.code.trim() ? "codeTaken" : undefined) : undefined;
    const id = `inventory-location-${field}`;
    return (
      <Field id={id} label={t(label)}>
        <Input
          id={id}
          type={options.type ?? "text"}
          value={draft[field]}
          maxLength={options.maxLength}
          aria-invalid={error ? true : undefined}
          aria-describedby={error || options.help ? `${id}-note` : undefined}
          onChange={(event) => set(field, event.target.value)}
        />
        {error ? (
          <p id={`${id}-note`} className="text-body text-destructive">{t(error)}</p>
        ) : options.help ? (
          <p id={`${id}-note`} className="text-body text-muted-foreground">{options.help}</p>
        ) : null}
      </Field>
    );
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : requestClose())}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t(location ? "editTitle" : "addTitle")}</DialogTitle>
          </DialogHeader>
          <form id="inventory-location-form" method="post" noValidate className="space-y-4" onSubmit={submit}>
            {serverError ? <Alert variant="destructive"><AlertDescription>{serverError}</AlertDescription></Alert> : null}
            <div className="grid gap-4 sm:grid-cols-2">
              {text("name", "name", { maxLength: 80 })}
              {text("code", "code", { maxLength: 24, help: t("codeHelp") })}
            </div>
            <Field id="inventory-location-kind" label={t("kind")}>
              <SearchableSelect
                id="inventory-location-kind"
                triggerClassName="w-full"
                value={draft.kind}
                onValueChange={(value) => {
                  if (KINDS.includes(value as Kind)) set("kind", value as Kind);
                }}
                options={KINDS.map((kind) => ({ value: kind, label: t(`kind.${kind}`) }))}
              />
            </Field>
            {text("addressLine1", "addressLine1", { maxLength: 200 })}
            {text("addressLine2", "addressLine2", { maxLength: 200 })}
            <div className="grid gap-4 sm:grid-cols-2">
              {text("city", "city", { maxLength: 80 })}
              {text("postalCode", "postalCode", { maxLength: 20 })}
            </div>
            {text("phone", "phone", { maxLength: 32, type: "tel" })}
          </form>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={save.isPending} onClick={requestClose}>{t("cancel")}</Button>
            <Button type="submit" form="inventory-location-form" loading={save.isPending}>{t(location ? "save" : "create")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog {...discardDialog} />
    </>
  );
}
