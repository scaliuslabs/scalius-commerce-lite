import React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useWatch } from "react-hook-form";
import { ADMIN_PERMISSIONS } from "@/lib/admin-permissions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useOrderForm } from "./OrderFormContext";
import { orderNeedsAddress } from "./order-line-properties";
import { LocationPicker } from "@/components/admin/location/LocationPicker";
import { deliveryLocationByIdQueryOptions } from "@/lib/api-query-options/delivery";
import { AdminPhoneInput } from "@/components/admin/shared/AdminPhoneInput";
import { usePermissions } from "@/contexts/PermissionContext";
import { customersQueryOptions } from "@/lib/api-query-options/customers";
import { useDebounce } from "@/hooks/use-debounce";
import { useMessages } from "@/i18n";
import { orderFormMessages } from "@/i18n/order-form";
import { customerFill, customerLookupTerm, findCustomerByPhone, isGuestRecord } from "./customer-lookup";

/** Element ids of the address pickers (focus on a validation error). */
export const ORDER_LOCATION_IDS = { city: "order-city", zone: "order-zone", area: "order-area" } as const;

/**
 * New orders only: once the phone is a complete number, finds the saved
 * customer with that number and fills the fields the merchant left empty
 * (name, email, last address). The phone goes to the API, never the URL.
 */
function useReturningCustomer() {
  const { form, isEdit } = useOrderForm();
  const queryClient = useQueryClient();
  const { hasPermission } = usePermissions();
  const phone = useWatch({ control: form.control, name: "customerPhone" });
  const term = useDebounce(customerLookupTerm(phone ?? ""), 400);
  const enabled = !isEdit && term !== null && hasPermission(ADMIN_PERMISSIONS.CUSTOMERS_VIEW);
  const lookup = useQuery({
    ...customersQueryOptions({ page: 1, limit: 5, search: term ?? "" }),
    enabled,
    retry: false,
  });
  const customer = enabled && lookup.data
    ? findCustomerByPhone(lookup.data.customers, phone ?? "")
    : null;
  const [filledFor, setFilledFor] = React.useState<{ phone: string; filled: boolean } | null>(null);

  React.useEffect(() => {
    if (!customer || filledFor?.phone === customer.phone) return;
    let cancelled = false;
    void (async () => {
      // The saved address is used only while its city is still an active delivery city.
      const city = customer.city
        ? await queryClient.fetchQuery(deliveryLocationByIdQueryOptions(customer.city)).catch(() => null)
        : null;
      if (cancelled) return;
      const values = form.getValues();
      const fill = customerFill(customer, {
        customerName: values.customerName ?? "",
        customerEmail: values.customerEmail ?? null,
        shippingAddress: values.shippingAddress ?? "",
        city: values.city ?? "",
        zone: values.zone ?? "",
        area: values.area ?? null,
      }, new Set(city?.type === "city" && city.isActive ? [city.id] : []));
      const set = { shouldDirty: true, shouldValidate: true };
      if (fill.customerName !== undefined) form.setValue("customerName", fill.customerName, set);
      if (fill.customerEmail !== undefined) form.setValue("customerEmail", fill.customerEmail, set);
      if (fill.shippingAddress !== undefined) form.setValue("shippingAddress", fill.shippingAddress, set);
      if (fill.city !== undefined) {
        form.setValue("city", fill.city, set);
        form.setValue("cityName", city?.name ?? "");
        form.setValue("zoneName", "");
        form.setValue("areaName", null);
      }
      if (fill.zone !== undefined) form.setValue("zone", fill.zone, set);
      if (fill.area !== undefined) form.setValue("area", fill.area, set);
      setFilledFor({ phone: customer.phone, filled: Object.keys(fill).length > 0 });
    })();
    return () => {
      cancelled = true;
    };
  }, [customer, filledFor, form, queryClient]);

  return customer ? { customer, filled: filledFor?.phone === customer.phone && filledFor.filled } : null;
}

