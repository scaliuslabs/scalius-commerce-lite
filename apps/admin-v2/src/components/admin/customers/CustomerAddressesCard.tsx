// The customer page's address book (Shopify's customer addresses; MARKETS-
// DESIGN D7): every saved address, the default first, with add, edit, set
// as default, set as default billing (0119) and delete. Each change saves at once from its dialog; the page
// save bar is for the contact fields.
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal } from "lucide-react";
import { formatPhoneForDisplay } from "@scalius/shared/phone-input";
import { validateAndFormatPhone } from "@scalius/shared/customer-utils";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Label } from "~/components/ui/label";
import { AdminPhoneInput } from "~/components/admin/shared/AdminPhoneInput";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { AddressFields, SkipAddressValidation, useAddressErrors } from "~/components/admin/address/AddressFields";
import {
  addressDraftFrom,
  addressDraftInput,
  emptyAddressDraft,
  readAddressProblems,
  type AddressDraft,
  type AddressProblem,
} from "~/components/admin/address/address-draft";
import { useMessages } from "~/i18n";
import { addressMessages } from "~/i18n/address";
import { customerAddressesMessages } from "~/i18n/customer-addresses";
import { resourceMessages } from "~/i18n/resource";
import {
  createCustomerAddress,
  deleteCustomerAddress,
  setDefaultBillingCustomerAddress,
  setDefaultCustomerAddress,
  updateCustomerAddress,
} from "~/lib/api-mutations/customers";
import type { CustomerDto } from "~/lib/api-query-options/customers";
import { getServerFnError } from "~/lib/api-helpers";
import { countryName } from "~/lib/country-name";
import { formatAddressLines } from "~/lib/location-presentation";
import { queryKeys } from "~/lib/query-keys";
import { toast } from "~/lib/toast";

type CustomerAddress = CustomerDto["addresses"][number];

/** The address book's dialog target: a new address, or the one being edited. */
type Editing = { kind: "new" } | { kind: "edit"; address: CustomerAddress };

function isPhone(value: string): boolean {
  try {
    validateAndFormatPhone(value);
    return true;
  } catch {
    return false;
  }
}

