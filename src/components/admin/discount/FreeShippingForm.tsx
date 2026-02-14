import { useState } from "react";
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
import { Input } from "../../ui/input";
import { Button } from "../../ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../ui/card";
import { Popover, PopoverContent, PopoverTrigger } from "../../ui/popover";
import { Calendar } from "../../ui/calendar";
import { CalendarIcon, RefreshCw } from "lucide-react";
import { Checkbox } from "../../ui/checkbox";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import { Separator } from "../../ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../../ui/tooltip";
import { Badge } from "../../ui/badge";
import { useToast } from "@/hooks/use-toast";

function generateDiscountCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// Form validation schema
const formSchema = z.object({
  code: z.string().min(3).max(50),
  minPurchaseAmount: z.number().nullable().optional(),
  maxUsesPerOrder: z.number().int().positive().nullable().optional(),
  maxUses: z.number().int().positive().nullable().optional(),
  limitOnePerCustomer: z.boolean(),
  combineWithProductDiscounts: z.boolean(),
  combineWithOrderDiscounts: z.boolean(),
  startDate: z.date(),
  endDate: z.date().nullable().optional(),
  isActive: z.boolean(),
});

type FormValues = z.infer<typeof formSchema>;

interface FreeShippingFormProps {
  defaultValues?: Partial<FormValues & { id?: string }>;
}

