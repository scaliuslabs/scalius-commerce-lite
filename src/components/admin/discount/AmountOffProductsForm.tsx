// src/components/admin/discount/AmountOffProductsForm.tsx
import React, { useState, useEffect } from "react";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "../../ui/form";
import { ProductSelector } from "./ProductSelector";
import { CollectionSelector } from "./CollectionSelector";
import { Input } from "../../ui/input";
import { Button } from "../../ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "../../ui/popover";
import { Calendar } from "../../ui/calendar";
import { CalendarIcon, Percent } from "lucide-react"; 
import { Checkbox } from "../../ui/checkbox";
import { Switch } from "../../ui/switch"; 
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import { Separator } from "../../ui/separator";
import { useToast } from "@/hooks/use-toast";


// --- Interfaces (Unchanged) ---
interface Product {
  id: string;
  name: string;
  price: number;
  discountPercentage: number | null;
}
interface Collection {
  id: string;
  name: string;
  description: string | null;
  slug: string;
}

// --- Schema and Types (Updated) ---
const formSchema = z.object({
  code: z.string().min(1, "Discount code is required").max(50),
  valueType: z.enum(["percentage", "fixed_amount"]),
  discountValue: z
    .number({ invalid_type_error: "Must be a number" })
    .positive("Value must be positive"),
  appliesTo: z
    .object({
      products: z.array(z.string()),
      collections: z.array(z.string()),
    })
    .refine((data) => data.products.length > 0 || data.collections.length > 0, {
      message: "Please select at least one product or collection.",
    }),
  minPurchaseAmount: z.number().nullable().optional(),
  minQuantity: z.number().int().positive().nullable().optional(),
  maxUsesPerOrder: z.number().int().positive().nullable().optional(),
  maxUses: z.number().int().positive().nullable().optional(),
  limitOnePerCustomer: z.boolean(),
  combineWithProductDiscounts: z.boolean(),
  combineWithOrderDiscounts: z.boolean(),
  combineWithShippingDiscounts: z.boolean(),
  startDate: z.date({ required_error: "Start date is required." }),
  endDate: z.date().nullable().optional(),
  isActive: z.boolean(),
});

// Adjust FormValues to include the appliesTo structure for validation
type FormValues = z.infer<typeof formSchema>;

interface AmountOffProductsFormProps {
  defaultValues?: Partial<Omit<FormValues, "appliesTo"> & { id?: string }>; // Exclude appliesTo from default props
  initialSelectedProducts?: Product[];
  initialSelectedCollections?: Collection[];
}

