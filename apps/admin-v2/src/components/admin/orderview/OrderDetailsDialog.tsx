import { useEffect, useMemo } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { validateAndFormatPhone } from "@scalius/shared/customer-utils";
import { Alert } from "~/components/ui/alert";
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
import { Textarea } from "~/components/ui/textarea";
import { AdminPhoneInput } from "~/components/admin/shared/AdminPhoneInput";
import { LocationSelector } from "~/components/admin/LocationSelector";
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
    shippingAddress: z.string().trim().min(10, t("details.addressInvalid")).max(500, t("details.addressInvalid")),
    city: z.string().nullable().refine(Boolean, t("details.cityRequired")),
    zone: z.string().nullable().refine(Boolean, t("details.zoneRequired")),
    area: z.string().nullable(),
    cityName: z.string().optional(),
    zoneName: z.string().optional(),
    areaName: z.string().optional(),
  }), [t]);
  type Values = z.input<typeof schema>;
  const values = (): Values => ({
    customerName: order.customerName,
    customerPhone: order.customerPhone,
    customerEmail: order.customerEmail ?? "",
    shippingAddress: order.shippingAddress,
    city: order.city || null,
    zone: order.zone || null,
    area: order.area,
    cityName: order.cityName ?? "",
    zoneName: order.zoneName ?? "",
    areaName: order.areaName ?? "",
  });
  const form = useForm<Values>({ resolver: zodResolver(schema), mode: "onBlur", defaultValues: values() });

  useEffect(() => {
    if (!open) return;
    form.reset(values());
    mutation.reset();
    // Start from the saved order every time the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = form.handleSubmit((data) => {
    mutation.mutate({
      orderId: order.id,
      expectedVersion: order.version,
      customerName: data.customerName.trim(),
      customerPhone: data.customerPhone,
      customerEmail: data.customerEmail.trim() || null,
      shippingAddress: data.shippingAddress.trim(),
      city: data.city ?? "",
      zone: data.zone ?? "",
      area: data.area || null,
    }, { onSuccess: () => onOpenChange(false) });
  });

  return (
    <Dialog open={open} onOpenChange={(next) => !mutation.isPending && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("details.title")}</DialogTitle>
          <DialogDescription>{t("details.help")}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form id="order-details-form" method="post" className="space-y-4" onSubmit={submit} noValidate>
            {mutation.isError ? <Alert variant="destructive">{orderErrorMessage(mutation.error)}</Alert> : null}
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
            <FormField
              control={form.control}
              name="shippingAddress"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("details.address")}</FormLabel>
                  <FormControl><Textarea {...field} rows={2} autoComplete="street-address" /></FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <LocationSelector required={{ city: true, zone: true }} />
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