/** Side column: Customer, Delivery address and Notes cards. */
export function CustomerInfoSection() {
  const { form, refs, handleKeyDown } = useOrderForm();
  const t = useMessages(orderFormMessages);
  const [city, zone, area, cityName, zoneName, areaName, items, shippingMethodKind] = useWatch({
    control: form.control,
    name: ["city", "zone", "area", "cityName", "zoneName", "areaName", "items", "shippingMethodKind"],
  });
  // Pickup orders and orders of services have no delivery address (the phone stays required).
  const needsAddress = orderNeedsAddress({ items: items ?? [], shippingMethodKind });
  const noAddressReason = needsAddress
    ? null
    : shippingMethodKind === "pickup" ? t("pickupNoAddress") : t("noDeliveryNoAddress");
  const returning = useReturningCustomer();
  const errors = form.formState.errors;
  // A picked location is an edit: mark it dirty so Save turns on.
  const pick = { shouldDirty: true, shouldValidate: form.formState.isSubmitted };

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{t("customer")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <FormField
            control={form.control}
            name="customerName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("name")}</FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    ref={(el) => {
                      field.ref(el);
                      refs.customerNameRef.current = el;
                    }}
                    onKeyDown={(e) => handleKeyDown(e, refs.customerPhoneRef)}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="customerPhone"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("phone")}</FormLabel>
                <FormControl>
                  <AdminPhoneInput
                    ref={(el) => {
                      field.ref(el);
                      refs.customerPhoneRef.current = el;
                    }}
                    name={field.name}
                    value={field.value}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                    onKeyDown={(e: React.KeyboardEvent) => handleKeyDown(e, refs.customerEmailRef)}
                  />
                </FormControl>
                <FormDescription>
                  {returning
                    ? isGuestRecord(returning.customer)
                      ? [
                          returning.customer.totalOrders === 1
                            ? t("phoneOrdersOne")
                            : t("phoneOrders", { count: returning.customer.totalOrders }),
                          returning.filled ? t("nameFromLatestOrder") : null,
                        ].filter(Boolean).join(" ")
                      : [
                          returning.customer.totalOrders === 1
                            ? t("returningCustomerOne")
                            : t("returningCustomer", { count: returning.customer.totalOrders }),
                          returning.filled ? t("filledFromCustomer") : null,
                        ].filter(Boolean).join(" ")
                    : t("phoneHelp")}
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="customerEmail"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("email")}</FormLabel>
                <FormControl>
                  <Input
                    type="email"
                    {...field}
                    value={field.value || ""}
                    onChange={(e) => field.onChange(e.target.value || null)}
                    ref={(el) => {
                      field.ref(el);
                      refs.customerEmailRef.current = el;
                    }}
                    onKeyDown={(e) => handleKeyDown(e, refs.shippingAddressRef)}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("deliveryAddress")}</CardTitle>
        </CardHeader>
        {noAddressReason ? (
          <CardContent>
            <p className="text-body text-muted-foreground">{noAddressReason}</p>
          </CardContent>
        ) : (
        <CardContent className="space-y-4">
          <FormField
            control={form.control}
            name="shippingAddress"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("address")}</FormLabel>
                <FormControl>
                  <Textarea
                    rows={3}
                    {...field}
                    ref={(el) => {
                      field.ref(el);
                      refs.shippingAddressRef.current = el;
                    }}
                    onKeyDown={(e) => handleKeyDown(e, refs.cityButtonRef)}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <LocationPicker
            ids={ORDER_LOCATION_IDS}
            required={{ city: true, zone: true }}
            refs={{ city: refs.cityButtonRef, zone: refs.zoneButtonRef, area: refs.areaButtonRef }}
            value={{
              city: city ? { id: city, name: cityName } : null,
              zone: zone ? { id: zone, name: zoneName } : null,
              area: area ? { id: area, name: areaName } : null,
            }}
            errors={{ city: errors.city?.message, zone: errors.zone?.message, area: errors.area?.message }}
            onChange={(next) => {
              form.setValue("city", next.city?.id ?? "", pick);
              form.setValue("zone", next.zone?.id ?? "", pick);
              form.setValue("area", next.area?.id ?? null, pick);
              form.setValue("cityName", next.city?.name ?? "");
              form.setValue("zoneName", next.zone?.name ?? "");
              form.setValue("areaName", next.area?.name ?? null);
            }}
          />
        </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("notes")}</CardTitle>
        </CardHeader>
        <CardContent>
          <FormField
            control={form.control}
            name="notes"
            render={({ field }) => (
              <FormItem>
                <FormControl>
                  <Textarea
                    rows={3}
                    aria-label={t("notes")}
                    {...field}
                    value={field.value || ""}
                    // Cleared notes are "none" again, so undoing a note clears the save bar.
                    onChange={(e) => field.onChange(e.target.value || null)}
                    ref={(el) => {
                      field.ref(el);
                      refs.notesRef.current = el;
                    }}
                    onKeyDown={(e) => handleKeyDown(e, refs.productSearchInputRef)}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </CardContent>
      </Card>
    </>
  );
}
