import React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useWatch } from "react-hook-form";
import { ADMIN_PERMISSIONS } from "@/lib/admin-permissions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FormField, FormItem, FormLabel, FormControl, FormDescription, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useOrderForm } from "./OrderFormContext";
import { orderNeedsAddress } from "./order-line-properties";
import { AddressFields, SkipAddressValidation } from "@/components/admin/address/AddressFields";
import type { AddressDraft, AddressProblemField } from "@/components/admin/address/address-draft";
import { deliveryLocationByIdQueryOptions } from "@/lib/api-query-options/delivery";
import { AdminPhoneInput } from "@/components/admin/shared/AdminPhoneInput";
import { usePermissions } from "@/contexts/PermissionContext";
import { customersQueryOptions } from "@/lib/api-query-options/customers";
import { useDebounce } from "@/hooks/use-debounce";
import { useMessages } from "@/i18n";
import { orderFormMessages } from "@/i18n/order-form";
import { customerFill, customerLookupTerm, findCustomerByPhone, isGuestRecord } from "./customer-lookup";
import { Field } from "~/components/ui/field";

/** Element ids of the address fields (`AddressFields` with the "order" prefix), to focus on a validation error. */
export const ORDER_ADDRESS_IDS = {
  shippingCountryCode: "order-country",
  shippingAddress: "order-line1",
  shippingAddressLine2: "order-line2",
  shippingDependentLocality: "order-dependentLocality",
  shippingLocality: "order-locality",
  shippingAdminArea: "order-adminArea",
  shippingPostalCode: "order-postalCode",
  shippingCompany: "order-company",
  city: "order-city",
  zone: "order-zone",
  area: "order-area",
} as const;

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
      // A saved Bangladesh address is used only while its city is still an active delivery city.
      const savedCity = customer.defaultAddress?.countryCode === "BD" ? customer.defaultAddress.city : null;
      const city = savedCity
        ? await queryClient.fetchQuery(deliveryLocationByIdQueryOptions(savedCity)).catch(() => null)
        : null;
      if (cancelled) return;
      const values = form.getValues();
      const fill = customerFill(customer, {
        customerName: values.customerName ?? "",
        customerEmail: values.customerEmail ?? null,
        shippingCountryCode: values.shippingCountryCode ?? "BD",
        shippingAddress: values.shippingAddress ?? "",
        city: values.city ?? "",
        zone: values.zone ?? "",
        area: values.area ?? null,
      }, new Set(city?.type === "city" && city.isActive ? [city.id] : []));
      const set = { shouldDirty: true, shouldValidate: true };
      if (fill.customerName !== undefined) form.setValue("customerName", fill.customerName, set);
      if (fill.customerEmail !== undefined) form.setValue("customerEmail", fill.customerEmail, set);
      if (fill.shippingCountryCode !== undefined) form.setValue("shippingCountryCode", fill.shippingCountryCode, set);
      if (fill.shippingAddress !== undefined) form.setValue("shippingAddress", fill.shippingAddress, set);
      for (const name of ["shippingAddressLine2", "shippingDependentLocality", "shippingLocality", "shippingAdminArea", "shippingPostalCode"] as const) {
        if (fill[name] !== undefined) form.setValue(name, fill[name], set);
      }
      if (fill.city !== undefined) {
        form.setValue("city", fill.city, set);
        form.setValue("cityName", city?.name ?? "");
        form.setValue("zoneName", customer.defaultAddress?.zoneName ?? "");
        form.setValue("areaName", customer.defaultAddress?.areaName ?? null);
      }
      if (fill.zone !== undefined) form.setValue("zone", fill.zone, set);
      if (fill.area !== undefined) form.setValue("area", fill.area, set);
      // Found by its phone, so it has one.
      setFilledFor({ phone: customer.phone ?? "", filled: Object.keys(fill).length > 0 });
    })();
    return () => {
      cancelled = true;
    };
  }, [customer, filledFor, form, queryClient]);

  return customer ? { customer, filled: filledFor?.phone === customer.phone && filledFor.filled } : null;
}

/** The order's address fields as the form holds them (flat `shipping*` values plus Bangladesh's ids). */
const ORDER_ADDRESS_FIELDS = {
  countryCode: "shippingCountryCode",
  line1: "shippingAddress",
  line2: "shippingAddressLine2",
  dependentLocality: "shippingDependentLocality",
  locality: "shippingLocality",
  adminArea: "shippingAdminArea",
  postalCode: "shippingPostalCode",
  company: "shippingCompany",
  city: "city",
  zone: "zone",
  area: "area",
} as const;

