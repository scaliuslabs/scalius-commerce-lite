import { PresenceSlot, presenceKey } from "~/lib/realtime/store";
import { useState } from "react";
import { toast } from "~/lib/toast";
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
import { Textarea } from "~/components/ui/textarea";
import { useMessages } from "~/i18n";
import { purchasingMessages } from "~/i18n/purchasing";
import { resourceMessages } from "~/i18n/resource";
import { useSaveSupplier, type Supplier } from "~/lib/api-query-options/purchasing";
import { PurchasingProblemBanner, readPurchasingProblem, type PurchasingProblem } from "./purchasing-problem";
import { Field, FieldRow } from "~/components/ui/field";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface SupplierFields {
  name: string;
  contactName: string;
  phone: string;
  email: string;
  notes: string;
}

function fieldsOf(supplier: Supplier | null): SupplierFields {
  return {
    name: supplier?.name ?? "",
    contactName: supplier?.contactName ?? "",
    phone: supplier?.phone ?? "",
    email: supplier?.email ?? "",
    notes: supplier?.notes ?? "",
  };
}

/**
 * Add or edit a supplier. Always mounted; the parent re-keys it per opening
 * so each opening starts from the supplier as it is.
 */
export function SupplierDialog({
  supplier,
  open,
  onOpenChange,
  onSaved,
  initialName = "",
}: {
  /** The supplier being edited; null adds one. */
  supplier: Supplier | null;
  /** A new supplier's name typed into a search that found nobody. */
  initialName?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: (supplier: Supplier) => void;
}) {
  const t = useMessages(purchasingMessages);
  const r = useMessages(resourceMessages);
  const save = useSaveSupplier();
  const [fields, setFields] = useState<SupplierFields>(() => ({ ...fieldsOf(supplier), ...(supplier ? {} : { name: initialName }) }));
  const [touched, setTouched] = useState(false);
  const [problem, setProblem] = useState<PurchasingProblem | null>(null);
  const set = (key: keyof SupplierFields) => (value: string) => setFields((current) => ({ ...current, [key]: value }));

  const key = open && supplier ? presenceKey("supplier", supplier.id) : null;
  const dirty = JSON.stringify(fields) !== JSON.stringify(fieldsOf(supplier));

  const errors = {
    name: touched && !fields.name.trim() ? t("nameRequired") : null,
    email: touched && fields.email.trim() && !EMAIL.test(fields.email.trim()) ? t("emailInvalid") : null,
  };

  const submit = () => {
    setTouched(true);
    if (!fields.name.trim() || (fields.email.trim() && !EMAIL.test(fields.email.trim())) || save.isPending) return;
    setProblem(null);
    const blank = (value: string) => value.trim() || null;
    save.mutate(
      {
        id: supplier?.id ?? null,
        version: supplier?.version ?? null,
        body: {
          name: fields.name.trim(),
          contactName: blank(fields.contactName),
          phone: blank(fields.phone),
          email: blank(fields.email),
          notes: blank(fields.notes),
        },
      },
      {
        onSuccess: (saved) => {
          toast.success(t(supplier ? "supplierSaved" : "supplierAdded"));
          onSaved?.(saved);
          onOpenChange(false);
        },
        onError: (error) => setProblem(readPurchasingProblem(error)),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!save.isPending) onOpenChange(next); }}>
      <DialogContent data-presence-root={key ?? undefined}>
        <DialogHeader>
          <div className="flex flex-wrap items-center gap-2"><DialogTitle className="min-w-0 flex-1">{t(supplier ? "editSupplier" : "addSupplier")}</DialogTitle><PresenceSlot presenceKey={key} revision={supplier?.version} dirty={dirty} /></div>
          {supplier ? <DialogDescription>{supplier.name}</DialogDescription> : null}
        </DialogHeader>
        <form
          id="supplier-form"
          method="post"
          noValidate
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <PurchasingProblemBanner problem={problem} staleText={t("supplierChanged")} failedText={t("supplierSaveFailed")} />
          <Field id="supplier-name" label={t("supplierName")} error={errors.name}>
            <Input
              id="supplier-name"
              maxLength={120}
              autoComplete="organization"
              value={fields.name}
              aria-invalid={errors.name ? true : undefined}
              aria-describedby={errors.name ? "supplier-name-error" : undefined}
              onChange={(event) => set("name")(event.target.value)}
            />
          </Field>
          <FieldRow>
            <Field id="supplier-contact" label={t("contactName")}>
              <Input
                id="supplier-contact"
                maxLength={120}
                autoComplete="off"
                value={fields.contactName}
                onChange={(event) => set("contactName")(event.target.value)}
              />
            </Field>
            <Field id="supplier-phone" label={t("phone")}>
              <Input
                id="supplier-phone"
                type="tel"
                inputMode="tel"
                maxLength={32}
                autoComplete="off"
                value={fields.phone}
                onChange={(event) => set("phone")(event.target.value)}
              />
            </Field>
          </FieldRow>
          <Field id="supplier-email" label={t("email")} error={errors.email}>
            <Input
              id="supplier-email"
              type="email"
              maxLength={254}
              autoComplete="off"
              value={fields.email}
              aria-invalid={errors.email ? true : undefined}
              aria-describedby={errors.email ? "supplier-email-error" : undefined}
              onChange={(event) => set("email")(event.target.value)}
            />
          </Field>
          <Field id="supplier-notes" label={t("notes")}>
            <Textarea
              id="supplier-notes"
              maxLength={2000}
              rows={3}
              value={fields.notes}
              onChange={(event) => set("notes")(event.target.value)}
            />
          </Field>
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={save.isPending} onClick={() => onOpenChange(false)}>{r("cancel")}</Button>
          <Button type="submit" form="supplier-form" loading={save.isPending}>{supplier ? r("save") : t("addSupplier")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
