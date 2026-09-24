import React from "react";
import { useQuery } from "@tanstack/react-query";
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { useOrderForm } from "./OrderFormContext";
import type { DeliveryLocation } from "./types";
import { AdminPhoneInput } from "@/components/admin/shared/AdminPhoneInput";
import { usePermissions } from "@/contexts/PermissionContext";
import { customersQueryOptions } from "@/lib/api-query-options/customers";
import { useDebounce } from "@/hooks/use-debounce";
import { useMessages } from "@/i18n";
import { orderFormMessages } from "@/i18n/order-form";
import { customerFill, customerLookupTerm, findCustomerByPhone } from "./customer-lookup";

const SELECT_KEY = { city: "selectCity", zone: "selectZone", area: "selectArea" } as const;

/** One searchable city / zone / area picker. */
function LocationPicker({
  name,
  options,
  disabled,
  loading,
  buttonRef,
  onPick,
}: {
  name: keyof typeof SELECT_KEY;
  options: DeliveryLocation[];
  disabled?: boolean;
  loading?: boolean;
  buttonRef: React.RefObject<HTMLButtonElement | null>;
  onPick: (location: DeliveryLocation) => void;
}) {
  const { form } = useOrderForm();
  const t = useMessages(orderFormMessages);
  const [open, setOpen] = React.useState(false);
  const selectKey = SELECT_KEY[name];

  return (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => {
        const selected = options.find((option) => option.id === field.value);
        return (
          <FormItem className="flex flex-col">
            <FormLabel>{t(name)}</FormLabel>
            <Popover open={open} onOpenChange={setOpen}>
              <PopoverTrigger asChild>
                <FormControl>
                  <Button
                    ref={(el) => {
                      field.ref(el);
                      buttonRef.current = el;
                    }}
                    type="button"
                    variant="outline"
                    role="combobox"
                    aria-expanded={open}
                    disabled={disabled || loading}
                    className="w-full justify-between"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === "ArrowDown") {
                        e.preventDefault();
                        setOpen(true);
                      }
                    }}
                  >
                    <span className={cn("truncate", !selected && "text-muted-foreground")}>
                      {loading ? t("loading") : selected?.name ?? t(selectKey)}
                    </span>
                    <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </FormControl>
              </PopoverTrigger>
              <PopoverContent align="start">
                <Command>
                  <CommandInput
                    placeholder={t(selectKey)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        setOpen(false);
                        buttonRef.current?.focus();
                      }
                    }}
                  />
                  <CommandList>
                    <CommandEmpty>{name === "area" && options.length === 0 ? t("noAreas") : t("noMatch")}</CommandEmpty>
                    <CommandGroup>
                      {options.map((option) => (
                        <CommandItem
                          key={option.id}
                          value={option.name}
                          onSelect={() => {
                            onPick(option);
                            setOpen(false);
                          }}
                        >
                          <Check
                            className={cn(
                              "h-4 w-4",
                              option.id === field.value ? "opacity-100" : "opacity-0",
                            )}
                          />
                          {option.name}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            <FormMessage />
          </FormItem>
        );
      }}
    />
  );
}

/**
 * New orders only: once the phone is a complete number, finds the saved
 * customer with that number and fills the fields the merchant left empty
 * (name, email, last address). The phone goes to the API, never the URL.
 */
function useReturningCustomer() {
  const { form, isEdit, locations, loadZones, loadAreas } = useOrderForm();
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
    if (!customer || filledFor?.phone === customer.phone || locations.cities.length === 0) return;
    const values = form.getValues();
    const fill = customerFill(customer, {
      customerName: values.customerName ?? "",
      customerEmail: values.customerEmail ?? null,
      shippingAddress: values.shippingAddress ?? "",
      city: values.city ?? "",
      zone: values.zone ?? "",
      area: values.area ?? null,
    }, new Set(locations.cities.map((city) => city.id)));
    const set = { shouldDirty: true, shouldValidate: true };
    if (fill.customerName !== undefined) form.setValue("customerName", fill.customerName, set);
    if (fill.customerEmail !== undefined) form.setValue("customerEmail", fill.customerEmail, set);
    if (fill.shippingAddress !== undefined) form.setValue("shippingAddress", fill.shippingAddress, set);
    if (fill.city !== undefined) form.setValue("city", fill.city, set);
    if (fill.zone !== undefined) form.setValue("zone", fill.zone, set);
    if (fill.area !== undefined) form.setValue("area", fill.area, set);
    if (fill.city) void loadZones(fill.city);
    if (fill.zone) void loadAreas(fill.zone);
    setFilledFor({ phone: customer.phone, filled: Object.keys(fill).length > 0 });
  }, [customer, filledFor, form, loadAreas, loadZones, locations.cities]);

  return customer ? { customer, filled: filledFor?.phone === customer.phone && filledFor.filled } : null;
}

/** Side column: Customer, Delivery address and Notes cards. */
export function CustomerInfoSection() {
  const { form, locations, isLoading, loadZones, loadAreas, refs, handleKeyDown } =
    useOrderForm();
  const t = useMessages(orderFormMessages);
  const [city, zone] = form.watch(["city", "zone"]);
  const returning = useReturningCustomer();
  // A picked location is an edit: mark it dirty so Save turns on.
  const pick = { shouldDirty: true, shouldValidate: true };

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
                    ? [
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
            name="city"
            options={locations.cities}
            buttonRef={refs.cityButtonRef}
            onPick={(location) => {
              form.setValue("city", location.id, pick);
              form.setValue("zone", "", { shouldDirty: true });
              form.setValue("area", null, { shouldDirty: true });
              void loadZones(location.id);
              refs.zoneButtonRef.current?.focus();
            }}
          />
          <LocationPicker
            name="zone"
            options={locations.zones}
            disabled={!city}
            loading={isLoading.zones}
            buttonRef={refs.zoneButtonRef}
            onPick={(location) => {
              form.setValue("zone", location.id, pick);
              form.setValue("area", null, { shouldDirty: true });
              void loadAreas(location.id);
              refs.areaButtonRef.current?.focus();
            }}
          />
          <LocationPicker
            name="area"
            options={locations.areas}
            disabled={!zone}
            loading={isLoading.areas}
            buttonRef={refs.areaButtonRef}
            onPick={(location) => {
              form.setValue("area", location.id, pick);
              refs.notesRef.current?.focus();
            }}
          />
        </CardContent>
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
