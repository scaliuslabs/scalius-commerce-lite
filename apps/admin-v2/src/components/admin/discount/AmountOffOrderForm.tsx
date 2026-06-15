import React, { useState } from "react";
import { z } from "zod";
import { useForm, type Control } from "react-hook-form";
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
import { Input } from "../../ui/input";
import { Button } from "../../ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
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
import { CalendarIcon, Percent, Loader2, Info, RefreshCw } from "lucide-react";
import { Checkbox } from "../../ui/checkbox";
import { cn } from "@scalius/shared/utils";
import { formatDateShort } from "@scalius/shared/timestamps";
import { Separator } from "../../ui/separator";
import { toast } from "sonner";
import { useCreateDiscount, useUpdateDiscount } from "~/lib/api-mutations/discounts";
import { Alert, AlertDescription, AlertTitle } from "../../ui/alert";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../../ui/tooltip";
import { Badge } from "../../ui/badge";
import { useCurrency } from "~/hooks/use-currency";
import { useNavigate } from "@tanstack/react-router";
import { generateDiscountCode } from "./utils";
import { discountCodeSchema, sharedDiscountFields, refineEndDateAfterStart } from "./shared-validation";

const formSchema = refineEndDateAfterStart(
  z.object({
    code: discountCodeSchema,
    valueType: z.enum(["percentage", "fixed_amount"]),
    discountValue: z.coerce
      .number({ message: "Discount value must be a number" })
      .positive({ message: "Discount value must be positive" }),
    ...sharedDiscountFields,
    combineWithProductDiscounts: z.boolean(),
    combineWithShippingDiscounts: z.boolean(),
  }),
);

type FormValues = z.infer<typeof formSchema>;

interface AmountOffOrderFormProps {
  defaultValues?: Partial<FormValues & { id?: string }>;
  onCancel?: () => void;
}

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

const CheckboxFormItem = ({
  name,
  label,
  description,
  control,
}: {
  name: keyof FormValues;
  label: string;
  description: string;
  control: Control<FormValues>;
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
  const { symbol } = useCurrency();
  const navigate = useNavigate();
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

  const createMut = useCreateDiscount();
  const updateMut = useUpdateDiscount();

  const internalHandleSubmit = async (values: FormValues) => {
    setIsSubmitting(true);
    const discountId = defaultValues?.id;

    const payload = {
      ...values,
      type: "amount_off_order" as const,
      minPurchaseAmount: values.minPurchaseAmount || null,
      maxUsesPerOrder: values.maxUsesPerOrder || null,
      maxUses: values.maxUses || null,
      startDate: values.startDate.toISOString(),
      endDate: values.endDate ? values.endDate.toISOString() : null,
    };

    try {
      if (discountId) {
        await updateMut.mutateAsync({ id: discountId, ...payload });
      } else {
        await createMut.mutateAsync(payload);
      }
      void navigate({ to: "/admin/discounts" });
    } catch (error: unknown) {
      // Mutation hooks already show toast on error, but catch to prevent unhandled
      if (!(error instanceof Error && error.message.includes("Failed"))) {
        toast.error("Operation Failed", {
          description: error instanceof Error ? error.message : "An unknown error occurred while saving.",
        });
      }
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
                      <div className="flex gap-2">
                        <Input
                          placeholder="e.g., SUMMER10 or SAVE500"
                          {...field}
                          onChange={(e) =>
                            field.onChange(e.target.value.toUpperCase())
                          }
                          className="font-mono tracking-wider"
                        />
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                type="button"
                                variant="outline"
                                size="icon"
                                className="shrink-0"
                                onClick={() => {
                                  const code = generateDiscountCode();
                                  field.onChange(code);
                                }}
                              >
                                <RefreshCw className="h-4 w-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>Generate random code</p>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </div>
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
                            Fixed Amount ({symbol})
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
                          <Input
                            type="number"
                            step={valueType === "percentage" ? "0.1" : "0.01"}
                            placeholder={
                              valueType === "percentage" ? "10" : "500"
                            }
                            className={cn(
                              valueType === "fixed_amount" && "pl-7",
                            )}
                            {...field}
                          />
                          {valueType === "percentage" && (
                            <Percent className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                          )}
                          {valueType === "fixed_amount" && (
                            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground pointer-events-none">
                              {symbol}
                            </span>
                          )}
                        </div>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </FormSection>

            <Separator className="my-4" />

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
                          {symbol}
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
                                <span suppressHydrationWarning>
                                  {formatDateShort(field.value)}
                                </span>
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
                            autoFocus
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
                                <span suppressHydrationWarning>
                                  {formatDateShort(field.value)}
                                </span>
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
                            autoFocus
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
            <Separator className="my-4" />

            {/* Live Discount Summary */}
            <div className="rounded-lg border border-dashed bg-muted/30 p-4">
              <h3 className="text-sm font-medium mb-3">Discount Summary</h3>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <span className="text-muted-foreground">Code</span>
                <span className="font-mono font-semibold tracking-wider">
                  {form.watch("code") || "---"}
                </span>
                <span className="text-muted-foreground">Value</span>
                <span className="font-medium">
                  {valueType === "percentage"
                    ? `${form.watch("discountValue") || 0}% off entire order`
                    : `${symbol}${form.watch("discountValue") || 0} off entire order`}
                </span>
                <span className="text-muted-foreground">Min. purchase</span>
                <span className="font-medium">
                  {form.watch("minPurchaseAmount")
                    ? `${symbol}${form.watch("minPurchaseAmount")}`
                    : "None"}
                </span>
                <span className="text-muted-foreground">Usage limit</span>
                <span className="font-medium">
                  {form.watch("maxUses")
                    ? `${form.watch("maxUses")} total`
                    : "Unlimited"}
                  {form.watch("limitOnePerCustomer")
                    ? " (1 per customer)"
                    : ""}
                </span>
                <span className="text-muted-foreground">Status</span>
                <span>
                  <Badge
                    variant={form.watch("isActive") ? "default" : "outline"}
                    className={
                      form.watch("isActive")
                        ? "bg-green-100 text-green-800 border-green-200"
                        : ""
                    }
                  >
                    {form.watch("isActive") ? "Active" : "Inactive"}
                  </Badge>
                </span>
              </div>
            </div>
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