export function CustomerAddressesCard({ customerId, addresses, canEdit }: {
  customerId: string;
  addresses: readonly CustomerAddress[];
  canEdit: boolean;
}) {
  const t = useMessages(customerAddressesMessages);
  const a = useMessages(addressMessages);
  const r = useMessages(resourceMessages);
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [deleting, setDeleting] = useState<CustomerAddress | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.customers.detail(customerId) }),
    queryClient.invalidateQueries({ queryKey: queryKeys.customers.list() }),
  ]);
  const run = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await action();
      await refresh();
      toast.success(done);
    } catch (error) {
      toast.error(getServerFnError(error, r("saveFailedHelp")));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle>{t("addresses")}</CardTitle>
        {canEdit ? (
          <Button variant="ghost" size="sm" onClick={() => setEditing({ kind: "new" })}>{t("addAddress")}</Button>
        ) : null}
      </CardHeader>
      <CardContent>
        {addresses.length === 0 ? (
          <p className="text-body text-muted-foreground">{t("noAddresses")}</p>
        ) : (
          <ul className="divide-y">
            {addresses.map((address) => {
              const lines = formatAddressLines(address, countryName);
              const recipient = [address.name, address.company].filter(Boolean).join(", ");
              return (
                <li key={address.id} className="flex items-start justify-between gap-2 py-3 first:pt-0 last:pb-0">
                  <div className="min-w-0 space-y-0.5 text-body">
                    {address.isDefault || address.isDefaultBilling || address.validationSkipped ? (
                      <div className="flex flex-wrap gap-1.5 pb-1">
                        {address.isDefault ? <Badge variant="secondary">{t("defaultAddress")}</Badge> : null}
                        {address.isDefaultBilling ? <Badge variant="secondary">{t("defaultBillingAddress")}</Badge> : null}
                        {address.validationSkipped ? <Badge variant="warning" title={a("notCheckedHelp")}>{a("notChecked")}</Badge> : null}
                      </div>
                    ) : null}
                    {recipient ? <p className="font-medium">{recipient}</p> : null}
                    {lines.map((line, index) => (
                      <p key={index} className={index === 0 && !recipient ? "break-words" : "break-words text-muted-foreground"}>{line}</p>
                    ))}
                    {address.phone ? <p className="font-mono text-muted-foreground">{formatPhoneForDisplay(address.phone)}</p> : null}
                  </div>
                  {canEdit ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label={t("addressActions")} disabled={busy}>
                          <MoreHorizontal aria-hidden="true" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => setEditing({ kind: "edit", address })}>{t("editAddress")}</DropdownMenuItem>
                        {!address.isDefault ? (
                          <DropdownMenuItem
                            onSelect={() => void run(() => setDefaultCustomerAddress(customerId, address.id), t("defaultSet"))}
                          >
                            {t("setDefault")}
                          </DropdownMenuItem>
                        ) : null}
                        {!address.isDefaultBilling ? (
                          <DropdownMenuItem
                            onSelect={() => void run(() => setDefaultBillingCustomerAddress(customerId, address.id), t("defaultBillingSet"))}
                          >
                            {t("setDefaultBilling")}
                          </DropdownMenuItem>
                        ) : null}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(address)}>{t("deleteAddress")}</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
      <AddressDialog
        customerId={customerId}
        editing={editing}
        isOnlyAddress={addresses.length === 0}
        onOpenChange={(open) => { if (!open) setEditing(null); }}
        onSaved={async (message) => {
          await refresh();
          toast.success(message);
          setEditing(null);
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => { if (!open) setDeleting(null); }}
        title={t("deleteAddressTitle", { address: deleting ? `“${formatAddressLines(deleting, countryName)[0] ?? ""}”` : "" })}
        description={t("deleteAddressBody")}
        confirmLabel={t("deleteAddress")}
        isLoading={busy}
        onConfirm={() => {
          const target = deleting;
          setDeleting(null);
          if (target) void run(() => deleteCustomerAddress(customerId, target.id), t("addressDeleted"));
        }}
      />
    </Card>
  );
}

function AddressDialog({ customerId, editing, isOnlyAddress, onOpenChange, onSaved }: {
  customerId: string;
  editing: Editing | null;
  isOnlyAddress: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (message: string) => Promise<void>;
}) {
  const t = useMessages(customerAddressesMessages);
  const r = useMessages(resourceMessages);
  const open = editing !== null;
  const current = editing?.kind === "edit" ? editing.address : null;
  const [draft, setDraft] = useState<AddressDraft>(() => emptyAddressDraft());
  const [phone, setPhone] = useState("");
  const [makeDefault, setMakeDefault] = useState(false);
  const [problems, setProblems] = useState<AddressProblem[] | null>(null);
  const [skipValidation, setSkipValidation] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const errors = useAddressErrors(problems, draft.countryCode);
  const phoneError = phone.trim() && !isPhone(phone) ? t("addressPhoneInvalid") : undefined;

  // Start from the saved address (or an empty one) each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setDraft(current ? addressDraftFrom(current) : emptyAddressDraft());
    setPhone(current?.phone ?? current?.phoneRaw ?? "");
    setMakeDefault(false);
    setProblems(null);
    setSkipValidation(Boolean(current?.validationSkipped));
    setFailure(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, current?.id]);

  const save = async () => {
    if (phoneError) return;
    setPending(true);
    setFailure(null);
    const body = {
      ...addressDraftInput(draft),
      phone: phone.trim() || null,
      ...(makeDefault ? { isDefault: true } : {}),
      ...(skipValidation ? { skipValidation: true } : {}),
    };
    try {
      if (current) await updateCustomerAddress(customerId, current.id, body);
      else await createCustomerAddress(customerId, body);
      await onSaved(current ? t("addressSaved") : t("addressAdded"));
    } catch (error) {
      const refused = readAddressProblems(error);
      setProblems(refused);
      setFailure(refused ? null : getServerFnError(error, r("saveFailedHelp")));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{current ? t("editAddress") : t("addAddress")}</DialogTitle>
        </DialogHeader>
        <form
          id="customer-address-form"
          method="post"
          className="space-y-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {failure ? <p role="alert" className="text-body text-destructive">{failure}</p> : null}
          <AddressFields idPrefix="customer-address" value={draft} onChange={setDraft} errors={errors} showRecipient disabled={pending} />
          <div className="grid gap-2">
            <Label htmlFor="customer-address-phone">{t("addressPhone")}</Label>
            <AdminPhoneInput
              id="customer-address-phone"
              value={phone}
              onChange={setPhone}
              disabled={pending}
              aria-invalid={phoneError || errors.phone ? true : undefined}
              aria-describedby={phoneError || errors.phone ? "customer-address-phone-error" : undefined}
            />
            {phoneError || errors.phone ? (
              <p id="customer-address-phone-error" className="text-body text-destructive">{phoneError ?? errors.phone}</p>
            ) : null}
          </div>
          {!isOnlyAddress && !current?.isDefault ? (
            <div className="flex items-center gap-2">
              <Checkbox id="customer-address-default" checked={makeDefault} disabled={pending}
                onCheckedChange={(next) => setMakeDefault(next === true)} />
              <Label htmlFor="customer-address-default">{t("makeDefault")}</Label>
            </div>
          ) : null}
          {problems ? (
            <SkipAddressValidation id="customer-address-skip" checked={skipValidation} onCheckedChange={setSkipValidation} disabled={pending} />
          ) : null}
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>{r("cancel")}</Button>
          <Button type="submit" form="customer-address-form" loading={pending}>{r("save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