/** The delivery address: the shared country-aware editor bound to the order form. */
function OrderAddressFields() {
  const { form, refs, handleKeyDown } = useOrderForm();
  const values = useWatch({
    control: form.control,
    name: [
      "shippingCountryCode", "shippingAddress", "shippingAddressLine2", "shippingDependentLocality", "shippingLocality",
      "shippingAdminArea", "shippingPostalCode", "shippingCompany", "city", "zone", "area", "cityName", "zoneName", "areaName",
    ],
  });
  const [countryCode, line1, line2, dependentLocality, locality, adminArea, postalCode, company, city, zone, area, cityName, zoneName, areaName] = values;
  const draft: AddressDraft = {
    countryCode: countryCode || "BD",
    name: "",
    company: company ?? "",
    line1: line1 ?? "",
    line2: line2 ?? "",
    dependentLocality: dependentLocality ?? "",
    locality: locality ?? "",
    adminArea: adminArea ?? "",
    postalCode: postalCode ?? "",
    city: city || null,
    zone: zone || null,
    area: area || null,
    cityName: cityName ?? "",
    zoneName: zoneName ?? "",
    areaName: areaName ?? "",
  };
  const errors = form.formState.errors;
  const fieldErrors = Object.fromEntries(
    Object.entries(ORDER_ADDRESS_FIELDS).map(([field, name]) => [field, errors[name]?.message as string | undefined]),
  ) as Partial<Record<AddressProblemField, string>>;
  // An edit marks the form dirty so Save turns on; a picked place revalidates once saving was tried.
  const set = { shouldDirty: true, shouldValidate: form.formState.isSubmitted };

  return (
    <AddressFields
      idPrefix="order"
      value={draft}
      errors={fieldErrors}
      line1Ref={refs.shippingAddressRef}
      locationRefs={{ city: refs.cityButtonRef, zone: refs.zoneButtonRef, area: refs.areaButtonRef }}
      onLine1KeyDown={(event) => handleKeyDown(event, refs.cityButtonRef)}
      onChange={(next) => {
        const text: Array<[keyof AddressDraft, (typeof ORDER_ADDRESS_FIELDS)[keyof typeof ORDER_ADDRESS_FIELDS]]> = [
          ["countryCode", "shippingCountryCode"], ["line1", "shippingAddress"], ["line2", "shippingAddressLine2"],
          ["dependentLocality", "shippingDependentLocality"], ["locality", "shippingLocality"], ["adminArea", "shippingAdminArea"],
          ["postalCode", "shippingPostalCode"], ["company", "shippingCompany"],
        ];
        for (const [field, name] of text) {
          if (next[field] !== draft[field]) form.setValue(name, next[field] as string, set);
        }
        if (next.city !== draft.city) form.setValue("city", next.city ?? "", set);
        if (next.zone !== draft.zone) form.setValue("zone", next.zone ?? "", set);
        if (next.area !== draft.area) form.setValue("area", next.area ?? null, set);
        form.setValue("cityName", next.cityName);
        form.setValue("zoneName", next.zoneName);
        form.setValue("areaName", next.areaName || null);
      }}
    />
  );
}

/** Side column: Customer, Delivery address and Notes cards. */
export function CustomerInfoSection() {
  const { form, refs, handleKeyDown, addressRefused } = useOrderForm();
  const t = useMessages(orderFormMessages);
  const [items, shippingMethodKind, skipAddressValidation] = useWatch({
    control: form.control,
    name: ["items", "shippingMethodKind", "skipAddressValidation"],
  });
  // Pickup orders and orders of services have no delivery address (the phone stays required).
  const needsAddress = orderNeedsAddress({ items: items ?? [], shippingMethodKind });
  const noAddressReason = needsAddress
    ? null
    : shippingMethodKind === "pickup" ? t("pickupNoAddress") : t("noDeliveryNoAddress");
  const returning = useReturningCustomer();

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
            render={({ field, fieldState }) => (
              <Field label={t("name")} error={fieldState.error?.message}>
                <Input
                  {...field}
                  ref={(el) => {
                    field.ref(el);
                    refs.customerNameRef.current = el;
                  }}
                  onKeyDown={(e) => handleKeyDown(e, refs.customerPhoneRef)}
                />
              </Field>
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
            render={({ field, fieldState }) => (
              <Field label={t("email")} error={fieldState.error?.message}>
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
              </Field>
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
          <OrderAddressFields />
          {addressRefused || skipAddressValidation ? (
            <SkipAddressValidation
              id="order-address-skip"
              checked={skipAddressValidation ?? false}
              onCheckedChange={(checked) => form.setValue("skipAddressValidation", checked, { shouldDirty: true })}
            />
          ) : null}
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
            render={({ field, fieldState }) => (
              <Field error={fieldState.error?.message}>
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
              </Field>
            )}
          />
        </CardContent>
      </Card>
    </>
  );
}
