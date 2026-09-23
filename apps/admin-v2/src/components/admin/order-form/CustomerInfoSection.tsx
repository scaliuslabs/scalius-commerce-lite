import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  FormControl,
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
import { useMessages } from "@/i18n";
import { orderFormMessages } from "@/i18n/order-form";

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
                    ref={buttonRef}
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

/** Side column: Customer, Delivery address and Notes cards. */
export function CustomerInfoSection() {
  const { form, isEdit, locations, isLoading, loadZones, loadAreas, refs, handleKeyDown } =
    useOrderForm();
  const t = useMessages(orderFormMessages);
  const initialPhone = React.useRef(isEdit ? form.getValues("customerPhone") : undefined);
  const [city, zone] = form.watch(["city", "zone"]);
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
                    ref={refs.customerPhoneRef}
                    value={field.value}
                    onChange={field.onChange}
                    preserveExistingValue={initialPhone.current}
                    onKeyDown={(e: React.KeyboardEvent) => handleKeyDown(e, refs.customerEmailRef)}
                  />
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
                    onKeyDown={(e) => handleKeyDown(e, refs.productSearchButtonRef)}
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
