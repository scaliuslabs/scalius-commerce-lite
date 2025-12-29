// src/components/admin/discount/AmountOffOrderForm.tsx
import React, { useState } from "react";
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
} from "../../ui/form"; // Assuming correct path
import { Input } from "../../ui/input";
import { Button } from "../../ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../../ui/card"; // Assuming correct path
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../ui/select"; // Assuming correct path
import { Popover, PopoverContent, PopoverTrigger } from "../../ui/popover"; // Assuming correct path
import { Calendar } from "../../ui/calendar"; // Assuming correct path
import { CalendarIcon, Percent, Loader2, Info } from "lucide-react";
import { Checkbox } from "../../ui/checkbox"; // Assuming correct path
import { cn } from "@/lib/utils"; // Assuming correct path
import { format } from "date-fns";
import { Separator } from "../../ui/separator"; // Assuming correct path
import { useToast } from "@/hooks/use-toast"; // Assuming correct path
import { Alert, AlertDescription, AlertTitle } from "../../ui/alert"; // Add Alert for better info display

// --- Form Schema (Unchanged) ---
const formSchema = z
  .object({
    code: z
      .string()
      .min(3, { message: "Code must be at least 3 characters long" })
      .max(50, { message: "Code cannot exceed 50 characters" })
      // Add regex for better code format validation (example: no spaces)
      .regex(/^[a-zA-Z0-9_-]+$/, {
        message:
          "Code can only contain letters, numbers, underscores, and hyphens",
      }),
    valueType: z.enum(["percentage", "fixed_amount"]),
    discountValue: z.coerce // Use coerce for better number handling from input
      .number({ invalid_type_error: "Discount value must be a number" })
      .positive({ message: "Discount value must be positive" }),
    minPurchaseAmount: z.coerce
      .number({
        invalid_type_error: "Minimum purchase must be a number or empty",
      })
      .positive({ message: "Minimum purchase must be positive" })
      .nullable()
      .optional(),
    maxUsesPerOrder: z.coerce
      .number({
        invalid_type_error: "Max uses per order must be an integer or empty",
      })
      .int({ message: "Max uses per order must be a whole number" })
      .positive({ message: "Max uses per order must be positive" })
      .nullable()
      .optional(),
    maxUses: z.coerce
      .number({
        invalid_type_error: "Max total uses must be an integer or empty",
      })
      .int({ message: "Max total uses must be a whole number" })
      .positive({ message: "Max total uses must be positive" })
      .nullable()
      .optional(),
    limitOnePerCustomer: z.boolean(),
    combineWithProductDiscounts: z.boolean(),
    combineWithShippingDiscounts: z.boolean(),
    startDate: z.date({ required_error: "Start date is required" }),
    endDate: z.date().nullable().optional(),
    isActive: z.boolean(),
  })
  .refine(
    (data) => {
      // Ensure end date is not before start date
      if (data.endDate && data.startDate && data.endDate < data.startDate) {
        return false;
      }
      return true;
    },
    {
      message: "End date cannot be before the start date",
      path: ["endDate"], // Apply error to endDate field
    },
  );

type FormValues = z.infer<typeof formSchema>;

interface AmountOffOrderFormProps {
  defaultValues?: Partial<FormValues & { id?: string }>;
  onCancel?: () => void; // Optional cancel handler
}

