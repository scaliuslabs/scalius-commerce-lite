import React from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { cn } from "@/lib/utils";
import { useOrderForm } from "./OrderFormContext";

export function CustomerInfoSection() {
  const { form, locations, isLoading, loadZones, loadAreas, refs, handleKeyDown } =
    useOrderForm();

  const [citySearchOpen, setCitySearchOpen] = React.useState(false);
  const [zoneSearchOpen, setZoneSearchOpen] = React.useState(false);
  const [areaSearchOpen, setAreaSearchOpen] = React.useState(false);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Customer Information</CardTitle>
        <CardDescription>
          Enter the customer's contact and shipping details.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <FormField
            control={form.control}
            name="customerName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Customer Name</FormLabel>
                <FormControl>
                  <Input
                    placeholder="Enter customer name"
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
                <FormLabel>Phone Number</FormLabel>
                <FormControl>
                  <Input
                    placeholder="Enter phone number"
                    {...field}
                    ref={(el) => {
                      field.ref(el);
                      refs.customerPhoneRef.current = el;
                    }}
                    onKeyDown={(e) => handleKeyDown(e, refs.customerEmailRef)}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="customerEmail"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Email (Optional)</FormLabel>
              <FormControl>
                <Input
                  type="email"
                  placeholder="Enter email address"
                  {...field}
                  value={field.value || ""}
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

        <FormField
          control={form.control}
          name="shippingAddress"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Shipping Address</FormLabel>
              <FormControl>
                <Textarea
                  placeholder="Enter shipping address"
                  className="h-20 resize-none"
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

        <div className="grid gap-4 md:grid-cols-3">
          <FormField
            control={form.control}
            name="city"
            render={({ field }) => (
              <FormItem className="flex flex-col">
                <FormLabel>City</FormLabel>
                <Popover
                  open={citySearchOpen}
                  onOpenChange={setCitySearchOpen}
                >
                  <PopoverTrigger asChild>
                    <FormControl>
                      <Button
                        ref={refs.cityButtonRef}
                        variant="outline"
                        role="combobox"
                        aria-expanded={citySearchOpen}
                        className={cn(
                          "w-full justify-between",
                          !field.value && "text-muted-foreground",
                        )}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === "ArrowDown") {
                            e.preventDefault();
                            setCitySearchOpen(true);
                          }
                        }}
                      >
                        {field.value
                          ? locations.cities.find(
                              (city) => city.id === field.value,
                            )?.name
                          : "Select city"}
                        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                      </Button>
                    </FormControl>
                  </PopoverTrigger>
                  <PopoverContent className="w-[--radix-popover-trigger-width] max-h-[--radix-popover-content-available-height] p-0">
                    <Command>
                      <CommandInput
                        placeholder="Search city..."
                        onKeyDown={(e) => {
                          if (e.key === "Escape") {
                            setCitySearchOpen(false);
                            refs.cityButtonRef.current?.focus();
                          }
                        }}
                      />
                      <CommandList>
                        <CommandEmpty>No city found.</CommandEmpty>
                        <CommandGroup>
                          {locations.cities.map((city) => (
                            <CommandItem
                              value={city.name}
                              key={city.id}
                              onSelect={() => {
                                form.setValue("city", city.id);
                                form.setValue("zone", "");
                                form.setValue("area", null);
                                loadZones(city.id);
                                setCitySearchOpen(false);
                                refs.zoneButtonRef.current?.focus();
                              }}
                            >
                              <Check
                                className={cn(
                                  "mr-2 h-4 w-4",
                                  city.id === field.value
                                    ? "opacity-100"
                                    : "opacity-0",
                                )}
                              />
                              {city.name}
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="zone"
            render={({ field }) => (
              <FormItem className="flex flex-col">
                <FormLabel>Zone</FormLabel>
                <Popover
                  open={zoneSearchOpen}
                  onOpenChange={setZoneSearchOpen}
                >
                  <PopoverTrigger asChild>
                    <FormControl>
                      <Button
                        ref={refs.zoneButtonRef}
                        variant="outline"
                        role="combobox"
                        aria-expanded={zoneSearchOpen}
                        disabled={!form.watch("city") || isLoading.zones}
                        className={cn(
                          "w-full justify-between",
                          !field.value && "text-muted-foreground",
                        )}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === "ArrowDown") {
                            e.preventDefault();
                            setZoneSearchOpen(true);
                          }
                        }}
                      >
                        {isLoading.zones
                          ? "Loading..."
                          : field.value
                            ? locations.zones.find(
                                (zone) => zone.id === field.value,
                              )?.name
                            : "Select zone"}
                        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                      </Button>
                    </FormControl>
                  </PopoverTrigger>
                  <PopoverContent className="w-[--radix-popover-trigger-width] max-h-[--radix-popover-content-available-height] p-0">
                    <Command>
                      <CommandInput
                        placeholder="Search zone..."
                        onKeyDown={(e) => {
                          if (e.key === "Escape") {
                            setZoneSearchOpen(false);
                            refs.zoneButtonRef.current?.focus();
                          }
                        }}
                      />
                      <CommandList>
                        <CommandEmpty>No zone found.</CommandEmpty>
                        <CommandGroup>
                          {locations.zones.map((zone) => (
                            <CommandItem
                              value={zone.name}
                              key={zone.id}
                              onSelect={() => {
                                form.setValue("zone", zone.id);
                                form.setValue("area", null);
                                loadAreas(zone.id);
                                setZoneSearchOpen(false);
                                refs.areaButtonRef.current?.focus();
                              }}
                            >
                              <Check
                                className={cn(
                                  "mr-2 h-4 w-4",
                                  zone.id === field.value
                                    ? "opacity-100"
                                    : "opacity-0",
                                )}
                              />
                              {zone.name}
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="area"
            render={({ field }) => (
              <FormItem className="flex flex-col">
                <FormLabel>Area (Optional)</FormLabel>
                <Popover
                  open={areaSearchOpen}
                  onOpenChange={setAreaSearchOpen}
                >
                  <PopoverTrigger asChild>
                    <FormControl>
                      <Button
                        ref={refs.areaButtonRef}
                        variant="outline"
                        role="combobox"
                        disabled={!form.watch("zone") || isLoading.areas}
                        aria-expanded={areaSearchOpen}
                        className={cn(
                          "w-full justify-between",
                          !field.value && "text-muted-foreground",
                        )}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === "ArrowDown") {
                            e.preventDefault();
                            setAreaSearchOpen(true);
                          }
                        }}
                      >
                        {isLoading.areas
                          ? "Loading..."
                          : field.value
                            ? locations.areas.find(
                                (area) => area.id === field.value,
                              )?.name ?? "Select area"
                            : "Select area"}
                        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                      </Button>
                    </FormControl>
                  </PopoverTrigger>
                  <PopoverContent className="w-[--radix-popover-trigger-width] max-h-[--radix-popover-content-available-height] p-0">
                    <Command>
                      <CommandInput
                        placeholder="Search area..."
                        onKeyDown={(e) => {
                          if (e.key === "Escape") {
                            setAreaSearchOpen(false);
                            refs.areaButtonRef.current?.focus();
                          }
                        }}
                      />
                      <CommandList>
                        <CommandEmpty>No area found.</CommandEmpty>
                        <CommandGroup>
                          {locations.areas.length === 0 &&
                            !isLoading.areas && (
                              <div className="py-6 text-center text-sm">
                                No areas available for this zone.
                              </div>
                            )}
                          {locations.areas.map((area) => (
                            <CommandItem
                              value={area.name}
                              key={area.id}
                              onSelect={() => {
                                form.setValue("area", area.id);
                                setAreaSearchOpen(false);
                                refs.notesRef.current?.focus();
                              }}
                            >
                              <Check
                                className={cn(
                                  "mr-2 h-4 w-4",
                                  area.id === field.value
                                    ? "opacity-100"
                                    : "opacity-0",
                                )}
                              />
                              {area.name}
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="notes"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Notes (Optional)</FormLabel>
              <FormControl>
                <Textarea
                  placeholder="Enter any additional notes"
                  className="h-20 resize-none"
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
  );
}