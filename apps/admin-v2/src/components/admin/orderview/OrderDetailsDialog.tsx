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
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "~/components/ui/form";
import { Input } from "~/components/ui/input";
import { AdminPhoneInput } from "~/components/admin/shared/AdminPhoneInput";
import { AddressFields, SkipAddressValidation, useAddressErrors } from "~/components/admin/address/AddressFields";
import {
  orderAddressDraft,
  orderAddressInput,
  readAddressProblems,
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

function isPhone(value: string): boolean {
  try {
    validateAndFormatPhone(value);
    return true;
  } catch {
    return false;
  }
}

/** Customer and delivery details of an order that hasn't shipped (Shopify's address modal). */
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
    customerPhone: order.customerPhone,
    customerEmail: order.customerEmail ?? "",
  });
  const form = useForm<Values>({ resolver: zodResolver(schema), mode: "onBlur", defaultValues: values() });
  // The address is its own draft: its fields follow its country's rules.
  const [address, setAddress] = useState<AddressDraft>(() => orderAddressDraft(order));
  const [localErrors, setLocalErrors] = useState<Partial<Record<AddressProblemField, string>>>({});
  const [problems, setProblems] = useState<AddressProblem[] | null>(null);
  const [skipValidation, setSkipValidation] = useState(false);
  const serverErrors = useAddressErrors(problems, address.countryCode);

  useEffect(() => {
    if (!open) return;
    form.reset(values());
    setAddress(orderAddressDraft(order));
    setLocalErrors({});
    setProblems(null);
    setSkipValidation(Boolean(order.shippingValidationSkipped));
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
    const errors = checkAddress(address);
    setLocalErrors(errors);
    if (Object.keys(errors).length > 0) return;
    mutation.mutate({
      orderId: order.id,
      expectedVersion: order.version,
      customerName: data.customerName.trim(),
      customerPhone: data.customerPhone,
      customerEmail: data.customerEmail.trim() || null,
      ...orderAddressInput(address),
      ...(skipValidation ? { skipAddressValidation: true } : {}),
    }, {
      onSuccess: () => onOpenChange(false),
      onError: (error) => setProblems(readAddressProblems(error)),
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
            {mutation.isError && !problems ? <Alert variant="destructive"><AlertDescription>{orderErrorMessage(mutation.error)}</AlertDescription></Alert> : null}
            <FormField
              control={form.control}
              name="customerName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("details.name")}</FormLabel>
                  <FormControl><Input {...field} autoComplete="name" /></FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="customerPhone"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("details.phone")}</FormLabel>
                  <FormControl>
                    <AdminPhoneInput value={field.value} onChange={field.onChange} onBlur={field.onBlur} required />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="customerEmail"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("details.email")}</FormLabel>
                  <FormControl><Input {...field} type="email" autoComplete="email" /></FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
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
            {problems ? (
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