// Helper component for section styling
const FormSection = ({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) => (
  <div className="grid grid-cols-1 gap-6 md:grid-cols-3 md:gap-10 py-6 first:pt-0 last:pb-0">
    <div className="md:col-span-1">
      <h3 className="text-lg font-medium text-foreground">{title}</h3>
      {description && (
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      )}
    </div>
    <div className="md:col-span-2 space-y-6">{children}</div>
  </div>
);

// Helper for checkbox form items
const CheckboxFormItem = ({
  name,
  label,
  description,
  control,
}: {
  name: keyof FormValues;
  label: string;
  description: string;
  control: any; // Type from react-hook-form
}) => (
  <FormField
    control={control}
    name={name}
    render={({ field }) => (
      // Removed border p-4, let FormSection handle grouping
      <FormItem className="flex flex-row items-start space-x-3 space-y-0 pt-2">
        <FormControl>
          <Checkbox
            checked={field.value as boolean} // Assert type
            onCheckedChange={field.onChange}
            id={name} // Add id for label association
          />
        </FormControl>
        <div className="space-y-1 leading-none">
          <FormLabel htmlFor={name} className="cursor-pointer">
            {label}
          </FormLabel>
          <FormDescription>{description}</FormDescription>
          <FormMessage />
        </div>
      </FormItem>
    )}
  />
);

export function AmountOffOrderForm({
  defaultValues,
  onCancel,
}: AmountOffOrderFormProps) {
  const { toast } = useToast();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      code: "",
      valueType: "percentage",
      discountValue: 10,
      minPurchaseAmount: null,
      maxUsesPerOrder: 1, // Default to 1 for amount off order often makes sense
      maxUses: null,
      limitOnePerCustomer: true, // Default to true often makes sense
      combineWithProductDiscounts: false, // Default to false often safer
      combineWithShippingDiscounts: true, // Typically allowed
      startDate: new Date(new Date().setHours(0, 0, 0, 0)), // Start of today
      endDate: null,
      isActive: true,
      ...defaultValues,
      // Ensure Date objects are used, handling string conversion
      ...(defaultValues?.startDate && {
        startDate:
          typeof defaultValues.startDate === "string"
            ? new Date(defaultValues.startDate)
            : defaultValues.startDate,
      }),
      ...(defaultValues?.endDate && {
        endDate:
          typeof defaultValues.endDate === "string" && defaultValues.endDate
            ? new Date(defaultValues.endDate)
            : defaultValues.endDate,
      }),
      // Coerce potentially stringified numbers from defaultValues if needed
      ...(defaultValues?.discountValue && {
        discountValue: Number(defaultValues.discountValue),
      }),
      ...(defaultValues?.minPurchaseAmount && {
        minPurchaseAmount: Number(defaultValues.minPurchaseAmount),
      }),
      ...(defaultValues?.maxUsesPerOrder && {
        maxUsesPerOrder: Number(defaultValues.maxUsesPerOrder),
      }),
      ...(defaultValues?.maxUses && {
        maxUses: Number(defaultValues.maxUses),
      }),
    },
  });

  // --- Submit Handler (Unchanged Logic, added type) ---
  const internalHandleSubmit = async (values: FormValues) => {
    setIsSubmitting(true);
    const discountId = defaultValues?.id;

    // Ensure values are correctly formatted for API (especially nullables)
    const payload = {
      ...values,
      type: "amount_off_order",
      // Ensure empty strings for optional numbers become null
      minPurchaseAmount: values.minPurchaseAmount || null,
      maxUsesPerOrder: values.maxUsesPerOrder || null,
      maxUses: values.maxUses || null,
      // Convert dates to ISO strings for JSON
      startDate: values.startDate.toISOString(),
      endDate: values.endDate ? values.endDate.toISOString() : null,
    };

    try {
      const method = discountId ? "PUT" : "POST";
      const url = discountId
        ? `/api/discounts/${discountId}`
        : "/api/discounts";

      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const responseData = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(
          responseData?.error ||
            `Failed to ${discountId ? "update" : "create"} discount (Status: ${response.status})`,
        );
      }

      toast({
        title: `Success!`,
        description: `Discount "${values.code}" ${discountId ? "updated" : "created"} successfully.`,
      });
      // Redirect or call a success handler instead of hard reload
      // Example: navigate to the list page
      window.location.href = "/admin/discounts";
      // Or if using a router: router.push('/admin/discounts');
    } catch (error) {
      const action = defaultValues?.id ? "updating" : "creating";
      console.error(`Error ${action} Amount Off Order discount:`, error);
      toast({
        title: "Operation Failed",
        description:
          error instanceof Error
            ? error.message
            : "An unknown error occurred while saving.",
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  // Watch valueType for conditional rendering/placeholders
  const valueType = form.watch("valueType");

  return (
    <Form {...form}>
      {/* Use form element for submit */}
      <form
        onSubmit={form.handleSubmit(internalHandleSubmit)}
        className="space-y-8"
      >
        {/* Main Card for the form */}
        <Card>
          <CardHeader>
            <CardTitle>
              {defaultValues?.id
                ? "Edit Discount"
                : "Create Amount Off Order Discount"}
            </CardTitle>
            <CardDescription>
              {defaultValues?.id
                ? `Editing discount code: ${defaultValues.code}`
                : "Apply a percentage or fixed amount discount to the entire order."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {/* Section 1: General Details */}
            <FormSection title="General Details">
              <FormField
                control={form.control}
                name="code"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Discount Code</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="e.g., SUMMER10 or SAVE500"
                        {...field}
                        // Optionally convert to uppercase
                        // onChange={(e) => field.onChange(e.target.value.toUpperCase())}
                      />
                    </FormControl>
                    <FormDescription>
                      Customers enter this code at checkout. Use letters,
                      numbers, underscores, hyphens.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-6">
                <FormField
                  control={form.control}
                  name="valueType"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Discount Type</FormLabel>
                      <Select
                        onValueChange={field.onChange}
                        defaultValue={field.value}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select type" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent className="rounded-xl bg-background">
                          <SelectItem value="percentage">
                            Percentage (%)
                          </SelectItem>
                          <SelectItem value="fixed_amount">
                            Fixed Amount (৳)
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      {/* <FormDescription>How the discount is applied.</FormDescription> */}
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="discountValue"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Discount Value</FormLabel>
                      <FormControl>
                        <div className="relative">
                          {/* Conditionally add padding based on type */}
                          <Input
                            type="number"
                            step={valueType === "percentage" ? "0.1" : "0.01"} // Allow decimals
                            placeholder={
                              valueType === "percentage" ? "10" : "500"
                            }
                            className={cn(
                              valueType === "fixed_amount" && "pl-7",
                            )}
                            {...field}
                            // Use field.value directly with coerce in schema
                          />
                          {valueType === "percentage" && (
                            <Percent className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                          )}
                          {valueType === "fixed_amount" && (
                            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground pointer-events-none">
                              ৳
                            </span>
                          )}
                        </div>
                      </FormControl>
                      {/* <FormDescription>The actual discount amount/percentage.</FormDescription> */}
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </FormSection>

            <Separator className="my-4" />

            {/* Section 2: Minimum Requirements */}
            <FormSection
              title="Minimum Requirements"
              description="Set conditions that must be met for the discount to apply."
            >
              <FormField
                control={form.control}
                name="minPurchaseAmount"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Minimum purchase amount (optional)</FormLabel>
                    <FormControl>
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground pointer-events-none">
                          ৳
                        </span>
                        <Input
                          type="number"
                          step="0.01"
                          placeholder="e.g., 1000"
                          className="pl-7"
                          {...field}
                          value={field.value ?? ""} // Handle null for empty input
                          // onChange handled by zod coerce
                        />
                      </div>
                    </FormControl>
                    <FormDescription>
                      Applies only if the order subtotal is equal or greater
                      than this amount.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {/* Removed MaxUsesPerOrder as it's typically 1 for order discounts, simplify */}
            </FormSection>

            <Separator className="my-4" />

            {/* Section 3: Usage Limits */}
            <FormSection
              title="Usage Limits"
              description="Control how many times the discount can be used."
            >
              <FormField
                control={form.control}
                name="maxUses"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Limit total number of uses (optional)</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        step="1"
                        placeholder="Unlimited"
                        {...field}
                        value={field.value ?? ""}
                        // onChange handled by zod coerce
                      />
                    </FormControl>
                    <FormDescription>
                      Maximum times this discount can be used across all orders.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <CheckboxFormItem
                control={form.control}
                name="limitOnePerCustomer"
                label="Limit to one use per customer"
                description="Track usage by customer email or ID (if logged in)."
              />
            </FormSection>

            <Separator className="my-4" />

            {/* Section 4: Combinability */}
            <FormSection
              title="Combinations"
              description="Specify if this discount can be combined with other types."
            >
              <Alert
                variant="default"
                className="bg-blue-50 border-blue-200 dark:bg-blue-900/30 dark:border-blue-700"
              >
                <Info className="h-4 w-4 text-blue-600! dark:text-blue-400!" />
                <AlertTitle className="text-blue-800 dark:text-blue-300">
                  Heads Up!
                </AlertTitle>
                <AlertDescription className="text-blue-700 dark:text-blue-300">
                  Order discounts usually apply *after* product discounts. Check
                  your calculation logic.
                </AlertDescription>
              </Alert>
              <CheckboxFormItem
                control={form.control}
                name="combineWithProductDiscounts"
                label="Combine with product discounts"
                description="Allow this order discount alongside item-specific discounts."
              />
              <CheckboxFormItem
                control={form.control}
                name="combineWithShippingDiscounts"
                label="Combine with shipping discounts"
                description="Allow this order discount alongside free or discounted shipping."
              />
            </FormSection>

            <Separator className="my-4" />

            {/* Section 5: Active Dates */}
            <FormSection
              title="Active Dates"
              description="Set the period when the discount is available."
            >
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-6">
                <FormField
                  control={form.control}
                  name="startDate"
                  render={({ field }) => (
                    <FormItem className="flex flex-col">
                      <FormLabel>Start date</FormLabel>
                      <Popover>
                        <PopoverTrigger asChild>
                          <FormControl>
                            <Button
                              variant={"outline"}
                              className={cn(
                                "pl-3 text-left font-normal justify-start", // Ensure button text aligns left
                                !field.value && "text-muted-foreground",
                              )}
                            >
                              <CalendarIcon className="mr-2 h-4 w-4 opacity-50" />
                              {field.value ? (
                                format(field.value, "PPP") // Format: Sep 10, 2023
                              ) : (
                                <span>Pick a date</span>
                              )}
                            </Button>
                          </FormControl>
                        </PopoverTrigger>
                        <PopoverContent className="w-auto p-0" align="start">
                          <Calendar
                            mode="single"
                            selected={field.value}
                            onSelect={(date) =>
                              field.onChange(date ?? new Date())
                            } // Ensure a date is always set
                            disabled={(date) =>
                              // Disable past dates, but allow today
                              date < new Date(new Date().setHours(0, 0, 0, 0))
                            }
                            initialFocus
                          />
                        </PopoverContent>
                      </Popover>
                      <FormDescription>
                        Discount is active from this date.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="endDate"
                  render={({ field }) => (
                    <FormItem className="flex flex-col">
                      <FormLabel>End date (optional)</FormLabel>
                      <Popover>
                        <PopoverTrigger asChild>
                          <FormControl>
                            <Button
                              variant={"outline"}
                              className={cn(
                                "pl-3 text-left font-normal justify-start",
                                !field.value && "text-muted-foreground",
                              )}
                            >
                              <CalendarIcon className="mr-2 h-4 w-4 opacity-50" />
                              {field.value ? (
                                format(field.value, "PPP")
                              ) : (
                                <span>No end date</span>
                              )}
                            </Button>
                          </FormControl>
                        </PopoverTrigger>
                        <PopoverContent className="w-auto p-0" align="start">
                          <div className="p-2 flex justify-end">
                            {/* Add a button to clear the date */}
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => field.onChange(null)}
                            >
                              Clear
                            </Button>
                          </div>
                          <Separator />
                          <Calendar
                            mode="single"
                            selected={
                              field.value instanceof Date &&
                              !isNaN(field.value.getTime())
                                ? field.value
                                : undefined
                            }
                            onSelect={field.onChange}
                            disabled={(date) =>
                              // Disable dates before start date
                              date < (form.getValues("startDate") || new Date())
                            }
                            initialFocus
                          />
                        </PopoverContent>
                      </Popover>
                      <FormDescription>
                        Discount expires at the end of this date.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <CheckboxFormItem
                control={form.control}
                name="isActive"
                label="Enable discount code"
                description="Make this discount available for use at checkout."
              />
            </FormSection>
          </CardContent>
          <CardFooter className="border-t px-6 py-4">
            <div className="flex w-full justify-end gap-3">
              {onCancel && (
                <Button
                  type="button" // Important: Prevent form submission
                  variant="outline"
                  onClick={onCancel}
                  disabled={isSubmitting}
                >
                  Cancel
                </Button>
              )}
              <Button
                type="submit"
                disabled={isSubmitting || !form.formState.isDirty}
              >
                {isSubmitting ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
                {isSubmitting
                  ? defaultValues?.id
                    ? "Saving..."
                    : "Creating..."
                  : defaultValues?.id
                    ? "Save Changes"
                    : "Create Discount"}
              </Button>
            </div>
          </CardFooter>
        </Card>
      </form>
    </Form>
  );
}