export function FreeShippingForm({ defaultValues }: FreeShippingFormProps) {
  const { toast } = useToast();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const form = useForm<FormValues>({
    resolver: zodResolver<FormValues>(formSchema),
    defaultValues: {
      code: "",
      minPurchaseAmount: 1000, // Default minimum purchase amount for free shipping
      maxUsesPerOrder: 1,
      maxUses: null,
      limitOnePerCustomer: false,
      combineWithProductDiscounts: true,
      combineWithOrderDiscounts: true,
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
    },
  });

  // Internal submit handler
  const internalHandleSubmit = async (values: FormValues) => {
    setIsSubmitting(true);
    const discountId = defaultValues?.id;

    // Ensure startDate is valid
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

      const payload = {
        ...ensuredValues,
        type: "free_shipping",
        valueType: "free", // Always free for this type
        discountValue: 100, // Always 100 for this type
        // Pass dates directly as Date objects - API will handle conversion
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
      });
      window.location.href = "/admin/discounts";
    } catch (error) {
      const action = defaultValues?.id ? "updating" : "creating";
      console.error(`Error ${action} Free Shipping discount:`, error);
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

  const handleSubmit = form.handleSubmit(internalHandleSubmit);

  return (
    <Form {...form}>
      <form onSubmit={handleSubmit} className="space-y-8">
        <Card>
          <CardHeader>
            <CardTitle>Free Shipping</CardTitle>
            <CardDescription>
              Offer free shipping on orders that meet your criteria
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Discount Code */}
            <FormField
              control={form.control}
              name="code"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Discount Code</FormLabel>
                  <FormControl>
                    <div className="flex gap-2">
                      <Input
                        placeholder="e.g., FREESHIP"
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
                    Customers will enter this code at checkout
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <Separator />

            {/* Date Range */}
            <div className="grid gap-4 md:grid-cols-2">
              <FormField
                control={form.control}
                name="startDate"
                render={({ field }) => (
                  <FormItem className="flex flex-col">
                    <FormLabel>Start Date</FormLabel>
                    <Popover>
                      <PopoverTrigger asChild>
                        <FormControl>
                          <Button
                            variant={"outline"}
                            className={cn(
                              "pl-3 text-left font-normal",
                              !field.value && "text-muted-foreground",
                            )}
                          >
                            {field.value &&
                            !isNaN(new Date(field.value).getTime()) ? (
                              format(new Date(field.value), "PPP")
                            ) : (
                              <span>Pick a date</span>
                            )}
                            <CalendarIcon className="ml-auto h-4 w-4 opacity-50" />
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
                          }
                          disabled={(date) =>
                            date < new Date(new Date().setHours(0, 0, 0, 0))
                          }
                          initialFocus
                        />
                      </PopoverContent>
                    </Popover>
                    <FormDescription>
                      When the discount becomes available
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
                    <FormLabel>End Date</FormLabel>
                    <Popover>
                      <PopoverTrigger asChild>
                        <FormControl>
                          <Button
                            variant={"outline"}
                            className={cn(
                              "pl-3 text-left font-normal",
                              !field.value && "text-muted-foreground",
                            )}
                          >
                            {field.value &&
                            !isNaN(new Date(field.value).getTime()) ? (
                              format(new Date(field.value), "PPP")
                            ) : (
                              <span>No end date</span>
                            )}
                            <CalendarIcon className="ml-auto h-4 w-4 opacity-50" />
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
                          onSelect={field.onChange}
                          disabled={(date) =>
                            date <
                            new Date(
                              form
                                .getValues("startDate")
                                ?.setHours(0, 0, 0, 0) ||
                                new Date().setHours(0, 0, 0, 0),
                            )
                          }
                          initialFocus
                        />
                      </PopoverContent>
                    </Popover>
                    <FormDescription>
                      When the discount expires (leave empty for no expiration)
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <Separator />

            {/* Usage Limits */}
            <div className="space-y-4">
              <h3 className="text-lg font-medium">Usage Limits</h3>
              <FormField
                control={form.control}
                name="minPurchaseAmount"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Minimum Purchase Amount for Free Shipping
                    </FormLabel>
                    <FormControl>
                      <div className="relative">
                        <div className="absolute left-3 top-2.5 text-muted-foreground">
                          ৳
                        </div>
                        <Input
                          type="number"
                          className="pl-7"
                          {...field}
                          onChange={(e) =>
                            field.onChange(
                              e.target.value
                                ? parseFloat(e.target.value)
                                : null,
                            )
                          }
                          value={field.value === null ? "" : field.value}
                        />
                      </div>
                    </FormControl>
                    <FormDescription>
                      Order subtotal required for free shipping
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid gap-4 md:grid-cols-2">
                <FormField
                  control={form.control}
                  name="maxUsesPerOrder"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Max Uses Per Order</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          {...field}
                          onChange={(e) =>
                            field.onChange(
                              e.target.value ? parseInt(e.target.value) : null,
                            )
                          }
                          value={field.value === null ? "" : field.value}
                        />
                      </FormControl>
                      <FormDescription>
                        How many times this discount can be applied per order
                        (usually 1)
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="maxUses"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Max Total Uses</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          {...field}
                          onChange={(e) =>
                            field.onChange(
                              e.target.value ? parseInt(e.target.value) : null,
                            )
                          }
                          value={field.value === null ? "" : field.value}
                        />
                      </FormControl>
                      <FormDescription>
                        Maximum number of times this discount can be used across
                        all customers (optional)
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name="limitOnePerCustomer"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-start space-x-3 space-y-0 rounded-md border p-4">
                    <FormControl>
                      <Checkbox
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                    <div className="space-y-1 leading-none">
                      <FormLabel>Limit one per customer</FormLabel>
                      <FormDescription>
                        Each customer can only use this discount once
                      </FormDescription>
                    </div>
                  </FormItem>
                )}
              />
            </div>

            <Separator />

            {/* Combinability */}
            <div className="space-y-4">
              <h3 className="text-lg font-medium">Combinability</h3>
              <FormField
                control={form.control}
                name="combineWithProductDiscounts"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-start space-x-3 space-y-0 rounded-md border p-4">
                    <FormControl>
                      <Checkbox
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                    <div className="space-y-1 leading-none">
                      <FormLabel>Combine with product discounts</FormLabel>
                      <FormDescription>
                        Allow this discount to be combined with product-specific
                        discounts
                      </FormDescription>
                    </div>
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="combineWithOrderDiscounts"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-start space-x-3 space-y-0 rounded-md border p-4">
                    <FormControl>
                      <Checkbox
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                    <div className="space-y-1 leading-none">
                      <FormLabel>Combine with order discounts</FormLabel>
                      <FormDescription>
                        Allow this discount to be combined with order-level
                        discounts
                      </FormDescription>
                    </div>
                  </FormItem>
                )}
              />
            </div>

            <Separator />

            {/* Active Status */}
            <FormField
              control={form.control}
              name="isActive"
              render={({ field }) => (
                <FormItem className="flex flex-row items-start space-x-3 space-y-0 rounded-md border p-4">
                  <FormControl>
                    <Checkbox
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  </FormControl>
                  <div className="space-y-1 leading-none">
                    <FormLabel>Active</FormLabel>
                    <FormDescription>
                      Discount is active and can be used by customers
                    </FormDescription>
                  </div>
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        {/* Live Discount Summary */}
        <Card className="bg-muted/30 border-dashed">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-medium">
              Discount Summary
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <span className="text-muted-foreground">Code</span>
              <span className="font-mono font-semibold tracking-wider">
                {form.watch("code") || "---"}
              </span>
              <span className="text-muted-foreground">Type</span>
              <span className="font-medium">Free Shipping</span>
              <span className="text-muted-foreground">Min. purchase</span>
              <span className="font-medium">
                {form.watch("minPurchaseAmount")
                  ? `৳${form.watch("minPurchaseAmount")}`
                  : "None"}
              </span>
              <span className="text-muted-foreground">Usage limit</span>
              <span className="font-medium">
                {form.watch("maxUses")
                  ? `${form.watch("maxUses")} total`
                  : "Unlimited"}
                {form.watch("limitOnePerCustomer") ? " (1 per customer)" : ""}
              </span>
              <span className="text-muted-foreground">Period</span>
              <span className="font-medium">
                {form.watch("startDate")
                  ? format(form.watch("startDate")!, "MMM d, yyyy")
                  : "---"}
                {" - "}
                {form.watch("endDate")
                  ? format(form.watch("endDate")!, "MMM d, yyyy")
                  : "No end date"}
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
          </CardContent>
        </Card>

        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => window.history.back()}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting
              ? defaultValues?.id
                ? "Saving..."
                : "Creating..."
              : defaultValues?.id
                ? "Save Changes"
                : "Create Discount"}
          </Button>
        </div>
      </form>
    </Form>
  );
}