export function AmountOffProductsForm({
  defaultValues,
  initialSelectedProducts = [],
  initialSelectedCollections = [],
}: AmountOffProductsFormProps) {
  const { toast } = useToast();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [selectedProducts, setSelectedProducts] = React.useState<Product[]>(
    initialSelectedProducts,
  );
  const [selectedCollections, setSelectedCollections] = React.useState<
    Collection[]
  >(initialSelectedCollections);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      code: "",
      valueType: "percentage",
      discountValue: 10,
      minPurchaseAmount: null,
      minQuantity: null,
      maxUsesPerOrder: null,
      maxUses: null,
      limitOnePerCustomer: false,
      combineWithProductDiscounts: false,
      combineWithOrderDiscounts: false,
      combineWithShippingDiscounts: false,
      startDate: new Date(),
      endDate: null,
      isActive: true,
      ...defaultValues,
      // Convert ISO date strings to Date objects if needed
      ...(defaultValues?.startDate && {
        startDate:
          typeof defaultValues.startDate === "string"
            ? new Date(defaultValues.startDate)
            : defaultValues.startDate,
      }),
      ...(defaultValues?.endDate && {
        endDate:
          typeof defaultValues.endDate === "string"
            ? new Date(defaultValues.endDate)
            : defaultValues.endDate,
      }),
      // Initialize appliesTo based on initial selections for validation trigger
      appliesTo: {
        products: initialSelectedProducts.map((p) => p.id),
        collections: initialSelectedCollections.map((c) => c.id),
      },
    },
  });

  // Update the virtual 'appliesTo' field whenever selections change
  useEffect(() => {
    form.setValue(
      "appliesTo",
      {
        products: selectedProducts.map((p) => p.id),
        collections: selectedCollections.map((c) => c.id),
      },
      { shouldValidate: true, shouldDirty: true }, // Trigger validation
    );
  }, [selectedProducts, selectedCollections, form]);

  // --- Submission Logic (Unchanged) ---
  const internalHandleSubmit = async (values: FormValues) => {
    setIsSubmitting(true);
    const discountId = defaultValues?.id;

    const ensuredValues = {
      ...values,
      startDate:
        values.startDate instanceof Date && !isNaN(values.startDate.getTime())
          ? values.startDate
          : new Date(),
    };

    try {
      const method = discountId ? "PUT" : "POST";
      const url = discountId
        ? `/api/discounts/${discountId}`
        : "/api/discounts";

      // Create payload excluding the virtual 'appliesTo' field
      const { appliesTo, ...restOfValues } = ensuredValues;
      const payload = {
        ...restOfValues,
        type: "amount_off_products",
        appliesToProducts: selectedProducts.map((p) => p.id),
        appliesToCollections: selectedCollections.map((c) => c.id),
        startDate: ensuredValues.startDate,
        endDate: values.endDate,
      };

      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          errorData?.error ||
            `Failed to ${discountId ? "update" : "create"} discount`,
        );
      }

      toast({
        title: `Discount ${discountId ? "updated" : "created"} successfully!`,
        description: `Code: ${values.code}`,
      });
      // Consider redirecting within a useEffect based on a success state
      // instead of direct manipulation here, but keep as is for now.
      window.location.href = "/admin/discounts";
    } catch (error) {
      const action = defaultValues?.id ? "updating" : "creating";
      console.error(`Error ${action} discount:`, error);
      toast({
        title: "Error",
        description:
          error instanceof Error ? error.message : "An unknown error occurred",
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  // Use form.handleSubmit which automatically prevents default
  const handleSubmit = form.handleSubmit(internalHandleSubmit);

  // Function to handle optional number inputs
  const handleOptionalNumberChange = (
    e: React.ChangeEvent<HTMLInputElement>,
    onChange: (...event: any[]) => void,
    isInt = false,
  ) => {
    const rawValue = e.target.value;
    if (rawValue === "") {
      onChange(null);
    } else {
      const value = isInt ? parseInt(rawValue, 10) : parseFloat(rawValue);
      if (!isNaN(value)) {
        onChange(value);
      }
      // Keep the invalid input in the field visually until blur/submit validation
      else if (rawValue === "-" || rawValue.endsWith(".")) {
        // Allow partial input for better UX
      } else {
        // Or force it back to null/previous valid value if preferred
        // onChange(null);
      }
    }
  };

  return (
    <Form {...form}>
      {/* Add novalidate to rely on react-hook-form/zod validation */}
      <form onSubmit={handleSubmit} className="space-y-8" noValidate>
        {/* Section 1: Core Discount Details */}
        <Card>
          <CardHeader>
            <CardTitle>Discount Details</CardTitle>
            <CardDescription>
              Define the code, type, and value for this product discount.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6 pt-4">
            {/* Discount Code */}
            <FormField
              control={form.control}
              name="code"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Discount Code *</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g., SUMMER20OFF" {...field} />
                  </FormControl>
                  <FormDescription>
                    Customers enter this at checkout. Must be unique.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Discount Value and Type */}
            <div className="grid grid-cols-1 gap-x-4 gap-y-6 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="valueType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Discount Type *</FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      defaultValue={field.value}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select discount type" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent className="rounded-xl bg-background">
                        <SelectItem value="percentage">Percentage</SelectItem>
                        <SelectItem value="fixed_amount">
                          Fixed Amount (৳)
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="discountValue"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Discount Value *</FormLabel>
                    <FormControl>
                      <div className="relative">
                        <Input
                          type="number"
                          step="any" // Allow decimals for fixed amount
                          placeholder={
                            form.watch("valueType") === "percentage"
                              ? "e.g., 15 for 15%"
                              : "e.g., 500 for ৳500"
                          }
                          {...field}
                          onChange={(e) => {
                            const value = parseFloat(e.target.value);
                            // Use empty string for input control if NaN, let Zod handle validation
                            field.onChange(isNaN(value) ? "" : value);
                          }}
                          value={field.value === 0 ? "" : field.value} // Handle initial 0 better
                        />
                        <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3">
                          {form.watch("valueType") === "percentage" ? (
                            <Percent className="h-4 w-4 text-muted-foreground" />
                          ) : (
                            <span className="text-sm text-muted-foreground">
                              ৳
                            </span>
                          )}
                        </div>
                      </div>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          </CardContent>
        </Card>

        {/* Section 2: Applies To */}
        <Card>
          <CardHeader>
            <CardTitle>Applies To</CardTitle>
            <CardDescription>
              Select the specific products or collections this discount will
              apply to.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 pt-4">
            {/* Product & Collection Selection */}
            <ProductSelector
              selectedProducts={selectedProducts}
              onChange={setSelectedProducts}
              buttonLabel="Browse Products"
            />
            <CollectionSelector
              selectedCollections={selectedCollections}
              onChange={setSelectedCollections}
              buttonLabel="Browse Collections"
            />

            {/* Display validation message for appliesTo */}
            <FormField
              control={form.control}
              name="appliesTo" // Connect to the virtual field
              render={({ fieldState }) => (
                <div>
                  {fieldState.error && (
                    <FormMessage>{fieldState.error.message}</FormMessage>
                  )}
                </div>
              )}
            />
            {/* Optional: Show a summary if needed */}
            {/* {(selectedProducts.length > 0 || selectedCollections.length > 0) && (
                            <p className="text-sm text-muted-foreground">
                                Applies to {selectedProducts.length} product(s) and {selectedCollections.length} collection(s).
                            </p>
                        )} */}
          </CardContent>
        </Card>

        {/* Section 3: Minimum Requirements */}
        <Card>
          <CardHeader>
            <CardTitle>Minimum Requirements</CardTitle>
            <CardDescription>
              Set conditions that must be met for the discount to apply
              (optional).
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6 pt-4">
            <div className="grid grid-cols-1 gap-x-4 gap-y-6 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="minPurchaseAmount"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Minimum Purchase Amount</FormLabel>
                    <FormControl>
                      <div className="relative">
                        <Input
                          type="number"
                          step="any"
                          placeholder="No minimum"
                          {...field}
                          value={field.value ?? ""} // Handle null correctly
                          onChange={(e) =>
                            handleOptionalNumberChange(e, field.onChange)
                          }
                        />
                        <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3">
                          <span className="text-sm text-muted-foreground">
                            ৳
                          </span>
                        </div>
                      </div>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="minQuantity"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Minimum Quantity of Items</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        step="1"
                        placeholder="No minimum"
                        {...field}
                        value={field.value ?? ""} // Handle null correctly
                        onChange={(e) =>
                          handleOptionalNumberChange(e, field.onChange, true)
                        } // Use integer parsing
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          </CardContent>
        </Card>

        {/* Section 4: Usage Limits */}
        <Card>
          <CardHeader>
            <CardTitle>Usage Limits</CardTitle>
            <CardDescription>
              Control how many times the discount can be used (optional).
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6 pt-4">
            <div className="grid grid-cols-1 gap-x-4 gap-y-6 sm:grid-cols-2">
              {/* Note: MaxUsesPerOrder might not be standard for 'Amount Off Products' type, but keeping as per original code */}
              <FormField
                control={form.control}
                name="maxUsesPerOrder"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Maximum Uses Per Order</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        step="1"
                        placeholder="Unlimited"
                        {...field}
                        value={field.value ?? ""}
                        onChange={(e) =>
                          handleOptionalNumberChange(e, field.onChange, true)
                        }
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="maxUses"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Total Usage Limit</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        step="1"
                        placeholder="Unlimited"
                        {...field}
                        value={field.value ?? ""}
                        onChange={(e) =>
                          handleOptionalNumberChange(e, field.onChange, true)
                        }
                      />
                    </FormControl>
                    <FormDescription>
                      Across all customers and orders.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {/* Use flex layout without border for checkboxes */}
            <FormField
              control={form.control}
              name="limitOnePerCustomer"
              render={({ field }) => (
                <FormItem className="flex flex-row items-center justify-between rounded-lg border bg-background p-4">
                  <div className="space-y-0.5">
                    <FormLabel className="text-base">
                      Limit to one use per customer
                    </FormLabel>
                    <FormDescription>
                      Prevent customers from using the code multiple times.
                    </FormDescription>
                  </div>
                  <FormControl>
                    <Switch
                      checked={field.value}
                      onCheckedChange={field.onChange}
                      aria-label="Limit one per customer toggle"
                    />
                  </FormControl>
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        {/* Section 5: Combinability */}
        <Card>
          <CardHeader>
            <CardTitle>Combinations</CardTitle>
            <CardDescription>
              Specify if this discount can be combined with others.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 pt-4">
            {/* Group checkboxes without individual borders */}
            <FormField
              control={form.control}
              name="combineWithProductDiscounts"
              render={({ field }) => (
                <FormItem className="flex items-center space-x-3">
                  <FormControl>
                    <Checkbox
                      id="combineProduct"
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  </FormControl>
                  <FormLabel
                    htmlFor="combineProduct"
                    className="font-normal text-sm cursor-pointer"
                  >
                    Combine with other product discounts
                  </FormLabel>
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="combineWithOrderDiscounts"
              render={({ field }) => (
                <FormItem className="flex items-center space-x-3">
                  <FormControl>
                    <Checkbox
                      id="combineOrder"
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  </FormControl>
                  <FormLabel
                    htmlFor="combineOrder"
                    className="font-normal text-sm cursor-pointer"
                  >
                    Combine with order discounts
                  </FormLabel>
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="combineWithShippingDiscounts"
              render={({ field }) => (
                <FormItem className="flex items-center space-x-3">
                  <FormControl>
                    <Checkbox
                      id="combineShipping"
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  </FormControl>
                  <FormLabel
                    htmlFor="combineShipping"
                    className="font-normal text-sm cursor-pointer"
                  >
                    Combine with shipping discounts
                  </FormLabel>
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        {/* Section 6: Active Dates */}
        <Card>
          <CardHeader>
            <CardTitle>Active Dates</CardTitle>
            <CardDescription>
              Schedule when the discount is available.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6 pt-4">
            <div className="grid grid-cols-1 gap-x-4 gap-y-6 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="startDate"
                render={({ field }) => (
                  <FormItem className="flex flex-col">
                    <FormLabel>Start Date *</FormLabel>
                    <Popover>
                      <PopoverTrigger asChild>
                        <FormControl>
                          <Button
                            variant={"outline"}
                            className={cn(
                              "w-full justify-start text-left font-normal",
                              !field.value && "text-muted-foreground",
                            )}
                          >
                            <CalendarIcon className="mr-2 h-4 w-4" />
                            {field.value &&
                            !isNaN(new Date(field.value).getTime()) ? (
                              format(new Date(field.value), "PPP") // Format: Sep 15, 2023
                            ) : (
                              <span>Pick a date</span>
                            )}
                          </Button>
                        </FormControl>
                      </PopoverTrigger>
                      <PopoverContent className="w-auto p-0" align="start">
                        <Calendar
                          mode="single"
                          selected={
                            field.value instanceof Date &&
                            !isNaN(field.value.getTime())
                              ? field.value
                              : undefined
                          }
                          onSelect={(date) =>
                            field.onChange(date || new Date())
                          } // Ensure date is always set
                          initialFocus
                        />
                      </PopoverContent>
                    </Popover>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="endDate"
                render={({ field }) => {
                  // Get startDate once outside the disabled callback to avoid re-renders
                  const startDate = form.getValues("startDate");
                  return (
                    <FormItem className="flex flex-col">
                      <FormLabel>End Date</FormLabel>
                      <Popover>
                        <PopoverTrigger asChild>
                          <FormControl>
                            <Button
                              variant={"outline"}
                              className={cn(
                                "w-full justify-start text-left font-normal",
                                !field.value && "text-muted-foreground",
                              )}
                            >
                              <CalendarIcon className="mr-2 h-4 w-4" />
                              {field.value &&
                              !isNaN(new Date(field.value).getTime()) ? (
                                format(new Date(field.value), "PPP")
                              ) : (
                                <span>No end date</span>
                              )}
                            </Button>
                          </FormControl>
                        </PopoverTrigger>
                        <PopoverContent className="w-auto p-0" align="start">
                          <Calendar
                            mode="single"
                            selected={
                              field.value instanceof Date &&
                              !isNaN(field.value.getTime())
                                ? field.value
                                : undefined
                            }
                            onSelect={(date) => field.onChange(date)} // Allows clearing the date
                            initialFocus
                            disabled={(date) => {
                              // Disable dates before the start date (if start date is valid)
                              return startDate && !isNaN(startDate.getTime())
                                ? date < startDate
                                : false;
                            }}
                          />
                        {/* Add a clear button */}
                        {field.value && (
                          <div className="p-2 border-t border-border">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="w-full justify-center"
                              onClick={() => field.onChange(null)}
                            >
                              Clear end date
                            </Button>
                          </div>
                        )}
                      </PopoverContent>
                    </Popover>
                    <FormDescription>
                      Optional. Discount expires at 11:59 PM on this day.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                );
                }}
              />
            </div>
          </CardContent>
        </Card>

        {/* Separator before final actions */}
        <Separator />

        {/* Final Actions: Status Toggle and Submit */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-6">
          {/* Status Toggle */}
          <FormField
            control={form.control}
            name="isActive"
            render={({ field }) => (
              <FormItem className="flex flex-row items-center space-x-3">
                <FormControl>
                  <Switch
                    id="isActiveSwitch"
                    checked={field.value}
                    onCheckedChange={field.onChange}
                    aria-labelledby="isActiveLabel"
                  />
                </FormControl>
                <FormLabel
                  id="isActiveLabel"
                  htmlFor="isActiveSwitch"
                  className="font-medium cursor-pointer"
                >
                  {field.value ? "Active" : "Inactive"}
                </FormLabel>
                <FormDescription>
                  {field.value
                    ? "This discount is currently active."
                    : "This discount is inactive and cannot be used."}
                </FormDescription>
              </FormItem>
            )}
          />

          {/* Submit/Cancel Buttons */}
          <div className="flex gap-2 self-end sm:self-auto">
            <Button
              type="button"
              variant="outline"
              onClick={() => window.history.back()} // Or redirect to list: window.location.href = "/admin/discounts"
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting
                ? "Saving..." // Simple loading state
                : defaultValues?.id
                  ? "Save Changes"
                  : "Create Discount"}
            </Button>
          </div>
        </div>
      </form>
    </Form>
  );
}