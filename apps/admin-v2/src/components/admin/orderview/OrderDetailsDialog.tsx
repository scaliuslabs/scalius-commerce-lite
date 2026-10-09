import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { validateAndFormatPhone } from "@scalius/shared/customer-utils";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Form, FormField } from "~/components/ui/form";
import { Input } from "~/components/ui/input";
import { AdminPhoneInput } from "~/components/admin/shared/AdminPhoneInput";
import { AddressFields, SkipAddressValidation, useAddressErrors } from "~/components/admin/address/AddressFields";
import { BillingAddressFields } from "~/components/admin/address/BillingAddressFields";
import {
  orderAddressDraft,
  orderAddressInput,
  orderBillingDraft,
  orderBillingInput,
  readAddressProblems,
  readBillingAddressProblems,
  usesLocationPicker,
  type AddressDraft,
  type AddressProblem,
  type AddressProblemField,
} from "~/components/admin/address/address-draft";
import { useMessages } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";
import { resourceMessages } from "~/i18n/resource";
import { orderErrorMessage, useUpdateOrderDetails } from "~/lib/api-mutations/orders";
import type { Order } from "./types";
import { Field } from "~/components/ui/field";

function isPhone(value: string): boolean {
  try {
    validateAndFormatPhone(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Customer, delivery and billing details of an order that hasn't shipped
 * (Shopify's address modal). An order that ships nothing has no delivery
 * address to edit; its billing address is optional.
 */
export function OrderDetailsDialog({ order, open, onOpenChange }: {
  order: Order;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useMessages(orderDetailMessages);
  const r = useMessages(resourceMessages);
  const mutation = useUpdateOrderDetails();
  const schema = useMemo(() => z.object({
    customerName: z.string().trim().min(3, t("details.nameInvalid")).max(100, t("details.nameInvalid")),
    customerPhone: z.string().refine(isPhone, t("details.phoneInvalid")),
    customerEmail: z.union([z.literal(""), z.email(t("details.emailInvalid"))]),
  }), [t]);
  type Values = z.input<typeof schema>;
  const values = (): Values => ({
    customerName: order.customerName,
    customerPhone: order.customerPhone ?? "",
    customerEmail: order.customerEmail ?? "",
  });
  const form = useForm<Values>({ resolver: zodResolver(schema), mode: "onBlur", defaultValues: values() });
  // The address is its own draft: its fields follow its country's rules.
  const [address, setAddress] = useState<AddressDraft>(() => orderAddressDraft(order));
  const [localErrors, setLocalErrors] = useState<Partial<Record<AddressProblemField, string>>>({});
  const [problems, setProblems] = useState<AddressProblem[] | null>(null);
  const [skipValidation, setSkipValidation] = useState(false);
  const serverErrors = useAddressErrors(problems, address.countryCode);
  const ships = order.requiresShipping !== false;
  // The billing address is sent only once staff change it, so an older order stays without one.
  const [billing, setBilling] = useState<AddressDraft>(() => orderBillingDraft(order, order.shippingCountryCode ?? undefined));
  const [billingSame, setBillingSame] = useState(!order.billingCountryCode);
  const [billingDirty, setBillingDirty] = useState(false);
  const [billingProblems, setBillingProblems] = useState<AddressProblem[] | null>(null);
  const billingErrors = useAddressErrors(billingProblems, billing.countryCode);

  useEffect(() => {
    if (!open) return;
    form.reset(values());
    setAddress(orderAddressDraft(order));
    setLocalErrors({});
    setProblems(null);
    setSkipValidation(Boolean(order.shippingValidationSkipped || order.billingValidationSkipped));
    setBilling(orderBillingDraft(order, order.shippingCountryCode ?? undefined));
    // Ticked unless the order has a billing address of its own.
    setBillingSame(!order.billingCountryCode);
    setBillingDirty(false);
    setBillingProblems(null);
    mutation.reset();
    // Start from the saved order every time the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /** Bangladesh keeps its rules here (a full line, a city and a thana); another country's are checked by the API. */
  const checkAddress = (draft: AddressDraft) => {
    const errors: Partial<Record<AddressProblemField, string>> = {};
    const line = draft.line1.trim();
    if (usesLocationPicker(draft.countryCode)) {
      if (line.length < 10 || line.length > 500) errors.line1 = t("details.addressInvalid");
      if (!draft.city) errors.city = t("details.cityRequired");
      if (!draft.zone) errors.zone = t("details.zoneRequired");
    } else if (!line) {
      errors.line1 = t("details.addressInvalid");
    }
    return errors;
  };

  const submit = form.handleSubmit((data) => {
    const errors = ships ? checkAddress(address) : {};
    setLocalErrors(errors);
    if (Object.keys(errors).length > 0) return;
    mutation.mutate({
      orderId: order.id,
      expectedVersion: order.version,
      customerName: data.customerName.trim(),
      customerPhone: data.customerPhone,
      customerEmail: data.customerEmail.trim() || null,
      ...(ships ? orderAddressInput(address) : {}),
      ...(billingDirty ? orderBillingInput(billing, ships && billingSame) : {}),
      ...(skipValidation ? { skipAddressValidation: true } : {}),
    }, {
      onSuccess: () => onOpenChange(false),
      onError: (error) => {
        setProblems(readAddressProblems(error));
        setBillingProblems(readBillingAddressProblems(error));
      },
    });
  });
  const addressErrors = { ...serverErrors, ...localErrors };

  return (
    <Dialog open={open} onOpenChange={(next) => !mutation.isPending && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("details.title")}</DialogTitle>
          <DialogDescription>{t("details.help")}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form id="order-details-form" method="post" className="space-y-4" onSubmit={submit} noValidate>
            {mutation.isError && !problems && !billingProblems ? <Alert variant="destructive"><AlertDescription>{orderErrorMessage(mutation.error)}</AlertDescription></Alert> : null}
            <FormField
              control={form.control}
              name="customerName"
              render={({ field, fieldState }) => (
                <Field label={t("details.name")} error={fieldState.error?.message}><Input {...field} autoComplete="name" /></Field>
              )}
            />
            <FormField
              control={form.control}
              name="customerPhone"
              render={({ field, fieldState }) => (
                <Field label={t("details.phone")} error={fieldState.error?.message}>
                  <AdminPhoneInput value={field.value} onChange={field.onChange} onBlur={field.onBlur} required />
                </Field>
              )}
            />
            <FormField
              control={form.control}
              name="customerEmail"
              render={({ field, fieldState }) => (
                <Field label={t("details.email")} error={fieldState.error?.message}><Input {...field} type="email" autoComplete="email" /></Field>
              )}
            />
            {ships ? (
              <AddressFields
                idPrefix="order-details-address"
                value={address}
                onChange={(next) => {
                  setAddress(next);
                  if (Object.keys(localErrors).length > 0) setLocalErrors(checkAddress(next));
                }}
                errors={addressErrors}
                disabled={mutation.isPending}
              />
            ) : null}
            <BillingAddressFields
              idPrefix="order-details-billing"
              ships={ships}
              sameAsShipping={billingSame}
              onSameAsShippingChange={(checked) => {
                setBillingSame(checked);
                setBillingDirty(true);
              }}
              value={billing}
              onChange={(next) => {
                setBilling(next);
                setBillingDirty(true);
              }}
              errors={billingErrors}
              disabled={mutation.isPending}
            />
            {problems || billingProblems ? (
              <SkipAddressValidation
                id="order-details-skip-validation"
                checked={skipValidation}
                onCheckedChange={setSkipValidation}
                disabled={mutation.isPending}
              />
            ) : null}
          </form>
        </Form>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
            {r("cancel")}
          </Button>
          <Button type="submit" form="order-details-form" loading={mutation.isPending}>{r("save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
